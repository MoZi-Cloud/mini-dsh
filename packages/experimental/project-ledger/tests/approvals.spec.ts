/** Approval-domain seam tests: request, decide, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  ApprovalError,
  DEFAULT_APPROVAL_ACTOR_REF,
  compilePlan,
  decideApproval,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  planDoctor,
  readProjectApprovals,
  readProjectReplay,
  recordDecision,
  requestApproval,
  validatePlanSchema,
  type ApprovalId,
  type CompiledPlan,
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
const GOLDEN_ITEM = brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001')

/** Parse, validate, and compile the golden plan document. */
function compileGolden(): CompiledPlan {
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
 * Call a thunk and return the ApprovalError it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownApprovalError(call: () => unknown): ApprovalError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApprovalError)
    return error as ApprovalError
  }
  expect.unreachable('expected the call to throw ApprovalError')
}

describe('requestApproval', () => {
  it('records the approval and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const approval = requestApproval(db, PROJECT, {
        subjectType: 'plan-version',
        subjectId: GOLDEN_VERSION,
        requiredRole: 'owner',
        requestedBy: 'tester',
      }, { nowMs: 100, actorRef: 'tester' })
      expect(approval).toEqual({
        approvalId: brandString<ApprovalId>('ap:mini-dsh:17'),
        projectId: PROJECT,
        subjectType: 'plan-version',
        subjectId: GOLDEN_VERSION,
        requiredRole: 'owner',
        requestedBy: 'tester',
        status: 'PENDING',
        decision: undefined,
        requestedAtMs: 100,
      })
      const row = db.prepare('SELECT id, status, requested_at_ms FROM approvals').get() as {
        id: string
        status: string
        requested_at_ms: number
      }
      expect(row).toEqual({ id: 'ap:mini-dsh:17', status: 'PENDING', requested_at_ms: 100 })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 17').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('approval/requested')
      expect(event.entity_id).toBe('ap:mini-dsh:17')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        approvalId: 'ap:mini-dsh:17',
        subjectType: 'plan-version',
        subjectId: GOLDEN_VERSION,
        requiredRole: 'owner',
        requestedBy: 'tester',
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor on the event and works over work-item and decision subjects', async () => {
    const db = await goldenLedger()
    try {
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'subject-source', title: 'T', question: 'Q?', blockingLevel: 'ADVISORY',
      }, { nowMs: 10, actorRef: 'tester' })
      const decision = recordDecision(db, request.requestId, {
        decidedBy: 'owner', decisionText: 'recorded',
      }, { nowMs: 11, actorRef: 'tester' })
      const overItem = requestApproval(db, PROJECT, {
        subjectType: 'work-item', subjectId: GOLDEN_ITEM,
      }, { nowMs: 12 })
      const overDecision = requestApproval(db, PROJECT, {
        subjectType: 'decision', subjectId: decision.decisionId,
      }, { nowMs: 13 })
      expect(overItem.approvalId).toBe('ap:mini-dsh:19')
      expect(overDecision.approvalId).toBe('ap:mini-dsh:20')
      const events = db.prepare(
        "SELECT actor_ref FROM project_events WHERE event_type = 'approval/requested'",
      ).all() as { actor_ref: string }[]
      expect(events.map(row => row.actor_ref)).toEqual([
        DEFAULT_APPROVAL_ACTOR_REF,
        DEFAULT_APPROVAL_ACTOR_REF,
      ])
    } finally {
      db.close()
    }
  })

  it('rejects empty optional fields without writing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownApprovalError(() => requestApproval(db, PROJECT, {
        subjectType: 'plan-version', subjectId: GOLDEN_VERSION, requiredRole: '',
      })).code).toBe('invalid-argument')
      expect(thrownApprovalError(() => requestApproval(db, PROJECT, {
        subjectType: 'plan-version', subjectId: GOLDEN_VERSION, requestedBy: '',
      })).code).toBe('invalid-argument')
      expect(thrownApprovalError(() => requestApproval(db, PROJECT, {
        subjectType: 'plan-version', subjectId: '',
      })).code).toBe('invalid-argument')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)
    } finally {
      db.close()
    }
  })

  it('rejects a subject this project does not record, of any subject kind', async () => {
    const db = await goldenLedger()
    try {
      for (const subjectType of ['plan-version', 'work-item', 'decision'] as const) {
        const rejection = thrownApprovalError(() => requestApproval(db, PROJECT, {
          subjectType, subjectId: `ghost-of-${subjectType}`,
        }))
        expect(rejection.code).toBe('unknown-approval-subject')
        expect(rejection.message).toContain('ghost-of')
      }
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)
    } finally {
      db.close()
    }
  })
})

