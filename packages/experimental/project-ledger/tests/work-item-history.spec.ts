/** The work-item history read seam: every recorded evaluation of one item, newest first. */

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  readWorkItemHistory,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type ProjectId,
} from '../src/index.js'

/**
 * A plan whose only item carries two observable criteria, so the history reads
 * a timeline the acceptance seam wrote across both, with re-attempts.
 */
const HISTORY_PLAN_TEXT = `schemaVersion: 1
project:
  id: hist-proj
  name: History Proof
plan:
  id: hist-plan
  name: History Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: AGENT-HIST
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the recorded work
    priority: 10
    status: READY
    acceptance:
      - id: AC-HIST-A
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
      - id: AC-HIST-B
        kind: TEST
        description: It also lints.
        required: true
        verifier:
          kind: TEST
          command: pnpm lint
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations: []
`

const PROJECT = brandString<ProjectId>('hist-proj')
const CRITERION_A = 'ac:wi:hist-proj:AGENT-HIST:AC-HIST-A'
const CRITERION_B = 'ac:wi:hist-proj:AGENT-HIST:AC-HIST-B'

/** Import the history plan into a fresh in-memory ledger and open it. */
async function ledgerOf(): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  const { value } = parsePlanDocument(HISTORY_PLAN_TEXT)
  importPlanVersion(db, compilePlan(validatePlanSchema(value), { sourceText: HISTORY_PLAN_TEXT }))
  return db
}

describe('readWorkItemHistory', () => {
  it('lists every recorded attempt newest-first with kind and observed payload', async () => {
    const db = await ledgerOf()
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(CRITERION_A), 'FAIL', {
      evaluatedBy: 'spec-worker',
      nowMs: 1_000,
      observed: { exitCode: 1, outputTail: 'first attempt failed' },
    })
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(CRITERION_B), 'WAIVED', {
      evaluatedBy: 'owner',
      nowMs: 2_000,
    })
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(CRITERION_A), 'PASS', {
      evaluatedBy: 'spec-worker',
      nowMs: 3_000,
      observed: { exitCode: 0, outputTail: 'second attempt passed' },
    })
    expect(readWorkItemHistory(db, PROJECT, 'AGENT-HIST')).toEqual({
      workItemId: brandString('wi:hist-proj:AGENT-HIST'),
      planVersionId: brandString('plv:hist-plan:v1'),
      stableKey: 'AGENT-HIST',
      title: 'Do the recorded work',
      status: 'READY',
      executorKind: 'AGENT',
      priority: 10,
      evaluations: [
        {
          evaluationId: brandString(`ev:${CRITERION_A}:5`),
          criterionId: brandString(CRITERION_A),
          kind: 'TEST',
          result: 'PASS',
          evaluatedBy: 'spec-worker',
          evaluatedAtMs: 3_000,
          observed: { exitCode: 0, outputTail: 'second attempt passed' },
        },
        {
          evaluationId: brandString(`ev:${CRITERION_B}:4`),
          criterionId: brandString(CRITERION_B),
          kind: 'TEST',
          result: 'WAIVED',
          evaluatedBy: 'owner',
          evaluatedAtMs: 2_000,
          observed: null,
        },
        {
          evaluationId: brandString(`ev:${CRITERION_A}:3`),
          criterionId: brandString(CRITERION_A),
          kind: 'TEST',
          result: 'FAIL',
          evaluatedBy: 'spec-worker',
          evaluatedAtMs: 1_000,
          observed: { exitCode: 1, outputTail: 'first attempt failed' },
        },
      ],
    })
  })

  it('reads an empty timeline before any evaluation', async () => {
    const db = await ledgerOf()
    expect(readWorkItemHistory(db, PROJECT, 'wi:hist-proj:AGENT-HIST')).toMatchObject({
      stableKey: 'AGENT-HIST',
      evaluations: [],
    })
  })

  it('returns undefined for an unknown ref and throws on an ambiguous one', async () => {
    const db = await ledgerOf()
    expect(readWorkItemHistory(db, PROJECT, 'NO-SUCH')).toBeUndefined()
    // A backlog row whose stable key equals another item's full ledger id
    // makes the ref ambiguous; the out-of-band insert mirrors the review
    // spec's fixture.
    db.prepare(
      'INSERT INTO work_items '
        + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
        + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:hist-proj:ALIAS', 'hist-proj', NULL, NULL, NULL, 'wi:hist-proj:AGENT-HIST', 'RESEARCH', 'AGENT', "
        + "'Aliased work', NULL, 0, 'READY', 0, 1, 1)",
    ).run()
    expect(() => readWorkItemHistory(db, PROJECT, 'wi:hist-proj:AGENT-HIST')).toThrow(
      'work item ref "wi:hist-proj:AGENT-HIST" matches 2 items of project hist-proj; name the full id',
    )
  })
})
