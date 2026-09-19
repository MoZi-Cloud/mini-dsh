/** Handoff-domain seam tests: record, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_HANDOFF_ACTOR_REF,
  HandoffError,
  compilePlan,
  defineRole,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  readProjectHandoffs,
  readProjectReplay,
  registerActor,
  recordHandoff,
  validatePlanSchema,
  type ActorId,
  type HandoffId,
  type HandoffKind,
  type PlanVersionId,
  type ProjectId,
  type WorkItemId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)
const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_VERSION = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1')
const ITEM = brandString<WorkItemId>('wi:mini-dsh:DB-001')

/** Parse, validate, and compile the golden plan document. */
function compileGolden(): ReturnType<typeof compilePlan> {
  const { value } = parsePlanDocument(GOLDEN_PLAN_TEXT)
  return compilePlan(validatePlanSchema(value), { sourceText: GOLDEN_PLAN_TEXT })
}

/** Open a ledger holding the golden import (16 required events, sequences 1..16). */
async function goldenLedger(): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  importPlanVersion(db, compileGolden())
  return db
}

/**
 * Call a thunk and return the HandoffError it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownHandoffError(call: () => unknown): HandoffError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HandoffError)
    return error as HandoffError
  }
  expect.unreachable('expected the call to throw HandoffError')
}

describe('recordHandoff', () => {
  it('records the handoff and one required event atomically, serializing reference objects', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 11, actorRef: 'tester' })
      const handoff = recordHandoff(db, {
        workItemId: ITEM,
        fromActorId: lane.actorId,
        toActorId: second.actorId,
        handoffKind: 'DELEGATE',
        summary: 'Continue from the failing third criterion; the fix is in the migration step.',
        artifactRefs: { pr: 4193 },
        memoryRefs: { note: 'ho:mini-dsh:159' },
      }, { nowMs: 12, actorRef: 'tester' })
      expect(handoff).toEqual({
        handoffId: brandString<HandoffId>('ho:mini-dsh:19'),
        workItemId: ITEM,
        stableKey: 'DB-001',
        fromActorId: lane.actorId,
        fromActorKey: 'lane',
        toActorId: second.actorId,
        toActorKey: 'second',
        toRoleId: undefined,
        toRoleName: undefined,
        handoffKind: 'DELEGATE',
        summary: 'Continue from the failing third criterion; the fix is in the migration step.',
        artifactRefsJson: '{"pr":4193}',
        memoryRefsJson: '{"note":"ho:mini-dsh:159"}',
        recordedAtMs: 12,
      })
      const row = db.prepare(
        'SELECT id, to_actor_id, to_role_id, accepted_at_ms FROM handoffs',
      ).get() as { id: string; to_actor_id: string; to_role_id: string | null; accepted_at_ms: number | null }
      expect(row).toEqual({
        id: 'ho:mini-dsh:19',
        to_actor_id: second.actorId,
        to_role_id: null,
        accepted_at_ms: null,
      })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 19').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('handoff/recorded')
      expect(event.entity_id).toBe('ho:mini-dsh:19')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        handoffId: 'ho:mini-dsh:19',
        workItemId: 'wi:mini-dsh:DB-001',
        fromActorId: lane.actorId,
        toActorId: second.actorId,
        handoffKind: 'DELEGATE',
        summary: 'Continue from the failing third criterion; the fix is in the migration step.',
        artifactRefsJson: '{"pr":4193}',
        memoryRefsJson: '{"note":"ho:mini-dsh:159"}',
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor and records a role recipient with its label', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10 })
      const role = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 11 })
      const handoff = recordHandoff(db, {
        workItemId: ITEM,
        fromActorId: lane.actorId,
        toRoleId: role.roleId,
        handoffKind: 'RETURN',
        summary: 'Needs the executor role to re-run the verifier.',
      }, { nowMs: 12 })
      expect(handoff.handoffId).toEqual(brandString<HandoffId>('ho:mini-dsh:19'))
      expect(handoff.toRoleName).toBe('executor')
      expect(handoff.toActorKey).toBeUndefined()
      const event = db.prepare('SELECT actor_ref, payload_json FROM project_events WHERE sequence_no = 19').get() as {
        actor_ref: string
        payload_json: string
      }
      expect(event.actor_ref).toBe(DEFAULT_HANDOFF_ACTOR_REF)
      expect(JSON.parse(event.payload_json)).toEqual({
        handoffId: 'ho:mini-dsh:19',
        workItemId: 'wi:mini-dsh:DB-001',
        fromActorId: lane.actorId,
        toRoleId: role.roleId,
        handoffKind: 'RETURN',
        summary: 'Needs the executor role to re-run the verifier.',
      })
    } finally {
      db.close()
    }
  })

  it('rejects bad kinds, ambiguous recipients, unknown items, and foreign referents without writing', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 11, actorRef: 'tester' })
      const role = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 12, actorRef: 'tester' })
      expect(thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId, toActorId: second.actorId,
        handoffKind: 'ESCALATE' as HandoffKind, summary: 's',
      })).code).toBe('invalid-argument')
      expect(thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId, toActorId: second.actorId, toRoleId: role.roleId,
        handoffKind: 'DELEGATE', summary: 's',
      })).code).toBe('invalid-argument')
      expect(thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId,
        handoffKind: 'DELEGATE', summary: 's',
      })).code).toBe('invalid-argument')
      expect(thrownHandoffError(() => recordHandoff(db, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:ghost'),
        fromActorId: lane.actorId, toActorId: second.actorId,
        handoffKind: 'DELEGATE', summary: 's',
      })).code).toBe('unknown-work-item')
      expect(thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: brandString<ActorId>('actor:mini-dsh:ghost'),
        toActorId: second.actorId, handoffKind: 'DELEGATE', summary: 's',
      })).code).toBe('unknown-actor')

      const foreignActor = registerActor(db, brandString<ProjectId>('other'), {
        actorKey: 'foreign', actorKind: 'AGENT', displayName: 'Foreign',
      }, { nowMs: 13, actorRef: 'tester' })
      const foreignFromError = thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: foreignActor.actorId, toActorId: second.actorId,
        handoffKind: 'DELEGATE', summary: 's',
      }))
      expect(foreignFromError.code).toBe('unknown-actor')
      expect(foreignFromError.message).toContain('not registered in project "mini-dsh"')
      const foreignToError = thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId, toActorId: foreignActor.actorId,
        handoffKind: 'DELEGATE', summary: 's',
      }))
      expect(foreignToError.code).toBe('unknown-actor')

      const foreignRole = defineRole(db, brandString<ProjectId>('other'), {
        roleName: 'ops', roleKind: 'EXECUTION',
      }, { nowMs: 14, actorRef: 'tester' })
      const foreignRoleError = thrownHandoffError(() => recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId, toRoleId: foreignRole.roleId,
        handoffKind: 'DELEGATE', summary: 's',
      }))
      expect(foreignRoleError.code).toBe('unknown-role')
      expect(foreignRoleError.message).toContain('not defined for project "mini-dsh"')

      expect((db.prepare('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(21)
    } finally {
      db.close()
    }
  })
})

describe('readProjectHandoffs', () => {
  it('lists handoffs newest-first with item, sender, and recipient labels resolved', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 21, actorRef: 'tester' })
      const executorRole = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 22, actorRef: 'tester' })
      recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId, toActorId: second.actorId,
        handoffKind: 'DELEGATE', summary: 'first pass',
      }, { nowMs: 30, actorRef: 'tester' })
      recordHandoff(db, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'),
        fromActorId: second.actorId,
        toRoleId: executorRole.roleId,
        handoffKind: 'RETURN',
        summary: 'back to the executor role',
      }, { nowMs: 40, actorRef: 'tester' })

      const handoffs = readProjectHandoffs(db, PROJECT)
      expect(handoffs.map(handoff => handoff.handoffId)).toEqual([
        brandString<HandoffId>('ho:mini-dsh:21'),
        brandString<HandoffId>('ho:mini-dsh:20'),
      ])
      const returned = handoffs[0]
      expect(returned?.stableKey).toBe('SCHEMA-001')
      expect(returned?.fromActorKey).toBe('second')
      expect(returned?.toRoleName).toBe('executor')
      expect(returned?.toActorKey).toBeUndefined()
      const delegated = handoffs[1]
      expect(delegated?.toActorKey).toBe('second')
      expect(delegated?.toRoleName).toBeUndefined()
      expect(readProjectHandoffs(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across handoffs', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 21, actorRef: 'tester' })
      recordHandoff(db, {
        workItemId: ITEM, fromActorId: lane.actorId, toActorId: second.actorId,
        handoffKind: 'DELEGATE', summary: 'one pass',
      }, { nowMs: 22, actorRef: 'tester' })
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.handoffs).toBe(1)
        expect(audit.materialized.handoffs).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