describe('decideApproval', () => {
  it('answers the approval exactly once with the deciding note', async () => {
    const db = await goldenLedger()
    try {
      const approval = requestApproval(db, PROJECT, {
        subjectType: 'work-item', subjectId: GOLDEN_ITEM, requestedBy: 'tester',
      }, { nowMs: 10, actorRef: 'tester' })
      const decided = decideApproval(db, approval.approvalId, {
        outcome: 'REJECTED', decidedBy: 'owner', decisionText: 'Not yet; the §33 bar has not been met.',
      }, { nowMs: 11, actorRef: 'tester' })
      expect(decided).toEqual({
        approvalId: approval.approvalId,
        projectId: PROJECT,
        subjectType: 'work-item',
        subjectId: GOLDEN_ITEM,
        requiredRole: undefined,
        requestedBy: 'tester',
        status: 'REJECTED',
        decision: {
          decidedBy: 'owner',
          decisionText: 'Not yet; the §33 bar has not been met.',
          decidedAtMs: 11,
        },
        requestedAtMs: 10,
      })
      const row = db.prepare('SELECT status, decision_text, decided_by, decided_at_ms FROM approvals').get() as {
        status: string
        decision_text: string
        decided_by: string
        decided_at_ms: number
      }
      expect(row).toEqual({
        status: 'REJECTED',
        decision_text: 'Not yet; the §33 bar has not been met.',
        decided_by: 'owner',
        decided_at_ms: 11,
      })
      const event = db.prepare('SELECT event_type, payload_json FROM project_events WHERE sequence_no = 18').get() as {
        event_type: string
        payload_json: string
      }
      expect(event.event_type).toBe('approval/decided')
      expect(JSON.parse(event.payload_json)).toEqual({
        approvalId: approval.approvalId,
        outcome: 'REJECTED',
        decidedBy: 'owner',
        decisionText: 'Not yet; the §33 bar has not been met.',
        decidedAtMs: 11,
      })
    } finally {
      db.close()
    }
  })

  it('rejects unknown approvals, decided approvals, invalid outcomes, and empty fields, writing nothing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownApprovalError(() => decideApproval(db, brandString<ApprovalId>('ap:mini-dsh:ghost'), {
        outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'x',
      })).code).toBe('unknown-approval')

      const approval = requestApproval(db, PROJECT, {
        subjectType: 'plan-version', subjectId: GOLDEN_VERSION,
      }, { nowMs: 10, actorRef: 'tester' })
      expect(thrownApprovalError(() => decideApproval(db, approval.approvalId, {
        outcome: 'MAYBE' as 'APPROVED', decidedBy: 'owner', decisionText: 'x',
      })).code).toBe('invalid-argument')
      expect(thrownApprovalError(() => decideApproval(db, approval.approvalId, {
        outcome: 'APPROVED', decidedBy: '', decisionText: 'x',
      })).code).toBe('invalid-argument')
      expect(thrownApprovalError(() => decideApproval(db, approval.approvalId, {
        outcome: 'APPROVED', decidedBy: 'owner', decisionText: '',
      })).code).toBe('invalid-argument')
      expect((db.prepare('SELECT status FROM approvals').get() as { status: string }).status).toBe('PENDING')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(17)

      decideApproval(db, approval.approvalId, {
        outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'approved',
      }, { nowMs: 11, actorRef: 'tester' })
      expect(thrownApprovalError(() => decideApproval(db, approval.approvalId, {
        outcome: 'REJECTED', decidedBy: 'owner', decisionText: 'again',
      })).code).toBe('approval-decided')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(18)
    } finally {
      db.close()
    }
  })
})

describe('readProjectApprovals', () => {
  it('lists approvals newest-first with their deciding notes', async () => {
    const db = await goldenLedger()
    try {
      const first = requestApproval(db, PROJECT, {
        subjectType: 'plan-version', subjectId: GOLDEN_VERSION, requestedBy: 'tester',
      }, { nowMs: 20, actorRef: 'tester' })
      decideApproval(db, first.approvalId, {
        outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'first: approved',
      }, { nowMs: 21, actorRef: 'tester' })
      requestApproval(db, PROJECT, {
        subjectType: 'work-item', subjectId: GOLDEN_ITEM, requiredRole: 'reviewer',
      }, { nowMs: 30, actorRef: 'tester' })

      const approvals = readProjectApprovals(db, PROJECT)
      expect(approvals.map(approval => approval.approvalId)).toEqual(['ap:mini-dsh:19', first.approvalId])
      const pending = approvals[0]
      expect(pending?.status).toBe('PENDING')
      expect(pending?.decision).toBeUndefined()
      expect(pending?.requiredRole).toBe('reviewer')
      expect(pending?.requestedBy).toBeUndefined()
      const decided = approvals[1]
      expect(decided?.status).toBe('APPROVED')
      expect(decided?.decision?.decidedAtMs).toBe(21)
      expect(decided?.decision?.decisionText).toBe('first: approved')
      expect(readProjectApprovals(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across a full approval loop', async () => {
    const db = await goldenLedger()
    try {
      const approval = requestApproval(db, PROJECT, {
        subjectType: 'plan-version', subjectId: GOLDEN_VERSION, requestedBy: 'tester',
      }, { nowMs: 20, actorRef: 'tester' })
      decideApproval(db, approval.approvalId, {
        outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'parity: approved',
      }, { nowMs: 21, actorRef: 'tester' })
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.approvals).toBe(1)
        expect(audit.materialized.approvals).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
