/** The replay audit read seam: the replayed projection versus the materialized rows, in both directions. */

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  appendProjectEvent,
  claimWorkItem,
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  readProjectReplay,
  releaseWorkLease,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type ProjectId,
  type WorkItemId,
} from '../src/index.js'

/**
 * A plan whose only item carries one command criterion, so the audit reads a
 * project every writer family — import, lease, evaluation — has touched
 * through its real seams.
 */
const REPLAY_PLAN_TEXT = `schemaVersion: 1
project:
  id: replay-proj
  name: Replay Proof
plan:
  id: replay-plan
  name: Replay Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: AGENT-WORK
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the audited work
    priority: 10
    status: READY
    acceptance:
      - id: AC-REPLAY-A
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

const PROJECT = brandString<ProjectId>('replay-proj')
const WORK_ITEM = 'wi:replay-proj:AGENT-WORK'
const CRITERION = 'ac:wi:replay-proj:AGENT-WORK:AC-REPLAY-A'

/** Import one plan text into a fresh in-memory ledger, activate its version, and open it. */
async function ledgerOf(planText: string): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  const { value } = parsePlanDocument(planText)
  const { planVersionId } = importPlanVersion(db, compilePlan(validatePlanSchema(value), { sourceText: planText }))
  // Activation is an owner seam without an exported writer (v1.6a §5); the
  // spec sets it the way the pinned-fixture generator does. The fold projects
  // no version status, so the raw activation never drifts.
  db.prepare("UPDATE plan_versions SET status = 'ACTIVE' WHERE id = ?").run(planVersionId)
  return db
}

describe('readProjectReplay', () => {
  it('reports a clean audit once every writer family has run', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    const claim = claimWorkItem(db, brandString<WorkItemId>(WORK_ITEM), 'spec-worker')
    releaseWorkLease(db, claim.leaseId, claim.leaseToken)
    evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(CRITERION), 'PASS', {
      evaluatedBy: 'spec-worker',
    })
    expect(readProjectReplay(db, PROJECT)).toEqual({
      outcome: 'compared',
      projectId: PROJECT,
      eventCount: 5,
      lastSequenceNo: 5,
      replayed: { planVersions: 1, workItems: 1, criteria: 1, leases: 1, workPackets: 0 },
      materialized: { planVersions: 1, workItems: 1, criteria: 1, leases: 1 },
      drift: [],
    })
  })

  it('flags materialized rows no event replays', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    // Backlog rows have no writer yet (import always versions its items); the
    // out-of-band inserts mirror the readiness spec's fixtures and make every
    // family carry one row the timeline never recorded. Dropping the
    // plan/imported event leaves the version row in the same shape.
    db.prepare("DELETE FROM project_events WHERE event_type = 'plan/imported'").run()
    db.prepare(
      'INSERT INTO work_items '
        + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
        + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:replay-proj:BACKLOG-1', 'replay-proj', NULL, NULL, NULL, 'BACKLOG-1', 'RESEARCH', 'AGENT', "
        + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
    ).run()
    db.prepare(
      'INSERT INTO acceptance_criteria (id, work_item_id, ordinal, criterion_kind, description, required, status) '
        + "VALUES ('ac:wi:replay-proj:AGENT-WORK:EXTRA', ?, 1, 'TEST', 'An extra row', 1, 'PENDING')",
    ).run(WORK_ITEM)
    db.prepare(
      'INSERT INTO work_leases '
        + '(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms) '
        + "VALUES ('ls:replay-proj:GHOST', ?, 'ghost', 'hash', 'ACTIVE', 1, 1, 2)",
    ).run(WORK_ITEM)
    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      'plan version "plv:replay-plan:v1" is materialized but no plan/imported event replays it',
      'work item "wi:replay-proj:BACKLOG-1" is materialized but no work/created event replays it',
      'acceptance criterion "ac:wi:replay-proj:AGENT-WORK:EXTRA" is materialized but replays to no criterion of its work item',
      'work lease "ls:replay-proj:GHOST" is materialized but no work/claimed event replays it',
    ])
  })

  it('flags replayed events no row materializes', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    appendProjectEvent(db, PROJECT, 'plan/imported', {
      planId: 'replay-plan',
      planVersionId: 'plv:replay-plan:v9',
      versionNo: 9,
      sourceDocumentHash: 'hash-of-v9',
    })
    appendProjectEvent(db, PROJECT, 'work/created', {
      workItemId: 'wi:replay-proj:GHOST-ITEM',
      stableKey: 'GHOST-ITEM',
      title: 'Ghost work',
      planVersionId: 'plv:replay-plan:v1',
      status: 'READY',
      criteria: [{
        criterionId: 'ac:wi:replay-proj:GHOST-ITEM:AC-GHOST',
        ordinal: 0,
        criterionKind: 'TEST',
        required: true,
        status: 'PENDING',
      }],
    })
    appendProjectEvent(db, PROJECT, 'work/claimed', {
      workItemId: 'wi:replay-proj:GHOST-ITEM',
      leaseId: 'ls:replay-proj:GHOST',
      workerIdentity: 'ghost',
      fromStatus: 'READY',
      toStatus: 'IN_PROGRESS',
      acquiredAtMs: 1,
      expiresAtMs: 2,
    })
    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.replayed).toEqual({ planVersions: 2, workItems: 2, criteria: 2, leases: 1, workPackets: 0 })
    expect(report.materialized).toEqual({ planVersions: 1, workItems: 1, criteria: 1, leases: 0 })
    expect(report.drift.map(finding => finding.message)).toEqual([
      'plan version "plv:replay-plan:v9" replays from a plan/imported event but no row is materialized',
      'work item "wi:replay-proj:GHOST-ITEM" replays from a work/created event but no row is materialized',
      'acceptance criterion "ac:wi:replay-proj:GHOST-ITEM:AC-GHOST" replays but no row is materialized',
      'work lease "ls:replay-proj:GHOST" replays from a work/claimed event but no row is materialized',
    ])
  })

  it('flags disagreeing statuses and plan-version facts', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    const claim = claimWorkItem(db, brandString<WorkItemId>(WORK_ITEM), 'spec-worker')
    db.prepare("UPDATE work_items SET status = 'FAILED' WHERE id = ?").run(WORK_ITEM)
    db.prepare("UPDATE acceptance_criteria SET status = 'WAIVED' WHERE id = ?").run(CRITERION)
    db.prepare("UPDATE work_leases SET status = 'REVOKED' WHERE id = ?").run(claim.leaseId)
    db.prepare("UPDATE plan_versions SET source_document_hash = 'tampered' WHERE id = 'plv:replay-plan:v1'").run()
    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      expect.stringMatching(
        /plan version "plv:replay-plan:v1" materializes as replay-plan v1 hash tampered but replays as replay-plan v1 hash [0-9a-f]{64}/u,
      ) as string,
      'work item "wi:replay-proj:AGENT-WORK" has materialized status FAILED but replays to IN_PROGRESS',
      `acceptance criterion "${CRITERION}" has materialized status WAIVED but replays to PENDING`,
      `work lease "${claim.leaseId}" has materialized status REVOKED but replays to ACTIVE`,
    ])
  })

  it('reports an undecodable timeline without comparing parity', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    db.prepare(
      'INSERT INTO project_events '
        + '(project_id, sequence_no, event_format_version, event_type, ignorable, payload_json, created_at_ms) '
        + "VALUES (?, 99, 2, 'plan/imported', 0, '{}', 1)",
    ).run(PROJECT)
    const report = readProjectReplay(db, PROJECT)
    expect(report).toMatchObject({
      outcome: 'undecodable',
      projectId: PROJECT,
      eventCount: 3,
      lastSequenceNo: 99,
      materialized: { planVersions: 1, workItems: 1, criteria: 1, leases: 0 },
    })
    expect(report.outcome).toBe('undecodable')
    if (report.outcome !== 'undecodable') return
    expect(report.timelineError).toMatch(/carries event format 2; this build reads format 1/u)
  })
})
