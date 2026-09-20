/** Collaboration-conflict seam tests: record, resolve, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  ConflictError,
  DEFAULT_CONFLICT_ACTOR_REF,
  compilePlan,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  planDoctor,
  readProjectConflicts,
  readProjectReplay,
  recordConflict,
  recordDecision,
  registerActor,
  resolveConflict,
  validatePlanSchema,
  type ActorId,
  type ConflictId,
  type ConflictKind,
  type DecisionId,
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
const ITEM_A = brandString<WorkItemId>('wi:mini-dsh:DB-001')
const ITEM_B = brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001')

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
 * Call a thunk and return the ConflictError it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownConflictError(call: () => unknown): ConflictError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ConflictError)
    return error as ConflictError
  }
  expect.unreachable('expected the call to throw ConflictError')
}

describe('recordConflict', () => {
  it('records the conflict and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 11, actorRef: 'tester' })
      const conflict = recordConflict(db, {
        workItemAId: ITEM_A,
        workItemBId: ITEM_B,
        raisedByActorId: second.actorId,
        conflictKind: 'SCOPE_OVERLAP',
        description: 'Second reserved src/ while Lane held the containing tree.',
      }, { nowMs: 12, actorRef: 'tester' })
      expect(conflict).toEqual({
        conflictId: brandString<ConflictId>('cf:mini-dsh:18'),
        projectId: PROJECT,
        workItemAId: ITEM_A,
        stableKeyA: 'DB-001',
        workItemBId: ITEM_B,
        stableKeyB: 'SCHEMA-001',
        raisedByActorId: second.actorId,
        raisedByKey: 'second',
        conflictKind: 'SCOPE_OVERLAP',
        description: 'Second reserved src/ while Lane held the containing tree.',
        status: 'OPEN',
        resolutionDecisionId: undefined,
        createdAtMs: 12,
        resolvedAtMs: undefined,
      })
      const row = db.prepare(
        'SELECT id, status, resolution_decision_id, resolved_at_ms FROM collaboration_conflicts',
      ).get() as {
        id: string
        status: string
        resolution_decision_id: string | null
        resolved_at_ms: number | null
      }
      expect(row).toEqual({
        id: 'cf:mini-dsh:18',
        status: 'OPEN',
        resolution_decision_id: null,
        resolved_at_ms: null,
      })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 18').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('conflict/recorded')
      expect(event.entity_id).toBe('cf:mini-dsh:18')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        conflictId: 'cf:mini-dsh:18',
        workItemAId: ITEM_A,
        workItemBId: ITEM_B,
        raisedByActorId: second.actorId,
        conflictKind: 'SCOPE_OVERLAP',
        description: 'Second reserved src/ while Lane held the containing tree.',
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor when the caller names none', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10 })
      // No options: the defaults for the stamp and the event actor both apply.
      const conflict = recordConflict(db, {
        workItemAId: ITEM_A,
        workItemBId: ITEM_B,
        raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP',
        description: 'default-actor pass',
      })
      expect(conflict.createdAtMs).toBeGreaterThan(0)
      expect(conflict.conflictId).toEqual(brandString<ConflictId>('cf:mini-dsh:18'))
      const event = db.prepare('SELECT actor_ref FROM project_events WHERE sequence_no = 18').get() as {
        actor_ref: string
      }
      expect(event.actor_ref).toBe(DEFAULT_CONFLICT_ACTOR_REF)
    } finally {
      db.close()
    }
  })

  it('rejects bad kinds, empty accounts, shared items, and foreign referents without writing', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const at = { nowMs: 14, actorRef: 'tester' }
      expect(thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B, raisedByActorId: lane.actorId,
        conflictKind: 'ITEM_OVERLAP' as ConflictKind, description: 'd',
      }, at)).code).toBe('invalid-argument')
      expect(thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B, raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP', description: '',
      }, at)).code).toBe('invalid-argument')
      const shared = thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_A, raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP', description: 'd',
      }, at))
      expect(shared.code).toBe('invalid-argument')
      expect(shared.message).toContain('must differ')
      expect(thrownConflictError(() => recordConflict(db, {
        workItemAId: brandString<WorkItemId>('wi:mini-dsh:ghost'), workItemBId: ITEM_B,
        raisedByActorId: lane.actorId, conflictKind: 'SCOPE_OVERLAP', description: 'd',
      }, at)).code).toBe('unknown-work-item')
      expect(thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: brandString<WorkItemId>('wi:mini-dsh:ghost'),
        raisedByActorId: lane.actorId, conflictKind: 'SCOPE_OVERLAP', description: 'd',
      }, at)).code).toBe('unknown-work-item')

      // A work item of another project is no legal second side.
      db.prepare(
        'INSERT INTO work_items (id, project_id, stable_key, work_type, executor_kind, title, status, '
        + 'created_at_ms, updated_at_ms) '
        + "VALUES ('wi:other:FOREIGN', 'other', 'FOREIGN', 'IMPLEMENTATION', 'AGENT', 'Foreign item', 'READY', 1, 1)",
      ).run()
      const crossProject = thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: brandString<WorkItemId>('wi:other:FOREIGN'),
        raisedByActorId: lane.actorId, conflictKind: 'SCOPE_OVERLAP', description: 'd',
      }, at))
      expect(crossProject.code).toBe('unknown-work-item')
      expect(crossProject.message).toContain('is not recorded in project "mini-dsh"')

      expect(thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B,
        raisedByActorId: brandString<ActorId>('actor:mini-dsh:ghost'),
        conflictKind: 'SCOPE_OVERLAP', description: 'd',
      }, at)).code).toBe('unknown-actor')

      const foreignActor = registerActor(db, brandString<ProjectId>('other'), {
        actorKey: 'foreign', actorKind: 'AGENT', displayName: 'Foreign',
      }, { nowMs: 13, actorRef: 'tester' })
      const foreignError = thrownConflictError(() => recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B, raisedByActorId: foreignActor.actorId,
        conflictKind: 'SCOPE_OVERLAP', description: 'd',
      }, at))
      expect(foreignError.code).toBe('unknown-actor')
      expect(foreignError.message).toContain('not registered in project "mini-dsh"')

      expect((db.prepare('SELECT COUNT(*) AS n FROM collaboration_conflicts').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(18)
    } finally {
      db.close()
    }
  })
})

describe('resolveConflict', () => {
  it('resolves through a recorded decision and refuses a second resolution', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'overlap-ruling',
        title: 'Overlap ruling',
        question: 'Who keeps the overlapping path?',
        blockingLevel: 'BLOCKING',
        raisedBy: 'owner',
      }, { nowMs: 11, actorRef: 'tester' })
      const decision = recordDecision(db, request.requestId, {
        decidedBy: 'owner',
        decisionText: 'Lane keeps the path; Second takes the sibling directory.',
      }, { nowMs: 12, actorRef: 'tester' })
      const conflict = recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B, raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP', description: 'One reserved tree contains the other.',
      }, { nowMs: 13, actorRef: 'tester' })

      expect(thrownConflictError(() => resolveConflict(
        db,
        brandString<ConflictId>('cf:mini-dsh:ghost'),
        decision.decisionId,
      )).code).toBe('unknown-conflict')
      expect(thrownConflictError(() => resolveConflict(
        db,
        conflict.conflictId,
        brandString<DecisionId>('dc:mini-dsh:ghost'),
      )).code).toBe('unknown-decision')

      // A decision of another project answers nothing here.
      const foreignRequest = openDecisionRequest(db, brandString<ProjectId>('other'), {
        decisionKey: 'foreign-ruling',
        title: 'Foreign ruling',
        question: 'Does another project govern this one?',
        blockingLevel: 'ADVISORY',
      }, { nowMs: 22, actorRef: 'tester' })
      const foreignDecision = recordDecision(db, foreignRequest.requestId, {
        decidedBy: 'owner',
        decisionText: 'No.',
      }, { nowMs: 23, actorRef: 'tester' })
      expect(thrownConflictError(() => resolveConflict(
        db,
        conflict.conflictId,
        foreignDecision.decisionId,
      )).message).toContain('is not a recorded decision of project "mini-dsh"')

      const resolved = resolveConflict(db, conflict.conflictId, decision.decisionId, { nowMs: 20, actorRef: 'tester' })
      expect(resolved).toEqual({
        conflictId: conflict.conflictId,
        resolutionDecisionId: decision.decisionId,
        resolvedAtMs: 20,
      })
      const row = db.prepare('SELECT status, resolution_decision_id, resolved_at_ms FROM collaboration_conflicts WHERE id = ?')
        .get(conflict.conflictId) as { status: string; resolution_decision_id: string; resolved_at_ms: number }
      expect(row.status).toBe('RESOLVED')
      expect(row.resolution_decision_id).toBe(decision.decisionId)
      expect(row.resolved_at_ms).toBe(20)

      expect(thrownConflictError(() => resolveConflict(db, conflict.conflictId, decision.decisionId, { nowMs: 21 })).code)
        .toBe('conflict-not-open')
    } finally {
      db.close()
    }
  })
})

describe('readProjectConflicts', () => {
  it('lists conflicts newest-first with items, raiser, and resolution resolved', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 21, actorRef: 'tester' })
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'first-ruling',
        title: 'First ruling',
        question: 'Who keeps the path?',
        blockingLevel: 'ADVISORY',
        raisedBy: 'owner',
      }, { nowMs: 22, actorRef: 'tester' })
      const decision = recordDecision(db, request.requestId, {
        decidedBy: 'owner',
        decisionText: 'Lane keeps it.',
      }, { nowMs: 23, actorRef: 'tester' })
      const first = recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B, raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP', description: 'first recorded overlap',
      }, { nowMs: 30, actorRef: 'tester' })
      const secondConflict = recordConflict(db, {
        workItemAId: ITEM_B,
        workItemBId: brandString<WorkItemId>('wi:mini-dsh:PRE-002'),
        raisedByActorId: second.actorId,
        conflictKind: 'SCOPE_OVERLAP',
        description: 'second recorded overlap',
      }, { nowMs: 40, actorRef: 'tester' })
      resolveConflict(db, first.conflictId, decision.decisionId, { nowMs: 41, actorRef: 'tester' })

      const conflicts = readProjectConflicts(db, PROJECT)
      expect(conflicts.map(conflict => conflict.conflictId)).toEqual([
        secondConflict.conflictId,
        first.conflictId,
      ])
      expect(conflicts[0]?.stableKeyA).toBe('SCHEMA-001')
      expect(conflicts[0]?.stableKeyB).toBe('PRE-002')
      expect(conflicts[0]?.raisedByKey).toBe('second')
      expect(conflicts[0]?.status).toBe('OPEN')
      expect(conflicts[0]?.resolutionDecisionId).toBeUndefined()
      expect(conflicts[0]?.resolvedAtMs).toBeUndefined()
      expect(conflicts[1]?.status).toBe('RESOLVED')
      expect(conflicts[1]?.resolutionDecisionId).toEqual(decision.decisionId)
      expect(conflicts[1]?.resolvedAtMs).toBe(41)
      expect(readProjectConflicts(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across the conflict lifecycle', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'clean-ruling',
        title: 'Clean ruling',
        question: 'Who keeps the path?',
        blockingLevel: 'ADVISORY',
        raisedBy: 'owner',
      }, { nowMs: 21, actorRef: 'tester' })
      const decision = recordDecision(db, request.requestId, {
        decidedBy: 'owner',
        decisionText: 'Lane keeps it.',
      }, { nowMs: 22, actorRef: 'tester' })
      const conflict = recordConflict(db, {
        workItemAId: ITEM_A, workItemBId: ITEM_B, raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP', description: 'one recorded overlap',
      }, { nowMs: 23, actorRef: 'tester' })
      resolveConflict(db, conflict.conflictId, decision.decisionId, { nowMs: 24, actorRef: 'tester' })
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.conflicts).toBe(1)
        expect(audit.materialized.conflicts).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
