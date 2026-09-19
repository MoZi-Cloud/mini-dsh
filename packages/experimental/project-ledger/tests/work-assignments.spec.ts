/** Work-assignment-domain seam tests: assign, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_WORK_ASSIGNMENT_ACTOR_REF,
  WorkAssignmentError,
  assignWorkItem,
  compilePlan,
  defineRole,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  readProjectReplay,
  readProjectWorkAssignments,
  registerActor,
  validatePlanSchema,
  type ActorId,
  type PlanVersionId,
  type ProjectId,
  type WorkAssignmentId,
  type WorkAssignmentKind,
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
 * Call a thunk and return the WorkAssignmentError it threw; any other
 * outcome fails the test through the instance assertion or the unreachable
 * marker.
 */
function thrownAssignmentError(call: () => unknown): WorkAssignmentError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkAssignmentError)
    return error as WorkAssignmentError
  }
  expect.unreachable('expected the call to throw WorkAssignmentError')
}

describe('assignWorkItem', () => {
  it('records the assignment and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const actor = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const assignment = assignWorkItem(db, {
        workItemId: ITEM,
        actorId: actor.actorId,
        assignmentKind: 'PRIMARY',
      }, { nowMs: 12, actorRef: 'tester' })
      expect(assignment).toEqual({
        assignmentId: brandString<WorkAssignmentId>('wa:mini-dsh:18'),
        workItemId: ITEM,
        stableKey: 'DB-001',
        actorId: actor.actorId,
        actorKey: 'lane',
        roleId: undefined,
        roleName: undefined,
        assignmentKind: 'PRIMARY',
        status: 'ACTIVE',
        assignedAtMs: 12,
      })
      const row = db.prepare('SELECT id, status, assigned_at_ms, accepted_at_ms FROM work_assignments').get() as {
        id: string
        status: string
        assigned_at_ms: number
        accepted_at_ms: number | null
      }
      expect(row).toEqual({ id: 'wa:mini-dsh:18', status: 'ACTIVE', assigned_at_ms: 12, accepted_at_ms: null })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 18').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('work/assigned')
      expect(event.entity_id).toBe('wa:mini-dsh:18')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        assignmentId: 'wa:mini-dsh:18',
        workItemId: 'wi:mini-dsh:DB-001',
        actorId: actor.actorId,
        assignmentKind: 'PRIMARY',
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor and records a named role with its label', async () => {
    const db = await goldenLedger()
    try {
      const actor = registerActor(db, PROJECT, {
        actorKey: 'reviewer', actorKind: 'HUMAN', displayName: 'Reviewer',
      }, { nowMs: 10 })
      const role = defineRole(db, PROJECT, { roleName: 'owner', roleKind: 'GOVERNANCE' }, { nowMs: 11 })
      const assignment = assignWorkItem(db, {
        workItemId: ITEM,
        actorId: actor.actorId,
        assignmentKind: 'REVIEWER',
        roleId: role.roleId,
      }, { nowMs: 12 })
      expect(assignment.assignmentId).toEqual(brandString<WorkAssignmentId>('wa:mini-dsh:19'))
      expect(assignment.roleName).toBe('owner')
      const event = db.prepare('SELECT actor_ref, payload_json FROM project_events WHERE sequence_no = 19').get() as {
        actor_ref: string
        payload_json: string
      }
      expect(event.actor_ref).toBe(DEFAULT_WORK_ASSIGNMENT_ACTOR_REF)
      expect(JSON.parse(event.payload_json)).toEqual({
        assignmentId: 'wa:mini-dsh:19',
        workItemId: 'wi:mini-dsh:DB-001',
        actorId: actor.actorId,
        roleId: role.roleId,
        assignmentKind: 'REVIEWER',
      })
    } finally {
      db.close()
    }
  })

  it('rejects bad kinds, unknown items, foreign actors, foreign roles, and a second live PRIMARY without writing', async () => {
    const db = await goldenLedger()
    try {
      const actor = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const role = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 11, actorRef: 'tester' })
      expect(thrownAssignmentError(() => assignWorkItem(db, {
        workItemId: ITEM, actorId: actor.actorId, assignmentKind: 'LEAD' as WorkAssignmentKind,
      })).code).toBe('invalid-argument')
      expect(thrownAssignmentError(() => assignWorkItem(db, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:ghost'),
        actorId: actor.actorId, assignmentKind: 'PRIMARY',
      })).code).toBe('unknown-work-item')
      expect(thrownAssignmentError(() => assignWorkItem(db, {
        workItemId: ITEM,
        actorId: brandString<ActorId>('actor:mini-dsh:ghost'),
        assignmentKind: 'PRIMARY',
      })).code).toBe('unknown-actor')

      const foreignActor = registerActor(db, brandString<ProjectId>('other'), {
        actorKey: 'foreign', actorKind: 'AGENT', displayName: 'Foreign',
      }, { nowMs: 12, actorRef: 'tester' })
      const foreignActorError = thrownAssignmentError(() => assignWorkItem(db, {
        workItemId: ITEM, actorId: foreignActor.actorId, assignmentKind: 'PRIMARY',
      }))
      expect(foreignActorError.code).toBe('unknown-actor')
      expect(foreignActorError.message).toContain('not registered in project "mini-dsh"')

      const foreignRole = defineRole(db, brandString<ProjectId>('other'), {
        roleName: 'ops', roleKind: 'EXECUTION',
      }, { nowMs: 13, actorRef: 'tester' })
      const foreignRoleError = thrownAssignmentError(() => assignWorkItem(db, {
        workItemId: ITEM, actorId: actor.actorId, assignmentKind: 'REVIEWER', roleId: foreignRole.roleId,
      }))
      expect(foreignRoleError.code).toBe('unknown-role')
      expect(foreignRoleError.message).toContain('not defined for project "mini-dsh"')

      assignWorkItem(db, { workItemId: ITEM, actorId: actor.actorId, assignmentKind: 'PRIMARY', roleId: role.roleId },
        { nowMs: 14, actorRef: 'tester' })
      const secondActor = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 15, actorRef: 'tester' })
      const duplicate = thrownAssignmentError(() => assignWorkItem(db, {
        workItemId: ITEM, actorId: secondActor.actorId, assignmentKind: 'PRIMARY',
      }, { nowMs: 16, actorRef: 'tester' }))
      expect(duplicate.code).toBe('duplicate-assignment')
      expect(duplicate.message).toContain('already holds a live PRIMARY assignment')
      expect((db.prepare('SELECT COUNT(*) AS n FROM work_assignments').get() as { n: number }).n).toBe(1)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(22)
    } finally {
      db.close()
    }
  })
})

