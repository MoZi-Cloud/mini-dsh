/** The replay audit read seam: the replayed projection versus the materialized rows, in both directions. */

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  appendProjectEvent,
  claimWorkItem,
  decideApproval,
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  readProjectReplay,
  recordDecision,
  openResourceRequirement,
  provideResourceInstance,
  releaseWorkLease,
  requestApproval,
  validatePlanSchema,
  verifyResourceInstance,
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
      replayed: {
        planVersions: 1, workItems: 1, criteria: 1, leases: 1, workPackets: 0,
        decisionRequests: 0, decisions: 0, approvals: 0,
        resourceRequirements: 0, resourceInstances: 0, resourceVerifications: 0,
      },
      materialized: {
        planVersions: 1, workItems: 1, criteria: 1, leases: 1,
        decisionRequests: 0, decisions: 0, approvals: 0,
        resourceRequirements: 0, resourceInstances: 0, resourceVerifications: 0,
      },
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
    expect(report.replayed).toEqual({
      planVersions: 2, workItems: 2, criteria: 2, leases: 1,
      workPackets: 0, decisionRequests: 0, decisions: 0, approvals: 0,
      resourceRequirements: 0, resourceInstances: 0, resourceVerifications: 0,
    })
    expect(report.materialized).toEqual({
      planVersions: 1, workItems: 1, criteria: 1, leases: 0,
      decisionRequests: 0, decisions: 0, approvals: 0,
      resourceRequirements: 0, resourceInstances: 0, resourceVerifications: 0,
    })
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

  it('flags materialized decision rows no event replays', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    db.prepare(
      'INSERT INTO decision_requests '
      + '(id, project_id, plan_version_id, decision_key, title, question, blocking_level, status, created_at_ms) '
      + "VALUES ('dr:replay-proj:hand', 'replay-proj', NULL, 'hand', 'Hand row', 'Q?', 'ADVISORY', 'OPEN', 1)",
    ).run()
    db.prepare(
      'INSERT INTO decision_requests '
      + '(id, project_id, plan_version_id, decision_key, title, question, blocking_level, status, created_at_ms) '
      + "VALUES ('dr:replay-proj:with-decision', 'replay-proj', NULL, 'with-decision', 'Carries one', 'Q?', 'ADVISORY', 'OPEN', 2)",
    ).run()
    db.prepare(
      'INSERT INTO decisions '
      + '(id, decision_request_id, decided_by, selected_option_id, decision_text, decided_at_ms) '
      + "VALUES ('dc:replay-proj:with-decision:1', 'dr:replay-proj:with-decision', 'owner', NULL, 'decided out of band', 3)",
    ).run()
    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      'decision request "dr:replay-proj:hand" is materialized but no decision/requested event replays it',
      'decision request "dr:replay-proj:with-decision" is materialized but no decision/requested event replays it',
      'decision "dc:replay-proj:with-decision:1" is materialized but no decision/recorded event replays it',
    ])
  })

  it('flags replayed decision events no row materializes, and disagreeing decision facts', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    const resolved = openDecisionRequest(db, PROJECT, {
      decisionKey: 'a', title: 'A', question: 'Q?', blockingLevel: 'BLOCKING',
      options: [{ optionKey: 'go', label: 'Go' }],
    }, { nowMs: 10, actorRef: 'spec-owner' })
    recordDecision(db, resolved.requestId, { decidedBy: 'owner', selectedOptionKey: 'go', decisionText: 'go' }, { nowMs: 11, actorRef: 'spec-owner' })
    const vanished = openDecisionRequest(db, PROJECT, {
      decisionKey: 'b', title: 'B', question: 'Q?', blockingLevel: 'ADVISORY',
    }, { nowMs: 12, actorRef: 'spec-owner' })
    const eventful = openDecisionRequest(db, PROJECT, {
      decisionKey: 'c', title: 'C', question: 'Q?', blockingLevel: 'ADVISORY',
    }, { nowMs: 13, actorRef: 'spec-owner' })
    db.prepare('DELETE FROM decision_requests WHERE id = ?').run(vanished.requestId)
    appendProjectEvent(db, PROJECT, 'decision/recorded', {
      requestId: eventful.requestId,
      decisionId: 'dc:replay-proj:c-only-event',
      decidedBy: 'owner',
      decisionText: 'recorded in the timeline only',
      resolvedAtMs: 14,
    }, { entityType: 'decision_request', entityId: eventful.requestId, nowMs: 14, actorRef: 'spec-owner' })
    db.prepare("UPDATE decisions SET decided_by = 'impostor' WHERE decision_request_id = ?").run(resolved.requestId)
    const resolvedDecisionId = (db.prepare('SELECT id FROM decisions WHERE decision_request_id = ?')
      .get(resolved.requestId) as { id: string }).id

    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      'decision request "dr:replay-proj:c" has materialized status OPEN but replays to RESOLVED',
      `decision request "${vanished.requestId}" replays from a decision/requested event but no row is materialized`,
      `decision "${resolvedDecisionId}" materializes for "dr:replay-proj:a" by impostor but replays for "dr:replay-proj:a" by owner`,
      'decision "dc:replay-proj:c-only-event" replays from a decision/recorded event but no row is materialized',
    ])
  })

  it('flags materialized approval rows no event replays', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    db.prepare(
      'INSERT INTO approvals '
      + '(id, project_id, subject_type, subject_id, required_role, requested_by, status, requested_at_ms) '
      + "VALUES ('ap:replay-proj:hand', 'replay-proj', 'plan-version', 'plv:replay-plan:v1', NULL, 'owner', 'PENDING', 1)",
    ).run()
    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      'approval "ap:replay-proj:hand" is materialized but no approval/requested event replays it',
    ])
  })

  it('flags replayed approval events no row materializes, and disagreeing approval facts', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    const decided = requestApproval(db, PROJECT, {
      subjectType: 'plan-version', subjectId: 'plv:replay-plan:v1', requestedBy: 'spec-owner',
    }, { nowMs: 10, actorRef: 'spec-owner' })
    decideApproval(db, decided.approvalId, {
      outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'approved',
    }, { nowMs: 11, actorRef: 'spec-owner' })
    // The CHECKs couple the deciding columns to the non-PENDING status, so
    // tampering moves each column set whole.
    const wiped = requestApproval(db, PROJECT, {
      subjectType: 'work-item', subjectId: WORK_ITEM,
    }, { nowMs: 12, actorRef: 'spec-owner' })
    decideApproval(db, wiped.approvalId, {
      outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'wiped after the fact',
    }, { nowMs: 13, actorRef: 'spec-owner' })
    db.prepare("UPDATE approvals SET status = 'PENDING', decision_text = NULL, decided_by = NULL, decided_at_ms = NULL WHERE id = ?")
      .run(wiped.approvalId)
    const promoted = requestApproval(db, PROJECT, {
      subjectType: 'work-item', subjectId: WORK_ITEM,
    }, { nowMs: 14, actorRef: 'spec-owner' })
    db.prepare("UPDATE approvals SET status = 'APPROVED', decision_text = 'decided out of band', decided_by = 'owner', decided_at_ms = 5 WHERE id = ?")
      .run(promoted.approvalId)
    const retargeted = requestApproval(db, PROJECT, {
      subjectType: 'plan-version', subjectId: 'plv:replay-plan:v1',
    }, { nowMs: 15, actorRef: 'spec-owner' })
    db.prepare("UPDATE approvals SET subject_type = 'work-item' WHERE id = ?").run(retargeted.approvalId)
    const vanished = requestApproval(db, PROJECT, {
      subjectType: 'work-item', subjectId: WORK_ITEM, requestedBy: 'spec-owner',
    }, { nowMs: 16, actorRef: 'spec-owner' })
    db.prepare('DELETE FROM approvals WHERE id = ?').run(vanished.approvalId)
    appendProjectEvent(db, PROJECT, 'approval/requested', {
      approvalId: 'ap:replay-proj:event-only',
      subjectType: 'plan-version',
      subjectId: 'plv:replay-plan:v1',
    }, { entityType: 'approval', entityId: 'ap:replay-proj:event-only', nowMs: 17, actorRef: 'spec-owner' })
    db.prepare("UPDATE approvals SET decided_by = 'impostor' WHERE id = ?").run(decided.approvalId)

    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      `approval "${decided.approvalId}" materializes decided by impostor but replays decided by owner`,
      `approval "${wiped.approvalId}" has materialized status PENDING but replays to APPROVED`,
      `approval "${wiped.approvalId}" materializes decided by nobody but replays decided by owner`,
      `approval "${promoted.approvalId}" has materialized status APPROVED but replays to PENDING`,
      `approval "${promoted.approvalId}" materializes decided by owner but replays decided by nobody`,
      `approval "${retargeted.approvalId}" materializes over work-item "plv:replay-plan:v1" `
        + 'but replays over plan-version "plv:replay-plan:v1"',
      `approval "${vanished.approvalId}" replays from an approval/requested event but no row is materialized`,
      'approval "ap:replay-proj:event-only" replays from an approval/requested event but no row is materialized',
    ])
  })

  it('flags materialized resource rows no event replays, and disagreeing resource facts', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    const requirement = openResourceRequirement(db, PROJECT, {
      requirementKey: 'parity', requirementKind: 'ENVIRONMENT', name: 'Parity', constraintsJson: '{}',
    }, { nowMs: 10, actorRef: 'spec-owner' })
    const instance = provideResourceInstance(db, {
      requirementId: requirement.requirementId, label: 'inst', provider: 'spec-owner',
    }, { nowMs: 11, actorRef: 'spec-owner' })
    const verification = verifyResourceInstance(db, instance.instanceId, {
      verifierKind: 'TEST', verificationSpec: 'x', result: 'PASS',
    }, { nowMs: 12, actorRef: 'spec-owner' })
    // Tampered facts in both directions, plus materialized- and replayed-only
    // ghosts; the retarget points at the hand row because the foreign key
    // requires a real requirement.
    db.prepare('UPDATE resource_requirements SET name = ?, status = ? WHERE id = ?')
      .run('Tampered', 'FULFILLED', requirement.requirementId)
    db.prepare(
      'INSERT INTO resource_requirements '
      + '(id, project_id, plan_version_id, requirement_key, requirement_kind, name, constraints_json, status, created_at_ms) '
      + "VALUES ('rr:replay-proj:hand', 'replay-proj', NULL, 'hand', 'K', 'Hand row', '{}', 'OPEN', 5)",
    ).run()
    db.prepare('UPDATE resource_instances SET requirement_id = ? WHERE id = ?')
      .run('rr:replay-proj:hand', instance.instanceId)
    db.prepare("UPDATE resource_instances SET status = 'RETIRED' WHERE id = ?").run(instance.instanceId)
    db.prepare("UPDATE resource_verifications SET result = 'FAIL' WHERE id = ?").run(verification.verificationId)
    appendProjectEvent(db, PROJECT, 'resource/provided', {
      instanceId: 'ri:replay-proj:event-only',
      requirementId: requirement.requirementId,
      label: 'timeline only',
    }, { entityType: 'resource_instance', entityId: 'ri:replay-proj:event-only', nowMs: 13, actorRef: 'spec-owner' })
    appendProjectEvent(db, PROJECT, 'resource/required', {
      requirementId: 'rr:replay-proj:event-only',
      requirementKey: 'event-only',
      requirementKind: 'K',
      name: 'Timeline only',
      constraintsJson: '{}',
    }, { entityType: 'resource_requirement', entityId: 'rr:replay-proj:event-only', nowMs: 14, actorRef: 'spec-owner' })
    db.prepare(
      'INSERT INTO resource_instances '
      + '(id, requirement_id, provider, label, metadata_json, status, provided_at_ms) '
      + "VALUES ('ri:replay-proj:hand', 'rr:replay-proj:hand', NULL, 'Hand instance', NULL, 'AVAILABLE', 6)",
    ).run()
    db.prepare(
      'INSERT INTO resource_verifications '
      + '(id, resource_instance_id, verifier, verifier_kind, verification_spec, observed_json, result, verified_at_ms) '
      + "VALUES ('rv:replay-proj:hand', 'ri:replay-proj:hand', NULL, 'TEST', 'spec', NULL, 'PASS', 7)",
    ).run()
    appendProjectEvent(db, PROJECT, 'resource/verified', {
      verificationId: 'rv:replay-proj:event-only',
      instanceId: instance.instanceId,
      verifierKind: 'TEST',
      verificationSpec: 'x',
      result: 'PASS',
      verifiedAtMs: 15,
    }, { entityType: 'resource_verification', entityId: 'rv:replay-proj:event-only', nowMs: 15, actorRef: 'spec-owner' })

    const report = readProjectReplay(db, PROJECT)
    expect(report.outcome).toBe('compared')
    if (report.outcome !== 'compared') return
    expect(report.drift.map(finding => finding.message)).toEqual([
      'resource requirement "rr:replay-proj:hand" is materialized but no resource/required event replays it',
      `resource requirement "${requirement.requirementId}" materializes as ENVIRONMENT "parity" (Tampered) `
        + 'but replays as ENVIRONMENT "parity" (Parity)',
      `resource requirement "${requirement.requirementId}" has materialized status FULFILLED but replays to OPEN`,
      'resource requirement "rr:replay-proj:event-only" replays from a resource/required event but no row is materialized',
      `resource instance "${instance.instanceId}" materializes for "rr:replay-proj:hand" `
        + `but replays for "${requirement.requirementId}"`,
      `resource instance "${instance.instanceId}" has materialized status RETIRED but replays to AVAILABLE`,
      'resource instance "ri:replay-proj:hand" is materialized but no resource/provided event replays it',
      'resource instance "ri:replay-proj:event-only" replays from a resource/provided event but no row is materialized',
      'resource verification "rv:replay-proj:hand" is materialized but no resource/verified event replays it',
      `resource verification "${verification.verificationId}" materializes FAIL for "${instance.instanceId}" `
        + `but replays PASS for "${instance.instanceId}"`,
      'resource verification "rv:replay-proj:event-only" replays from a resource/verified event but no row is materialized',
    ])
  })

  it('reports an undecodable timeline without comparing parity', async () => {
    const db = await ledgerOf(REPLAY_PLAN_TEXT)
    db.prepare(
      'INSERT INTO project_events '
        + '(project_id, sequence_no, event_format_version, event_type, ignorable, payload_json, created_at_ms) '
        + "VALUES (?, 99, 5, 'plan/imported', 0, '{}', 1)",
    ).run(PROJECT)
    const report = readProjectReplay(db, PROJECT)
    expect(report).toMatchObject({
      outcome: 'undecodable',
      projectId: PROJECT,
      eventCount: 3,
      lastSequenceNo: 99,
      materialized: {
        planVersions: 1, workItems: 1, criteria: 1, leases: 0,
        decisionRequests: 0, decisions: 0, approvals: 0,
        resourceRequirements: 0, resourceInstances: 0, resourceVerifications: 0,
      },
    })
    expect(report.outcome).toBe('undecodable')
    if (report.outcome !== 'undecodable') return
    expect(report.timelineError).toMatch(/carries event format 5; this build reads up to format 4/u)
  })
})
