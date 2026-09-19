/** The owner evidence digest read seam: plan versions, item completion with latest verdicts, and the embedded replay verdict. */

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  readProjectDigest,
  supersedePlanVersion,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type PlanId,
  type PlanVersionId,
  type ProjectId,
  type WorkItemId,
} from '../src/index.js'

/**
 * Version 1 of the digest proof plan: one phased, claimable item whose single
 * criterion a real evaluation passes, so the digest reads a project every
 * versioning and acceptance writer has touched through its real seams.
 */
const V1_TEXT = `schemaVersion: 1
project:
  id: digest-proj
  name: Digest Proof
plan:
  id: digest-plan
  name: Digest Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: FIRST
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Land the first thing
    priority: 10
    status: READY
    acceptance:
      - id: AC-FIRST
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations: []
`

/** Version 2 of the same plan: a pinned baseline and one fresh item, the superseding-batch shape. */
const V2_TEXT = `schemaVersion: 1
project:
  id: digest-proj
  name: Digest Proof
plan:
  id: digest-plan
  name: Digest Proof Plan
  version: 2
  baseline:
    repoHead: repo-head-v2
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: SECOND
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Land the second thing
    priority: 20
    status: READY
    acceptance:
      - id: AC-SECOND
        kind: TEST
        description: It also works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations: []
`

