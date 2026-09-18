/** The work-item review read seam: one item over its criteria and latest evaluations. */

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  readWorkItemReview,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type ProjectId,
} from '../src/index.js'

/**
 * A plan whose item carries one command criterion and one owner gate, so the
 * review reads a mixed criterion list through the real compile-and-import
 * path.
 */
const REVIEW_PLAN_TEXT = `schemaVersion: 1
project:
  id: review-proj
  name: Review Proof
plan:
  id: review-plan
  name: Review Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: REVIEW-001
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the work
    priority: 10
    status: READY
    acceptance:
      - id: AC-REVIEW-A
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
      - id: AC-REVIEW-OWNER
        kind: OWNER_CONFIRMATION
        description: The owner accepts it.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm acceptance.
relations: []
`

/**
 * A plan whose second item's stable key equals the first item's full ledger
 * id, so one ref matches both rows and the review must fail loud instead of
 * picking one arbitrarily.
 */
const AMBIGUOUS_PLAN_TEXT = REVIEW_PLAN_TEXT.replace(
  'workItems:\n  - id: REVIEW-001',
  `workItems:
  - id: wi:review-proj:REVIEW-001
    phaseId: P0
    type: RESEARCH
    executorKind: AGENT
    title: Entrap the ref
    priority: 20
    status: READY
    acceptance:
      - id: AC-AMBIGUOUS-REF
        kind: TEST
        description: It traps.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
  - id: REVIEW-001`,
)

const PROJECT = brandString<ProjectId>('review-proj')

/** Import one plan text into a fresh in-memory ledger and open it. */
async function ledgerOf(planText: string): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  const { value } = parsePlanDocument(planText)
  importPlanVersion(db, compilePlan(validatePlanSchema(value), { sourceText: planText }))
  return db
}

describe('readWorkItemReview', () => {
  it('reads one item by stable key or full id with its criteria in ordinal order', async () => {
    const db = await ledgerOf(REVIEW_PLAN_TEXT)
    const byKey = readWorkItemReview(db, PROJECT, 'REVIEW-001')
    expect(byKey).toBeDefined()
    if (byKey === undefined) return
    expect(byKey.workItemId).toBe('wi:review-proj:REVIEW-001')
    expect(byKey.planVersionId).toBe('plv:review-plan:v1')
    expect(byKey.title).toBe('Do the work')
    expect(byKey.status).toBe('READY')
    expect(byKey.executorKind).toBe('AGENT')
    expect(byKey.priority).toBe(10)
    expect(byKey.criteria).toHaveLength(2)
    expect(byKey.criteria[0]).toMatchObject({
      criterionId: 'ac:wi:review-proj:REVIEW-001:AC-REVIEW-A',
      kind: 'TEST',
      required: true,
      status: 'PENDING',
      latest: null,
    })
    expect(byKey.criteria[1]).toMatchObject({ kind: 'OWNER_CONFIRMATION', latest: null })
    const byId = readWorkItemReview(db, PROJECT, 'wi:review-proj:REVIEW-001')
    expect(byId?.stableKey).toBe('REVIEW-001')
    expect(readWorkItemReview(db, PROJECT, 'NO-SUCH-ITEM')).toBeUndefined()
  })

  it('carries the latest evaluation per criterion, the newest attempt winning', async () => {
    const db = await ledgerOf(REVIEW_PLAN_TEXT)
    const criterionId = 'ac:wi:review-proj:REVIEW-001:AC-REVIEW-A'
    // Two evaluations land within the same millisecond, so the newest one
    // wins only through the exact write-order tie-break.
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(criterionId), 'PASS', {
      evaluatedBy: 'agent:first',
      observed: { exitCode: 0, outputTail: 'Tests: 3 passed' },
    })
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(criterionId), 'FAIL', {
      evaluatedBy: 'agent:second',
      observed: { exitCode: 1 },
    })
    const review = readWorkItemReview(db, PROJECT, 'REVIEW-001')
    const reviewed = review?.criteria[0]
    expect(reviewed?.status).toBe('FAILING')
    expect(reviewed?.latest).toMatchObject({
      result: 'FAIL',
      evaluatedBy: 'agent:second',
      observed: { exitCode: 1 },
    })
    expect(reviewed?.latest?.evaluatedAtMs).toBeGreaterThan(0)
  })

  it('fails loud when one ref matches two items of the project', async () => {
    const db = await ledgerOf(AMBIGUOUS_PLAN_TEXT)
    expect(() => readWorkItemReview(db, PROJECT, 'wi:review-proj:REVIEW-001'))
      .toThrow('matches 2 items of project review-proj; name the full id')
  })

  it('reviews backlog work that carries no plan version', async () => {
    const db = await ledgerOf(REVIEW_PLAN_TEXT)
    // Backlog rows have no writer yet (import always versions its items); the
    // out-of-band insert mirrors the readiness spec's backlog fixture.
    db.prepare(
      'INSERT INTO work_items '
        + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
        + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:review-proj:BACKLOG-1', 'review-proj', NULL, NULL, NULL, 'BACKLOG-1', 'RESEARCH', 'AGENT', "
        + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
    ).run()
    expect(readWorkItemReview(db, PROJECT, 'BACKLOG-1')).toMatchObject({
      workItemId: 'wi:review-proj:BACKLOG-1',
      planVersionId: null,
      stableKey: 'BACKLOG-1',
      criteria: [],
    })
  })
})