describe('readProjectWorkAssignments', () => {
  it('lists assignments newest-first with item, actor, and role labels resolved', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      const owner = registerActor(db, PROJECT, {
        actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
      }, { nowMs: 21, actorRef: 'tester' })
      const executorRole = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 22, actorRef: 'tester' })
      assignWorkItem(db, {
        workItemId: ITEM, actorId: lane.actorId, assignmentKind: 'PRIMARY', roleId: executorRole.roleId,
      }, { nowMs: 30, actorRef: 'tester' })
      assignWorkItem(db, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'),
        actorId: owner.actorId,
        assignmentKind: 'ACCOUNTABLE',
      }, { nowMs: 40, actorRef: 'tester' })

      const assignments = readProjectWorkAssignments(db, PROJECT)
      expect(assignments.map(assignment => assignment.assignmentId)).toEqual([
        brandString<WorkAssignmentId>('wa:mini-dsh:21'),
        brandString<WorkAssignmentId>('wa:mini-dsh:20'),
      ])
      const accountable = assignments[0]
      expect(accountable?.actorKey).toBe('owner')
      expect(accountable?.stableKey).toBe('SCHEMA-001')
      expect(accountable?.roleName).toBeUndefined()
      expect(accountable?.roleId).toBeUndefined()
      const primary = assignments[1]
      expect(primary?.assignmentKind).toBe('PRIMARY')
      expect(primary?.roleName).toBe('executor')
      expect(readProjectWorkAssignments(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across assignments', async () => {
    const db = await goldenLedger()
    try {
      const actor = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      assignWorkItem(db, {
        workItemId: ITEM, actorId: actor.actorId, assignmentKind: 'PRIMARY',
      }, { nowMs: 21, actorRef: 'tester' })
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.workAssignments).toBe(1)
        expect(audit.materialized.workAssignments).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