/** A one-item plan with two observable criteria, so one item's bucket holds two latest verdicts. */
const DUAL_TEXT = `schemaVersion: 1
project:
  id: digest-proj
  name: Digest Proof
plan:
  id: digest-plan
  name: Digest Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: DUAL
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Land the two-criterion thing
    priority: 10
    status: READY
    acceptance:
      - id: AC-DUAL-A
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
      - id: AC-DUAL-B
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

const PROJECT = brandString<ProjectId>('digest-proj')

/** Compile one plan text into the canonical IR. */
function compiledOf(text: string): ReturnType<typeof compilePlan> {
  const { value } = parsePlanDocument(text)
  return compilePlan(validatePlanSchema(value), { sourceText: text })
}

/** Import one compiled plan and activate its version the way the pinned fixtures do. */
async function activeLedgerOf(text: string, nowMs: number): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  const { planVersionId } = importPlanVersion(db, compiledOf(text), { nowMs })
  // Activation is an owner seam without an exported writer (v1.6a §5); the
  // spec sets it the way the pinned-fixture generator does. The fold projects
  // no version status, so the raw activation never drifts.
  db.prepare("UPDATE plan_versions SET status = 'ACTIVE', activated_at_ms = ? WHERE id = ?").run(nowMs, planVersionId)
  return db
}

describe('readProjectDigest', () => {
  it('digests a two-version project through the real writers', async () => {
    const db = await activeLedgerOf(V1_TEXT, 1_000)
    const v1 = db.prepare('SELECT id FROM plan_versions WHERE plan_id = ? AND version_no = 1').get('digest-plan') as { id: string }
    // Naming the current version is an owner seam without an exported writer
    // (v1.6a §5); the raw pointer lets the real supersede writer repoint it.
    db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run(v1.id, 'digest-plan')
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:digest-proj:FIRST:AC-FIRST'),
      'PASS',
      { evaluatedBy: 'spec-worker', nowMs: 1_200 },
    )
    const v2 = importPlanVersion(db, compiledOf(V2_TEXT), { nowMs: 2_000 })
    supersedePlanVersion(db, brandString<PlanVersionId>(v1.id), { succeededBy: v2.planVersionId, nowMs: 2_100 })
    db.prepare("UPDATE plan_versions SET status = 'ACTIVE', activated_at_ms = ? WHERE id = ?").run(2_200, v2.planVersionId)

    const digest = readProjectDigest(db, PROJECT)
    expect(digest.plans).toEqual([{
      planId: brandString<PlanId>('digest-plan'),
      planName: 'Digest Proof Plan',
      currentVersionId: v2.planVersionId,
      versions: [
        {
          versionId: brandString<PlanVersionId>(v1.id),
          versionNo: 1,
          status: 'SUPERSEDED',
          baselineRepoHead: null,
          createdAtMs: 1_000,
          activatedAtMs: 1_000,
          supersededAtMs: 2_100,
        },
        {
          versionId: v2.planVersionId,
          versionNo: 2,
          status: 'ACTIVE',
          baselineRepoHead: 'repo-head-v2',
          createdAtMs: 2_000,
          activatedAtMs: 2_200,
          supersededAtMs: null,
        },
      ],
    }])
    expect(digest.items).toEqual([
      {
        workItemId: brandString<WorkItemId>('wi:digest-proj:FIRST'),
        stableKey: 'FIRST',
        title: 'Land the first thing',
        status: 'READY',
        executorKind: 'AGENT',
        priority: 10,
        planVersionId: brandString<PlanVersionId>(v1.id),
        criteria: [{
          criterionId: brandString<AcceptanceCriterionId>('ac:wi:digest-proj:FIRST:AC-FIRST'),
          kind: 'TEST',
          description: 'It works.',
          required: true,
          status: 'PASSING',
          latest: { result: 'PASS', evaluatedBy: 'spec-worker', evaluatedAtMs: 1_200, observed: null },
        }],
        lastEvaluatedAtMs: 1_200,
      },
      {
        workItemId: brandString<WorkItemId>('wi:digest-proj:SECOND'),
        stableKey: 'SECOND',
        title: 'Land the second thing',
        status: 'READY',
        executorKind: 'AGENT',
        priority: 20,
        planVersionId: v2.planVersionId,
        criteria: [{
          criterionId: brandString<AcceptanceCriterionId>('ac:wi:digest-proj:SECOND:AC-SECOND'),
          kind: 'TEST',
          description: 'It also works.',
          required: true,
          status: 'PENDING',
          latest: null,
        }],
        lastEvaluatedAtMs: null,
      },
    ])
    expect(digest.replay).toMatchObject({ outcome: 'compared', drift: [] })
  })

  it('digests rows the writers never produced and carries the drift they cause', async () => {
    const db = await activeLedgerOf(V1_TEXT, 1_000)
    // A plans row without versions and a backlog item without a plan version
    // have no writers yet; the out-of-band inserts mirror the readiness and
    // replay specs' fixtures.
    db.prepare(
      'INSERT INTO plans (id, project_id, name, current_version_id, created_at_ms) '
        + "VALUES ('side-plan', 'digest-proj', 'Side Plan', NULL, 1)",
    ).run()
    db.prepare(
      'INSERT INTO work_items '
        + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
        + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:digest-proj:BACKLOG-1', 'digest-proj', NULL, NULL, NULL, 'BACKLOG-1', 'RESEARCH', 'AGENT', "
        + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
    ).run()

    const digest = readProjectDigest(db, PROJECT)
    expect(digest.plans).toEqual([
      {
        planId: brandString<PlanId>('digest-plan'),
        planName: 'Digest Proof Plan',
        currentVersionId: null,
        versions: [{
          versionId: brandString<PlanVersionId>('plv:digest-plan:v1'),
          versionNo: 1,
          status: 'ACTIVE',
          baselineRepoHead: null,
          createdAtMs: 1_000,
          activatedAtMs: 1_000,
          supersededAtMs: null,
        }],
      },
      { planId: brandString<PlanId>('side-plan'), planName: 'Side Plan', currentVersionId: null, versions: [] },
    ])
    expect(digest.items.map(item => [
      item.stableKey,
      item.planVersionId,
      item.criteria.map(criterion => [criterion.status, criterion.latest?.result ?? null]),
      item.lastEvaluatedAtMs,
    ])).toEqual([
      ['BACKLOG-1', null, [], null],
      ['FIRST', brandString<PlanVersionId>('plv:digest-plan:v1'), [['PENDING', null]], null],
    ])
    expect(digest.replay).toMatchObject({ outcome: 'compared' })
    if (digest.replay.outcome !== 'compared') return
    expect(digest.replay.drift.map(finding => finding.message)).toEqual([
      'work item "wi:digest-proj:BACKLOG-1" is materialized but no work/created event replays it',
    ])
  })

  it('counts only the latest evaluation per criterion', async () => {
    const db = await activeLedgerOf(DUAL_TEXT, 1_000)
    // AC-DUAL-A fails first and passes later; AC-DUAL-B blocks between the two
    // attempts, so the newest-first latest-per-criterion stream is A@2_000
    // then B@1_500 and the failed attempt counts nowhere.
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>('ac:wi:digest-proj:DUAL:AC-DUAL-A'), 'FAIL', {
      evaluatedBy: 'spec-worker',
      nowMs: 1_000,
    })
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>('ac:wi:digest-proj:DUAL:AC-DUAL-A'), 'PASS', {
      evaluatedBy: 'spec-worker',
      nowMs: 2_000,
    })
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>('ac:wi:digest-proj:DUAL:AC-DUAL-B'), 'BLOCKED', {
      evaluatedBy: 'spec-worker',
      nowMs: 1_500,
    })

    const digest = readProjectDigest(db, PROJECT)
    expect(digest.items).toHaveLength(1)
    const [item] = digest.items
    if (item === undefined) return
    expect(item.criteria.map(criterion => [
      criterion.status,
      criterion.latest?.result,
      criterion.latest?.evaluatedAtMs,
    ])).toEqual([
      ['PASSING', 'PASS', 2_000],
      ['BLOCKED', 'BLOCKED', 1_500],
    ])
    expect(item.lastEvaluatedAtMs).toBe(2_000)
  })

  it('carries the replay verdict, an undecodable timeline included', async () => {
    const db = await activeLedgerOf(V1_TEXT, 1_000)
    db.prepare(
      'INSERT INTO project_events '
        + '(project_id, sequence_no, event_format_version, event_type, ignorable, payload_json, created_at_ms) '
        + "VALUES (?, 99, 4, 'plan/imported', 0, '{}', 1)",
    ).run(PROJECT)

    const digest = readProjectDigest(db, PROJECT)
    expect(digest.plans).toHaveLength(1)
    expect(digest.items).toHaveLength(1)
    expect(digest.replay).toMatchObject({ outcome: 'undecodable' })
    expect(digest.replay.outcome).toBe('undecodable')
    if (digest.replay.outcome !== 'undecodable') return
    expect(digest.replay.timelineError).toMatch(/carries event format 4; this build reads up to format 3/u)
  })
})
