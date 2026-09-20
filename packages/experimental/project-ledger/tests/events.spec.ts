import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_IMPORT_ACTOR_REF,
  PROJECT_EVENT_FORMAT_VERSION,
  ProjectEventError,
  appendProjectEvent,
  assignRole,
  compilePlan,
  decideApproval,
  defineRole,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  readProjectEvents,
  openResourceRequirement,
  provideResourceInstance,
  recordConflict,
  recordDecision,
  registerActor,
  releaseScopeReservation,
  reapExpiredScopeReservations,
  replayProjectEvents,
  requestApproval,
  reserveScope,
  resolveConflict,
  validatePlanSchema,
  verifyResourceInstance,
  type AcceptanceCriterionId,
  type AcceptanceCriterionStatus,
  type ActorId,
  type ActorRoleId,
  type ApprovalId,
  type ApprovalSubjectType,
  type CompiledPlan,
  type DecisionId,
  type DecisionRequestId,
  type PlanAcceptanceKind,
  type PlanId,
  type PlanVersionId,
  type PlanWorkItemStatus,
  type ProjectEventEnvelope,
  type ProjectId,
  type ReplayedApproval,
  type ReplayedActor,
  type ReplayedActorRole,
  type ReplayedCriterion,
  type ReplayedConflict,
  type ReplayedDecision,
  type ReplayedDecisionRequest,
  type ReplayedHandoff,
  type ReplayedResourceInstance,
  type ReplayedResourceRequirement,
  type ReplayedResourceVerification,
  type ReplayedLease,
  type ReplayedLeaseStatus,
  type ReplayedPlanVersion,
  type ReplayedProjectProjection,
  type ReplayedRole,
  type ReplayedScopeReservation,
  type ConflictId,
  type ScopeReservationId,
  type ReplayedWorkAssignment,
  type ReplayedWorkItem,
  type ResourceRequirementId,
  type ResourceInstanceId,
  type ResourceVerificationId,
  type ResourceVerificationResult,
  type RoleId,
  type SourceDocumentHash,
  type HandoffId,
  type WorkAssignmentId,
  type WorkItemId,
  type WorkLeaseId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_SOURCE_HASH = createHash('sha256').update(GOLDEN_PLAN_TEXT, 'utf8').digest('hex')

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
 * Call a thunk and return the ProjectEventError it threw; any other outcome
 * fails the test through the instance assertion or the unreachable marker.
 */
function thrownEventError(call: () => unknown): ProjectEventError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProjectEventError)
    return error as ProjectEventError
  }
  expect.unreachable('expected the call to throw ProjectEventError')
}

/**
 * Insert an event row directly, bypassing the codec — the seam for rows a
 * newer or misbehaving writer could leave behind. The sequence is the
 * project's next one, mirroring a real append.
 */
function insertRawEvent(
  db: DatabaseSync,
  overrides: {
    readonly eventType: string
    readonly ignorable: number
    readonly eventFormatVersion?: number
    readonly payloadJson?: string
  },
): void {
  db.prepare(
    'INSERT INTO project_events '
    + '(project_id, sequence_no, event_format_version, event_type, ignorable, entity_type, entity_id, actor_ref, '
    + 'payload_json, created_at_ms) '
    + 'VALUES (?, (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM project_events WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(
    PROJECT,
    PROJECT,
    overrides.eventFormatVersion ?? PROJECT_EVENT_FORMAT_VERSION,
    overrides.eventType,
    overrides.ignorable,
    null,
    null,
    'raw-test',
    overrides.payloadJson ?? '{}',
  )
}

/** The projection read straight from the materialized tables, for the parity comparison. */
function materializedProjection(db: DatabaseSync): ReplayedProjectProjection {
  const planVersions = new Map<PlanVersionId, ReplayedPlanVersion>()
  const versionRows = db.prepare('SELECT id, plan_id, version_no, source_document_hash FROM plan_versions')
    .all() as { id: string; plan_id: string; version_no: number; source_document_hash: string }[]
  for (const row of versionRows) {
    planVersions.set(brandString<PlanVersionId>(row.id), {
      planId: brandString<PlanId>(row.plan_id),
      versionNo: row.version_no,
      sourceDocumentHash: brandString<SourceDocumentHash>(row.source_document_hash),
    })
  }
  const criteriaByItem = new Map<string, Map<AcceptanceCriterionId, ReplayedCriterion>>()
  const criteriaRows = db.prepare(
    'SELECT id, work_item_id, ordinal, criterion_kind, required, status FROM acceptance_criteria ORDER BY ordinal',
  ).all() as {
    id: string
    work_item_id: string
    ordinal: number
    criterion_kind: string
    required: number
    status: string
  }[]
  for (const row of criteriaRows) {
    const criteria = criteriaByItem.get(row.work_item_id) ?? new Map<AcceptanceCriterionId, ReplayedCriterion>()
    criteria.set(brandString<AcceptanceCriterionId>(row.id), {
      ordinal: row.ordinal,
      criterionKind: row.criterion_kind as PlanAcceptanceKind,
      required: row.required === 1,
      status: row.status as AcceptanceCriterionStatus,
    })
    criteriaByItem.set(row.work_item_id, criteria)
  }
  const workItems = new Map<WorkItemId, ReplayedWorkItem>()
  const itemRows = db.prepare('SELECT id, stable_key, title, plan_version_id, status FROM work_items')
    .all() as { id: string; stable_key: string; title: string; plan_version_id: string | null; status: string }[]
  for (const row of itemRows) {
    workItems.set(brandString<WorkItemId>(row.id), {
      stableKey: row.stable_key,
      title: row.title,
      planVersionId: brandString<PlanVersionId>(row.plan_version_id!),
      status: row.status as PlanWorkItemStatus,
      criteria: criteriaByItem.get(row.id) ?? new Map(),
    })
  }
  const leases = new Map<WorkLeaseId, ReplayedLease>()
  const leaseRows = db.prepare(
    'SELECT id, work_item_id, worker_identity, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms, released_at_ms '
    + 'FROM work_leases',
  ).all() as {
    id: string
    work_item_id: string
    worker_identity: string
    status: string
    acquired_at_ms: number
    heartbeat_at_ms: number
    expires_at_ms: number
    released_at_ms: number | null
  }[]
  for (const row of leaseRows) {
    leases.set(brandString<WorkLeaseId>(row.id), {
      workItemId: brandString<WorkItemId>(row.work_item_id),
      workerIdentity: row.worker_identity,
      status: row.status as ReplayedLeaseStatus,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatAtMs: row.heartbeat_at_ms,
      expiresAtMs: row.expires_at_ms,
      releasedAtMs: row.released_at_ms ?? undefined,
    })
  }
  const decisionRequests = new Map<DecisionRequestId, ReplayedDecisionRequest>()
  const decisions = new Map<DecisionId, ReplayedDecision>()
  for (const row of db.prepare(
    'SELECT r.id, r.decision_key, r.status, o.option_key FROM decision_requests r '
    + 'LEFT JOIN decision_options o ON o.decision_request_id = r.id',
  ).all() as { id: string; decision_key: string; status: string; option_key: string | null }[]) {
    const existing = decisionRequests.get(brandString<DecisionRequestId>(row.id))
    if (existing === undefined) {
      decisionRequests.set(brandString<DecisionRequestId>(row.id), {
        decisionKey: row.decision_key,
        optionKeys: new Set(row.option_key === null ? [] : [row.option_key]),
        status: row.status as 'OPEN' | 'RESOLVED',
      })
    } else if (row.option_key !== null) {
      decisionRequests.set(brandString<DecisionRequestId>(row.id), {
        ...existing,
        optionKeys: new Set([...existing.optionKeys, row.option_key]),
      })
    }
  }
  for (const row of db.prepare('SELECT id, decision_request_id, decided_by FROM decisions').all() as {
    id: string
    decision_request_id: string
    decided_by: string
  }[]) {
    decisions.set(brandString<DecisionId>(row.id), {
      requestId: brandString<DecisionRequestId>(row.decision_request_id),
      decidedBy: row.decided_by,
    })
  }
  const approvals = new Map<ApprovalId, ReplayedApproval>()
  for (const row of db.prepare('SELECT id, subject_type, subject_id, status, decided_by FROM approvals').all() as {
    id: string
    subject_type: ApprovalSubjectType
    subject_id: string
    status: 'PENDING' | 'APPROVED' | 'REJECTED'
    decided_by: string | null
  }[]) {
    approvals.set(brandString<ApprovalId>(row.id), {
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      status: row.status,
      decidedBy: row.decided_by ?? undefined,
    })
  }
  const resourceRequirements = new Map<ResourceRequirementId, ReplayedResourceRequirement>()
  for (const row of db.prepare(
    'SELECT id, requirement_key, requirement_kind, name, status FROM resource_requirements',
  ).all() as { id: string; requirement_key: string; requirement_kind: string; name: string; status: 'OPEN' }[]) {
    resourceRequirements.set(brandString<ResourceRequirementId>(row.id), {
      requirementKey: row.requirement_key,
      requirementKind: row.requirement_kind,
      name: row.name,
      status: row.status,
    })
  }
  const resourceInstances = new Map<ResourceInstanceId, ReplayedResourceInstance>()
  for (const row of db.prepare('SELECT id, requirement_id, label, status FROM resource_instances').all() as {
    id: string
    requirement_id: string
    label: string
    status: 'AVAILABLE'
  }[]) {
    resourceInstances.set(brandString<ResourceInstanceId>(row.id), {
      requirementId: brandString<ResourceRequirementId>(row.requirement_id),
      label: row.label,
      status: row.status,
    })
  }
  const resourceVerifications = new Map<ResourceVerificationId, ReplayedResourceVerification>()
  for (const row of db.prepare('SELECT id, resource_instance_id, result FROM resource_verifications').all() as {
    id: string
    resource_instance_id: string
    result: ResourceVerificationResult
  }[]) {
    resourceVerifications.set(brandString<ResourceVerificationId>(row.id), {
      instanceId: brandString<ResourceInstanceId>(row.resource_instance_id),
      result: row.result,
    })
  }
  const actors = new Map<ActorId, ReplayedActor>()
  for (const row of db.prepare(
    'SELECT id, actor_key, actor_kind, display_name, status FROM actors',
  ).all() as { id: string; actor_key: string; actor_kind: string; display_name: string; status: 'ACTIVE' }[]) {
    actors.set(brandString<ActorId>(row.id), {
      actorKey: row.actor_key,
      actorKind: row.actor_kind as ReplayedActor['actorKind'],
      displayName: row.display_name,
      status: row.status,
    })
  }
  const roles = new Map<RoleId, ReplayedRole>()
  for (const row of db.prepare('SELECT id, role_name, role_kind FROM roles').all() as {
    id: string
    role_name: string
    role_kind: string
  }[]) {
    roles.set(brandString<RoleId>(row.id), {
      roleName: row.role_name,
      roleKind: row.role_kind as ReplayedRole['roleKind'],
    })
  }
  const actorRoles = new Map<ActorRoleId, ReplayedActorRole>()
  for (const row of db.prepare('SELECT id, actor_id, role_id, valid_to_ms FROM actor_roles').all() as {
    id: string
    actor_id: string
    role_id: string
    valid_to_ms: number | null
  }[]) {
    actorRoles.set(brandString<ActorRoleId>(row.id), {
      actorId: brandString<ActorId>(row.actor_id),
      roleId: brandString<RoleId>(row.role_id),
      validToMs: row.valid_to_ms ?? undefined,
    })
  }
  const workAssignments = new Map<WorkAssignmentId, ReplayedWorkAssignment>()
  for (const row of db.prepare('SELECT id, work_item_id, actor_id, role_id, assignment_kind FROM work_assignments').all() as {
    id: string
    work_item_id: string
    actor_id: string
    role_id: string | null
    assignment_kind: string
  }[]) {
    workAssignments.set(brandString<WorkAssignmentId>(row.id), {
      workItemId: brandString<WorkItemId>(row.work_item_id),
      actorId: brandString<ActorId>(row.actor_id),
      roleId: row.role_id === null ? undefined : brandString<RoleId>(row.role_id),
      assignmentKind: row.assignment_kind as ReplayedWorkAssignment['assignmentKind'],
      status: 'ACTIVE',
    })
  }
  // No test in this file prepares work packets; the rebuild seam owns packet parity.
  const handoffs = new Map<HandoffId, ReplayedHandoff>()
  for (const row of db.prepare('SELECT id, work_item_id, from_actor_id, to_actor_id, to_role_id, handoff_kind FROM handoffs').all() as {
    id: string
    work_item_id: string
    from_actor_id: string
    to_actor_id: string | null
    to_role_id: string | null
    handoff_kind: string
  }[]) {
    handoffs.set(brandString<HandoffId>(row.id), {
      workItemId: brandString<WorkItemId>(row.work_item_id),
      fromActorId: brandString<ActorId>(row.from_actor_id),
      toActorId: row.to_actor_id === null ? undefined : brandString<ActorId>(row.to_actor_id),
      toRoleId: row.to_role_id === null ? undefined : brandString<RoleId>(row.to_role_id),
      handoffKind: row.handoff_kind as ReplayedHandoff['handoffKind'],
    })
  }
  const scopeReservations = new Map<ScopeReservationId, ReplayedScopeReservation>()
  for (const row of db.prepare(
    'SELECT id, work_item_id, actor_id, scope_kind, scope_value, expires_at_ms, status FROM scope_reservations',
  ).all() as {
    id: string
    work_item_id: string
    actor_id: string
    scope_kind: string
    scope_value: string
    expires_at_ms: number
    status: string
  }[]) {
    scopeReservations.set(brandString<ScopeReservationId>(row.id), {
      workItemId: brandString<WorkItemId>(row.work_item_id),
      actorId: brandString<ActorId>(row.actor_id),
      scopeKind: row.scope_kind as ReplayedScopeReservation['scopeKind'],
      scopeValue: row.scope_value,
      expiresAtMs: row.expires_at_ms,
      status: row.status as ReplayedScopeReservation['status'],
    })
  }
  const conflicts = new Map<ConflictId, ReplayedConflict>()
  for (const row of db.prepare(
    'SELECT id, work_item_a, work_item_b, raised_by_actor_id, conflict_kind, description, status, '
    + 'resolution_decision_id FROM collaboration_conflicts',
  ).all() as {
    id: string
    work_item_a: string
    work_item_b: string
    raised_by_actor_id: string
    conflict_kind: string
    description: string
    status: string
    resolution_decision_id: string | null
  }[]) {
    conflicts.set(brandString<ConflictId>(row.id), {
      workItemAId: brandString<WorkItemId>(row.work_item_a),
      workItemBId: brandString<WorkItemId>(row.work_item_b),
      raisedByActorId: brandString<ActorId>(row.raised_by_actor_id),
      conflictKind: row.conflict_kind as ReplayedConflict['conflictKind'],
      description: row.description,
      status: row.status as ReplayedConflict['status'],
      resolutionDecisionId: row.resolution_decision_id === null
        ? undefined
        : brandString<DecisionId>(row.resolution_decision_id),
    })
  }
  return {
    planVersions,
    workItems,
    leases,
    workPackets: new Map(),
    decisionRequests,
    decisions,
    approvals,
    resourceRequirements,
    resourceInstances,
    resourceVerifications,
    actors,
    roles,
    actorRoles,
    workAssignments,
    handoffs,
    scopeReservations,
    conflicts,
  }
}

describe('appendProjectEvent', () => {
  it('allocates dense per-project sequences and stamps the envelope', async () => {
    const db = await goldenLedger()
    const payload = { workItemId: 'wi:mini-dsh:IMPORT-001', fromStatus: 'BLOCKED', toStatus: 'READY' }
    const envelope = appendProjectEvent(db, PROJECT, 'work/status-changed', payload, {
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:IMPORT-001',
      actorRef: 'tester',
      nowMs: 1234,
    })
    expect(envelope).toEqual({
      projectId: 'mini-dsh',
      sequenceNo: 17,
      eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION,
      eventType: 'work/status-changed',
      ignorable: false,
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:IMPORT-001',
      actorRef: 'tester',
      payload,
      createdAtMs: 1234,
    })
    expect(db.prepare('SELECT ignorable, payload_json FROM project_events WHERE project_id = ? AND sequence_no = 17')
      .get(PROJECT)).toEqual({ ignorable: 0, payload_json: JSON.stringify(payload) })

    const otherProject = appendProjectEvent(
      db,
      brandString<ProjectId>('p2'),
      'baseline/drift-detected',
      { repoHead: 'ff' },
      { nowMs: 5 },
    )
    expect(otherProject.sequenceNo).toBe(1)
    db.close()
  })

  it('refuses to record a required vocabulary entry as ignorable', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const attempt = (): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'work/created', { workItemId: 'wi:p:X' }, { ignorable: true, nowMs: 1 })
    expect(thrownEventError(attempt).code).toBe('required-event-not-ignorable')
    expect(thrownEventError(attempt).message)
      .toBe('project event "work/created" is a required vocabulary entry and is recorded as required; '
        + 'observational rows need an unregistered type')
    db.close()
  })

  it('requires the observational flag for unregistered types', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const unflagged = (): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'alien/spice-up', { note: 1 }, { nowMs: 1 })
    expect(thrownEventError(unflagged).code).toBe('unregistered-event-type')

    const observed = appendProjectEvent(db, PROJECT, 'alien/spice-up', { note: 1 }, { ignorable: true })
    expect(observed).toMatchObject({ eventType: 'alien/spice-up', ignorable: true, sequenceNo: 1 })
    expect(db.prepare('SELECT ignorable FROM project_events WHERE project_id = ? AND sequence_no = 1').get(PROJECT))
      .toEqual({ ignorable: 1 })
    db.close()
  })
})

describe('readProjectEvents', () => {
  it('returns the timeline in sequence order with decoded payloads', async () => {
    const db = await goldenLedger()
    const events = readProjectEvents(db, PROJECT)
    expect(events).toHaveLength(16)
    expect(events.map(event => event.sequenceNo)).toEqual([...events.keys()].map(offset => offset + 1))
    expect(events[0]).toMatchObject({
      sequenceNo: 1,
      eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION,
      eventType: 'plan/imported',
      ignorable: false,
      entityType: 'plan_version',
      entityId: 'plv:mini-dsh-v1.6a-ledger:v1',
      actorRef: DEFAULT_IMPORT_ACTOR_REF,
    })
    expect(events[0]!.payload).toEqual({
      planId: 'mini-dsh-v1.6a-ledger',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      versionNo: 1,
      sourceDocumentHash: GOLDEN_SOURCE_HASH,
    })
    db.close()
  })

  it('preserves unknown ignorable events in the read timeline', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/note', ignorable: 1, payloadJson: '{"note":"observed"}' })
    const events = readProjectEvents(db, PROJECT)
    expect(events).toHaveLength(17)
    expect(events[16]).toMatchObject({ eventType: 'alien/note', ignorable: true, payload: { note: 'observed' } })
    db.close()
  })

  it('fails closed on an unknown required event', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/rewrite', ignorable: 0 })
    expect(thrownEventError(() => readProjectEvents(db, PROJECT)).code).toBe('unknown-required-event')
    expect(thrownEventError(() => readProjectEvents(db, PROJECT)).message)
      .toBe('project event 17 of "mini-dsh" carries unknown required event "alien/rewrite"; '
        + 'a newer codec is required to read this ledger')
    db.close()
  })

  it('fails closed on an event format version newer than this build', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION + 1 })
    const thrown = thrownEventError(() => readProjectEvents(db, PROJECT))
    expect(thrown.code).toBe('event-format-unsupported')
    expect(thrown.message).toBe(
      `project event 17 of "mini-dsh" carries event format ${String(PROJECT_EVENT_FORMAT_VERSION + 1)}; `
      + `this build reads up to format ${String(PROJECT_EVENT_FORMAT_VERSION)}`,
    )
    db.close()
  })

  it('decodes rows stamped with an older adjacent event format', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, eventFormatVersion: 1 })
    const events = readProjectEvents(db, PROJECT)
    expect(events).toHaveLength(17)
    expect(events[16]).toMatchObject({ eventFormatVersion: 1, eventType: 'work/status-changed' })
    db.close()
  })

  it('fails closed on payload JSON that does not parse', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, payloadJson: '{oops' })
    const thrown = thrownEventError(() => readProjectEvents(db, PROJECT))
    expect(thrown.code).toBe('malformed-event-payload')
    expect(thrown.message).toContain('invalid payload JSON')
    db.close()
  })
})

describe('replayProjectEvents', () => {
  it('replays the golden import to the materialized projection', async () => {
    const db = await goldenLedger()
    const replayed = replayProjectEvents(db, PROJECT)

    expect(replayed.planVersions.size).toBe(1)
    expect(replayed.workItems.size).toBe(15)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.planVersions.get(brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1'))).toEqual({
      planId: 'mini-dsh-v1.6a-ledger',
      versionNo: 1,
      sourceDocumentHash: GOLDEN_SOURCE_HASH,
    })
    expect(replayed.workItems.get(brandString<WorkItemId>('wi:mini-dsh:IMPORT-001'))).toEqual({
      stableKey: 'IMPORT-001',
      title: 'Compile and transactionally import an immutable plan version',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      status: 'BLOCKED',
      criteria: new Map([
        [brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:IMPORT-001:AC-IMPORT-001'), {
          ordinal: 0,
          criterionKind: 'TEST',
          required: true,
          status: 'PENDING',
        }],
      ]),
    })
    db.close()
  })

  it('skips unknown ignorable rows and vocabulary types without a projection effect', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/note', ignorable: 1, payloadJson: '{"note":"observed"}' })
    appendProjectEvent(db, PROJECT, 'plan/version-activated', {
      activatedBy: 'owner',
    }, { entityType: 'plan_version', entityId: 'plv:mini-dsh-v1.6a-ledger:v1', nowMs: 2 })

    expect(readProjectEvents(db, PROJECT)).toHaveLength(18)
    expect(replayProjectEvents(db, PROJECT)).toEqual(materializedProjection(db))
    db.close()
  })

  it('applies work/status-changed to the replayed projection', async () => {
    const db = await goldenLedger()
    db.prepare("UPDATE work_items SET status = 'IN_PROGRESS' WHERE id = 'wi:mini-dsh:IMPORT-001'").run()
    appendProjectEvent(db, PROJECT, 'work/status-changed', {
      workItemId: 'wi:mini-dsh:IMPORT-001',
      fromStatus: 'BLOCKED',
      toStatus: 'IN_PROGRESS',
    }, { entityType: 'work_item', entityId: 'wi:mini-dsh:IMPORT-001', nowMs: 2 })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed.workItems.get(brandString<WorkItemId>('wi:mini-dsh:IMPORT-001'))?.status).toBe('IN_PROGRESS')
    expect(replayed).toEqual(materializedProjection(db))
    db.close()
  })

  it('fails replay on a status change naming an unknown work item', async () => {
    const db = await goldenLedger()
    appendProjectEvent(db, PROJECT, 'work/status-changed', {
      workItemId: 'wi:mini-dsh:GHOST',
      fromStatus: 'BLOCKED',
      toStatus: 'READY',
    }, { entityType: 'work_item', entityId: 'wi:mini-dsh:GHOST', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:GHOST)')
    db.close()
  })

  it('fails replay on an unknown required event', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/rewrite', ignorable: 0 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).code).toBe('unknown-required-event')
    db.close()
  })

  it('fails replay on applier payloads with missing, mistyped, or non-object fields', async () => {
    const db = await goldenLedger()
    const baseImported: Record<string, unknown> = {
      planId: 'mini-dsh-v1.6a-ledger',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      versionNo: 1,
      sourceDocumentHash: 'hash',
    }
    const baseCreated: Record<string, unknown> = {
      workItemId: 'wi:mini-dsh:EXTRA',
      stableKey: 'EXTRA',
      title: 'Extra item',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      status: 'READY',
      criteria: [{
        criterionId: 'ac:wi:mini-dsh:EXTRA:AC-EXTRA',
        ordinal: 0,
        criterionKind: 'TEST',
        required: true,
        status: 'PENDING',
      }],
    }
    const baseStatusChanged: Record<string, unknown> = {
      workItemId: 'wi:mini-dsh:IMPORT-001',
      fromStatus: 'BLOCKED',
      toStatus: 'READY',
    }
    const created = appendProjectEvent(db, PROJECT, 'work/created', baseCreated, {
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:EXTRA',
      nowMs: 2,
    })
    const statusChanged = appendProjectEvent(db, PROJECT, 'work/status-changed', baseStatusChanged, {
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:IMPORT-001',
      nowMs: 3,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }

    for (const field of Object.keys(baseImported)) {
      const payload = Object.fromEntries(Object.entries(baseImported).filter(([key]) => key !== field))
      setPayload(1, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(1, { ...baseImported, versionNo: '1' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "versionNo" must be a number')
    setPayload(1, baseImported)

    for (const field of Object.keys(baseCreated)) {
      const payload = Object.fromEntries(Object.entries(baseCreated).filter(([key]) => key !== field))
      setPayload(created.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    for (const variant of [null, 'spice', [1, 2]]) {
      setPayload(created.sequenceNo, variant)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain('non-object payload')
    }
    setPayload(created.sequenceNo, baseCreated)

    const criterion = (baseCreated.criteria as Record<string, unknown>[])[0] as Record<string, unknown>
    const withCriteria = (criteria: unknown): Record<string, unknown> => ({ ...baseCreated, criteria })
    setPayload(created.sequenceNo, withCriteria('spice'))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria" must be an array')
    setPayload(created.sequenceNo, withCriteria([42]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0]" must be an object')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, ordinal: 'zero' }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].ordinal" must be a number')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, required: 1 }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].required" must be a boolean')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, criterionKind: 'TELEPORT' }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].criterionKind" is not an acceptance kind: "TELEPORT"')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, status: 'SPICED' }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].status" is not an acceptance criterion status: "SPICED"')
    setPayload(created.sequenceNo, baseCreated)

    for (const field of Object.keys(baseStatusChanged)) {
      const payload = Object.fromEntries(Object.entries(baseStatusChanged).filter(([key]) => key !== field))
      setPayload(statusChanged.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(statusChanged.sequenceNo, { ...baseStatusChanged, fromStatus: 1 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "fromStatus" must be a string')
    setPayload(statusChanged.sequenceNo, { ...baseStatusChanged, toStatus: 'SPICED' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "toStatus" is not a work item status: "SPICED"')
    db.close()
  })

  it('replays a project without events to an empty projection', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    expect(replayProjectEvents(db, brandString<ProjectId>('fresh'))).toEqual({
      planVersions: new Map(),
      workItems: new Map(),
      leases: new Map(),
      workPackets: new Map(),
      decisionRequests: new Map(),
      decisions: new Map(),
      approvals: new Map(),
      resourceRequirements: new Map(),
      resourceInstances: new Map(),
      resourceVerifications: new Map(),
      actors: new Map(),
      roles: new Map(),
      actorRoles: new Map(),
      workAssignments: new Map(),
      handoffs: new Map(),
      scopeReservations: new Map(),
      conflicts: new Map(),
    })
    db.close()
  })

  it('replays the decision domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'v1.6b-entry',
      title: 'Enter v1.6b',
      question: 'Does the ledger carry real value?',
      context: '§33 evidence briefing',
      blockingLevel: 'BLOCKING',
      planVersionId: brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1'),
      raisedBy: 'owner',
      options: [
        { optionKey: 'enter', label: 'Enter v1.6b', recommended: true },
        { optionKey: 'wait', label: 'Keep accumulating' },
      ],
    }, { nowMs: 20, actorRef: 'tester' })
    recordDecision(db, request.requestId, {
      decidedBy: 'owner',
      selectedOptionKey: 'enter',
      decisionText: 'Enter v1.6b now.',
      rationale: '26 items, five versions, zero drift',
    }, { nowMs: 21, actorRef: 'tester' })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.decisionRequests.get(request.requestId)).toEqual({
      decisionKey: 'v1.6b-entry',
      optionKeys: new Set(['enter', 'wait']),
      status: 'RESOLVED',
    })
    expect([...replayed.decisions.values()]).toEqual([
      { requestId: request.requestId, decidedBy: 'owner' },
    ])
    db.close()
  })

  it('fails replay on a decision recorded for an unknown request', async () => {
    const db = await goldenLedger()
    const ghost = brandString<DecisionRequestId>('dr:mini-dsh:ghost')
    appendProjectEvent(db, PROJECT, 'decision/recorded', {
      requestId: ghost,
      decisionId: brandString<DecisionId>(`dc:${ghost}:1`),
      decidedBy: 'owner',
      decisionText: 'nothing to resolve',
      resolvedAtMs: 1,
    }, { entityType: 'decision_request', entityId: ghost, nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`payload field "requestId" names no replayed decision request (${ghost})`)
    db.close()
  })

  it('fails replay on a decision selecting an option the request does not carry', async () => {
    const db = await goldenLedger()
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'no-options',
      title: 'Open-ended',
      question: 'Free text?',
      blockingLevel: 'ADVISORY',
      options: [{ optionKey: 'a', label: 'A' }],
    }, { nowMs: 20, actorRef: 'tester' })
    appendProjectEvent(db, PROJECT, 'decision/recorded', {
      requestId: request.requestId,
      decisionId: brandString<DecisionId>(`dc:${request.requestId}:1`),
      decidedBy: 'owner',
      selectedOptionKey: 'alien',
      decisionText: 'picked nothing',
      resolvedAtMs: 1,
    }, { entityType: 'decision_request', entityId: request.requestId, nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "selectedOptionKey" names no option of decision request')
    db.close()
  })

  it('fails replay on a decision request resolved twice', async () => {
    const db = await goldenLedger()
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'once-only',
      title: 'Once',
      question: 'Resolved once?',
      blockingLevel: 'BLOCKING',
    }, { nowMs: 20, actorRef: 'tester' })
    for (const sequence of [1, 2]) {
      appendProjectEvent(db, PROJECT, 'decision/recorded', {
        requestId: request.requestId,
        decisionId: brandString<DecisionId>(`dc:${request.requestId}:${sequence}`),
        decidedBy: 'owner',
        decisionText: 'again',
        resolvedAtMs: sequence,
      }, { entityType: 'decision_request', entityId: request.requestId, nowMs: 2 + sequence })
    }
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`resolves decision request "${request.requestId}" twice in this timeline`)
    db.close()
  })

  it('fails replay on decision payloads with missing, mistyped, or invalid fields', async () => {
    const db = await goldenLedger()
    const baseRequested: Record<string, unknown> = {
      requestId: 'dr:mini-dsh:payload',
      decisionKey: 'payload',
      title: 'Payload probe',
      question: 'Which fields decode?',
      blockingLevel: 'BLOCKING',
      options: [{ optionKey: 'a', label: 'A', recommended: false, ordinal: 0 }],
    }
    const baseRecorded: Record<string, unknown> = {
      requestId: 'dr:mini-dsh:payload',
      decisionId: 'dc:dr:mini-dsh:payload:1',
      decidedBy: 'owner',
      decisionText: 'recorded',
      resolvedAtMs: 5,
    }
    const requested = appendProjectEvent(db, PROJECT, 'decision/requested', baseRequested, {
      entityType: 'decision_request',
      entityId: 'dr:mini-dsh:payload',
      nowMs: 2,
    })
    const recorded = appendProjectEvent(db, PROJECT, 'decision/recorded', baseRecorded, {
      entityType: 'decision_request',
      entityId: 'dr:mini-dsh:payload',
      nowMs: 3,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }

    for (const field of ['requestId', 'decisionKey', 'title', 'question', 'blockingLevel', 'options']) {
      const payload = Object.fromEntries(Object.entries(baseRequested).filter(([key]) => key !== field))
      setPayload(requested.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(requested.sequenceNo, { ...baseRequested, blockingLevel: 'SUGGESTIVE' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "blockingLevel" is not a decision blocking level: "SUGGESTIVE"')
    setPayload(requested.sequenceNo, { ...baseRequested, options: 'spice' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "options" must be an array')
    setPayload(requested.sequenceNo, { ...baseRequested, options: [42] })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "options[0]" must be an object')
    const firstOption = (baseRequested.options as Record<string, unknown>[])[0] as Record<string, unknown>
    if (firstOption === undefined) throw new Error('test setup: the base payload carries no option')
    setPayload(requested.sequenceNo, { ...baseRequested, options: [{ ...firstOption, recommended: 1 }] })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "options[0].recommended" must be a boolean')
    setPayload(requested.sequenceNo, { ...baseRequested, planVersionId: 'plv:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "planVersionId" names no replayed plan version (plv:mini-dsh:ghost)')
    setPayload(requested.sequenceNo, baseRequested)

    for (const field of ['requestId', 'decisionId', 'decidedBy', 'decisionText', 'resolvedAtMs']) {
      const payload = Object.fromEntries(Object.entries(baseRecorded).filter(([key]) => key !== field))
      setPayload(recorded.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(recorded.sequenceNo, baseRecorded)
    db.close()
  })

  it('replays the approval domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const approval = requestApproval(db, PROJECT, {
      subjectType: 'plan-version',
      subjectId: 'plv:mini-dsh-v1.6a-ledger:v1',
      requiredRole: 'owner',
      requestedBy: 'owner',
    }, { nowMs: 20, actorRef: 'tester' })
    decideApproval(db, approval.approvalId, {
      outcome: 'APPROVED',
      decidedBy: 'owner',
      decisionText: 'The v1.6b plan runs.',
    }, { nowMs: 21, actorRef: 'tester' })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.approvals.get(approval.approvalId)).toEqual({
      subjectType: 'plan-version',
      subjectId: 'plv:mini-dsh-v1.6a-ledger:v1',
      status: 'APPROVED',
      decidedBy: 'owner',
    })
    db.close()
  })

  it('fails replay on an approval requested for an unknown subject, of any subject kind', async () => {
    const db = await goldenLedger()
    for (const [subjectType, subjectId] of [
      ['plan-version', 'plv:mini-dsh:GHOST'],
      ['work-item', 'wi:mini-dsh:GHOST'],
      ['decision', 'dc:dr:mini-dsh:GHOST:1'],
    ] as const) {
      appendProjectEvent(db, PROJECT, 'approval/requested', {
        approvalId: 'ap:mini-dsh:ghost',
        subjectType,
        subjectId,
      }, { entityType: 'approval', entityId: 'ap:mini-dsh:ghost', nowMs: 2 })
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
        .toContain(`payload field "subjectId" names no replayed ${subjectType} of this timeline (${subjectId})`)
      db.prepare('DELETE FROM project_events WHERE sequence_no = 17').run()
    }
    db.close()
  })

  it('fails replay on an approval decided before any request', async () => {
    const db = await goldenLedger()
    const ghost = brandString<ApprovalId>('ap:mini-dsh:ghost')
    appendProjectEvent(db, PROJECT, 'approval/decided', {
      approvalId: ghost,
      outcome: 'APPROVED',
      decidedBy: 'owner',
      decisionText: 'nothing requested',
      decidedAtMs: 1,
    }, { entityType: 'approval', entityId: ghost, nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`payload field "approvalId" names no replayed approval (${ghost})`)
    db.close()
  })

  it('fails replay on an approval decided twice', async () => {
    const db = await goldenLedger()
    const approval = requestApproval(db, PROJECT, {
      subjectType: 'plan-version', subjectId: 'plv:mini-dsh-v1.6a-ledger:v1',
    }, { nowMs: 20, actorRef: 'tester' })
    for (const sequence of [1, 2]) {
      appendProjectEvent(db, PROJECT, 'approval/decided', {
        approvalId: approval.approvalId,
        outcome: 'APPROVED',
        decidedBy: 'owner',
        decisionText: 'again',
        decidedAtMs: sequence,
      }, { entityType: 'approval', entityId: approval.approvalId, nowMs: 2 + sequence })
    }
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`decides approval "${approval.approvalId}" twice in this timeline`)
    db.close()
  })

  it('replays the resource domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const requirement = openResourceRequirement(db, PROJECT, {
      requirementKey: 'persistent-ledger',
      requirementKind: 'ENVIRONMENT',
      name: 'Persistent ledger file',
      constraintsJson: '{"journal":"wal"}',
      requestedFrom: 'owner',
      planVersionId: brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1'),
    }, { nowMs: 20, actorRef: 'tester' })
    const instance = provideResourceInstance(db, {
      requirementId: requirement.requirementId,
      label: 'ledger.sqlite',
      provider: 'host',
      metadataJson: '{"path":"~/.dsh"}',
    }, { nowMs: 21, actorRef: 'tester' })
    verifyResourceInstance(db, instance.instanceId, {
      verifierKind: 'TEST',
      verifier: 'lane',
      verificationSpec: 'replay audit reports zero drift',
      observedJson: '{"drift":0}',
      result: 'PASS',
    }, { nowMs: 22, actorRef: 'tester' })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.resourceRequirements.get(requirement.requirementId)).toEqual({
      requirementKey: 'persistent-ledger',
      requirementKind: 'ENVIRONMENT',
      name: 'Persistent ledger file',
      status: 'OPEN',
    })
    expect(replayed.resourceInstances.get(instance.instanceId)).toEqual({
      requirementId: requirement.requirementId,
      label: 'ledger.sqlite',
      status: 'AVAILABLE',
    })
    expect([...replayed.resourceVerifications.values()]).toEqual([
      { instanceId: instance.instanceId, result: 'PASS' },
    ])
    db.close()
  })

  it('fails replay on resource events naming unreplayed entities', async () => {
    const db = await goldenLedger()
    appendProjectEvent(db, PROJECT, 'resource/provided', {
      instanceId: 'ri:mini-dsh:ghost',
      requirementId: 'rr:mini-dsh:ghost',
      label: 'orphan',
    }, { entityType: 'resource_instance', entityId: 'ri:mini-dsh:ghost', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "requirementId" names no replayed resource requirement (rr:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 17').run()

    appendProjectEvent(db, PROJECT, 'resource/verified', {
      verificationId: 'rv:ghost:1',
      instanceId: 'ri:mini-dsh:ghost',
      verifierKind: 'TEST',
      verificationSpec: 'x',
      result: 'PASS',
      verifiedAtMs: 1,
    }, { entityType: 'resource_verification', entityId: 'rv:ghost:1', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "instanceId" names no replayed resource instance (ri:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 17').run()

    appendProjectEvent(db, PROJECT, 'resource/required', {
      requirementId: 'rr:mini-dsh:foreign',
      requirementKey: 'foreign',
      requirementKind: 'K',
      name: 'N',
      constraintsJson: '{}',
      planVersionId: 'plv:mini-dsh:ghost',
    }, { entityType: 'resource_requirement', entityId: 'rr:mini-dsh:foreign', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "planVersionId" names no replayed plan version (plv:mini-dsh:ghost)')
    db.close()
  })

  it('fails replay on resource payloads with missing, mistyped, or invalid fields', async () => {
    const db = await goldenLedger()
    const baseRequired: Record<string, unknown> = {
      requirementId: 'rr:mini-dsh:payload',
      requirementKey: 'payload',
      requirementKind: 'ENVIRONMENT',
      name: 'Payload probe',
      constraintsJson: '{}',
    }
    const required = appendProjectEvent(db, PROJECT, 'resource/required', baseRequired, {
      entityType: 'resource_requirement',
      entityId: 'rr:mini-dsh:payload',
      nowMs: 2,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }
    for (const field of ['requirementId', 'requirementKey', 'requirementKind', 'name', 'constraintsJson']) {
      const payload = Object.fromEntries(Object.entries(baseRequired).filter(([key]) => key !== field))
      setPayload(required.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(required.sequenceNo, { ...baseRequired, requestedFrom: 7 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "requestedFrom" must be a string')
    db.prepare('DELETE FROM project_events WHERE sequence_no = ?').run(required.sequenceNo)

    const requirement = openResourceRequirement(db, PROJECT, {
      requirementKey: 'host', requirementKind: 'K', name: 'N', constraintsJson: '{}',
    }, { nowMs: 10, actorRef: 'tester' })
    const instance = provideResourceInstance(db, {
      requirementId: requirement.requirementId, label: 'inst',
    }, { nowMs: 11, actorRef: 'tester' })
    const baseProvided: Record<string, unknown> = {
      instanceId: instance.instanceId,
      requirementId: requirement.requirementId,
      label: 'inst',
    }
    const provided = appendProjectEvent(db, PROJECT, 'resource/provided', baseProvided, {
      entityType: 'resource_instance',
      entityId: instance.instanceId,
      nowMs: 12,
    })
    for (const field of ['instanceId', 'requirementId', 'label']) {
      const payload = Object.fromEntries(Object.entries(baseProvided).filter(([key]) => key !== field))
      setPayload(provided.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(provided.sequenceNo, { ...baseProvided, metadataJson: 9 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "metadataJson" must be a string')
    db.prepare('DELETE FROM project_events WHERE sequence_no = ?').run(provided.sequenceNo)

    const baseVerified: Record<string, unknown> = {
      verificationId: 'rv:payload:1',
      instanceId: instance.instanceId,
      verifierKind: 'TEST',
      verificationSpec: 'x',
      result: 'PASS',
      verifiedAtMs: 5,
    }
    const verified = appendProjectEvent(db, PROJECT, 'resource/verified', baseVerified, {
      entityType: 'resource_verification',
      entityId: 'rv:payload:1',
      nowMs: 13,
    })
    for (const field of ['verificationId', 'instanceId', 'verifierKind', 'verificationSpec', 'result', 'verifiedAtMs']) {
      const payload = Object.fromEntries(Object.entries(baseVerified).filter(([key]) => key !== field))
      setPayload(verified.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(verified.sequenceNo, { ...baseVerified, verifierKind: 'TELEPORT' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "verifierKind" is not a resource verifier kind: "TELEPORT"')
    setPayload(verified.sequenceNo, { ...baseVerified, result: 'MAYBE' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "result" is not a resource verification result: "MAYBE"')
    setPayload(verified.sequenceNo, baseVerified)
    db.close()
  })

  it('fails replay on approval payloads with missing, mistyped, or invalid fields', async () => {    const db = await goldenLedger()
    const baseRequested: Record<string, unknown> = {
      approvalId: 'ap:mini-dsh:payload',
      subjectType: 'plan-version',
      subjectId: 'plv:mini-dsh-v1.6a-ledger:v1',
    }
    const baseDecided: Record<string, unknown> = {
      approvalId: 'ap:mini-dsh:payload',
      outcome: 'APPROVED',
      decidedBy: 'owner',
      decisionText: 'recorded',
      decidedAtMs: 5,
    }
    const requested = appendProjectEvent(db, PROJECT, 'approval/requested', baseRequested, {
      entityType: 'approval',
      entityId: 'ap:mini-dsh:payload',
      nowMs: 2,
    })
    const decided = appendProjectEvent(db, PROJECT, 'approval/decided', baseDecided, {
      entityType: 'approval',
      entityId: 'ap:mini-dsh:payload',
      nowMs: 3,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }

    for (const field of ['approvalId', 'subjectType', 'subjectId']) {
      const payload = Object.fromEntries(Object.entries(baseRequested).filter(([key]) => key !== field))
      setPayload(requested.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(requested.sequenceNo, { ...baseRequested, subjectType: 'pull-request' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "subjectType" is not an approval subject type: "pull-request"')
    setPayload(requested.sequenceNo, { ...baseRequested, requestedBy: 7 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "requestedBy" must be a string')
    setPayload(requested.sequenceNo, baseRequested)

    for (const field of ['approvalId', 'outcome', 'decidedBy', 'decisionText', 'decidedAtMs']) {
      const payload = Object.fromEntries(Object.entries(baseDecided).filter(([key]) => key !== field))
      setPayload(decided.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(decided.sequenceNo, { ...baseDecided, outcome: 'DEFERRED' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "outcome" is not an approval outcome: "DEFERRED"')
    setPayload(decided.sequenceNo, baseDecided)
    db.close()
  })

  it('replays the actor/role domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const owner = registerActor(db, PROJECT, {
      actorKey: 'owner',
      actorKind: 'HUMAN',
      displayName: 'Owner',
      externalIdentity: 'lincoln@local',
      metadataJson: '{"gate":"go"}',
    }, { nowMs: 20, actorRef: 'tester' })
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 21, actorRef: 'tester' })
    const ownerRole = defineRole(db, PROJECT, {
      roleName: 'owner', roleKind: 'GOVERNANCE', description: 'gates the ledger',
    }, { nowMs: 22, actorRef: 'tester' })
    const executorRole = defineRole(db, PROJECT, {
      roleName: 'executor', roleKind: 'EXECUTION',
    }, { nowMs: 23, actorRef: 'tester' })
    assignRole(db, { actorId: owner.actorId, roleId: ownerRole.roleId }, { nowMs: 24, actorRef: 'tester' })
    assignRole(db, { actorId: lane.actorId, roleId: executorRole.roleId }, { nowMs: 25, actorRef: 'tester' })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.actors.get(owner.actorId)).toEqual({
      actorKey: 'owner',
      actorKind: 'HUMAN',
      displayName: 'Owner',
      status: 'ACTIVE',
    })
    expect(replayed.actors.get(lane.actorId)).toEqual({
      actorKey: 'lane',
      actorKind: 'AGENT',
      displayName: 'Lane',
      status: 'ACTIVE',
    })
    expect(replayed.roles.get(ownerRole.roleId)).toEqual({ roleName: 'owner', roleKind: 'GOVERNANCE' })
    expect(replayed.roles.get(executorRole.roleId)).toEqual({ roleName: 'executor', roleKind: 'EXECUTION' })
    expect(replayed.actorRoles.get(brandString<ActorRoleId>('asg:mini-dsh:21'))).toEqual({
      actorId: owner.actorId,
      roleId: ownerRole.roleId,
      validToMs: undefined,
    })
    db.close()
  })

  it('fails replay on role/assigned events naming unreplayed entities', async () => {
    const db = await goldenLedger()
    appendProjectEvent(db, PROJECT, 'role/assigned', {
      assignmentId: 'asg:mini-dsh:ghost',
      actorId: 'actor:mini-dsh:ghost',
      roleId: 'role:mini-dsh:ghost',
    }, { entityType: 'actor_role', entityId: 'asg:mini-dsh:ghost', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "actorId" names no replayed actor (actor:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 17').run()

    const owner = registerActor(db, PROJECT, {
      actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
    }, { nowMs: 10, actorRef: 'tester' })
    appendProjectEvent(db, PROJECT, 'role/assigned', {
      assignmentId: 'asg:mini-dsh:ghost',
      actorId: owner.actorId,
      roleId: 'role:mini-dsh:ghost',
    }, { entityType: 'actor_role', entityId: 'asg:mini-dsh:ghost', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "roleId" names no replayed role (role:mini-dsh:ghost)')
    db.close()
  })

  it('fails replay on a role assigned while a live assignment already holds it', async () => {
    const db = await goldenLedger()
    const owner = registerActor(db, PROJECT, {
      actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
    }, { nowMs: 10, actorRef: 'tester' })
    const role = defineRole(db, PROJECT, { roleName: 'owner', roleKind: 'GOVERNANCE' }, { nowMs: 11, actorRef: 'tester' })
    assignRole(db, { actorId: owner.actorId, roleId: role.roleId }, { nowMs: 12, actorRef: 'tester' })
    appendProjectEvent(db, PROJECT, 'role/assigned', {
      assignmentId: 'asg:mini-dsh:19',
      actorId: owner.actorId,
      roleId: role.roleId,
    }, { entityType: 'actor_role', entityId: 'asg:mini-dsh:19', nowMs: 3 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`assigns actor "${owner.actorId}" to role "${role.roleId}" while live assignment`)
    db.close()
  })

  it('fails replay on actor and role payloads with missing, mistyped, or invalid fields', async () => {
    const db = await goldenLedger()
    const baseRegistered: Record<string, unknown> = {
      actorId: 'actor:mini-dsh:payload',
      actorKey: 'payload',
      actorKind: 'HUMAN',
      displayName: 'Payload probe',
    }
    const registered = appendProjectEvent(db, PROJECT, 'actor/registered', baseRegistered, {
      entityType: 'actor',
      entityId: 'actor:mini-dsh:payload',
      nowMs: 2,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }
    for (const field of ['actorId', 'actorKey', 'actorKind', 'displayName']) {
      const payload = Object.fromEntries(Object.entries(baseRegistered).filter(([key]) => key !== field))
      setPayload(registered.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(registered.sequenceNo, { ...baseRegistered, externalIdentity: 7 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "externalIdentity" must be a string')
    setPayload(registered.sequenceNo, { ...baseRegistered, actorKind: 'TELEPORT' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "actorKind" is not an actor kind: "TELEPORT"')
    db.prepare('DELETE FROM project_events WHERE sequence_no = ?').run(registered.sequenceNo)

    const baseDefined: Record<string, unknown> = {
      roleId: 'role:mini-dsh:payload',
      roleName: 'payload',
      roleKind: 'GOVERNANCE',
    }
    const defined = appendProjectEvent(db, PROJECT, 'role/defined', baseDefined, {
      entityType: 'role',
      entityId: 'role:mini-dsh:payload',
      nowMs: 2,
    })
    for (const field of ['roleId', 'roleName', 'roleKind']) {
      const payload = Object.fromEntries(Object.entries(baseDefined).filter(([key]) => key !== field))
      setPayload(defined.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(defined.sequenceNo, { ...baseDefined, description: 7 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "description" must be a string')
    setPayload(defined.sequenceNo, { ...baseDefined, roleKind: 'DECORATIVE' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "roleKind" is not a role kind: "DECORATIVE"')
    setPayload(defined.sequenceNo, baseDefined)

    const owner = registerActor(db, PROJECT, {
      actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
    }, { nowMs: 10, actorRef: 'tester' })
    const baseAssigned: Record<string, unknown> = {
      assignmentId: 'asg:mini-dsh:19',
      actorId: owner.actorId,
      roleId: 'role:mini-dsh:payload',
    }
    const assigned = appendProjectEvent(db, PROJECT, 'role/assigned', baseAssigned, {
      entityType: 'actor_role',
      entityId: 'asg:mini-dsh:19',
      nowMs: 3,
    })
    for (const field of ['assignmentId', 'actorId', 'roleId']) {
      const payload = Object.fromEntries(Object.entries(baseAssigned).filter(([key]) => key !== field))
      setPayload(assigned.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(assigned.sequenceNo, baseAssigned)
    db.close()
  })

  it('replays work/assigned events with the item, actor, and role resolved', async () => {
    const db = await goldenLedger()
    const actor = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const role = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 11, actorRef: 'tester' })
    const item = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    appendProjectEvent(db, PROJECT, 'work/assigned', {
      assignmentId: 'wa:mini-dsh:19',
      workItemId: item,
      actorId: actor.actorId,
      roleId: role.roleId,
      assignmentKind: 'PRIMARY',
    }, { entityType: 'work_assignment', entityId: 'wa:mini-dsh:19', nowMs: 4 })
    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed.workAssignments.get(brandString<WorkAssignmentId>('wa:mini-dsh:19'))).toEqual({
      workItemId: item,
      actorId: actor.actorId,
      roleId: role.roleId,
      assignmentKind: 'PRIMARY',
      status: 'ACTIVE',
    })
    appendProjectEvent(db, PROJECT, 'work/assigned', {
      assignmentId: 'wa:mini-dsh:20',
      workItemId: item,
      actorId: actor.actorId,
      assignmentKind: 'REVIEWER',
    }, { entityType: 'work_assignment', entityId: 'wa:mini-dsh:20', nowMs: 5 })
    expect(replayProjectEvents(db, PROJECT).workAssignments.get(brandString<WorkAssignmentId>('wa:mini-dsh:20'))).toEqual({
      workItemId: item,
      actorId: actor.actorId,
      roleId: undefined,
      assignmentKind: 'REVIEWER',
      status: 'ACTIVE',
    })
    db.close()
  })

  it('fails replay on work/assigned events naming unreplayed entities or a second live PRIMARY', async () => {
    const db = await goldenLedger()
    const append = (payload: Record<string, unknown>, sequence: string): void => {
      appendProjectEvent(db, PROJECT, 'work/assigned', payload, {
        entityType: 'work_assignment', entityId: sequence, nowMs: 2,
      })
    }
    append({
      assignmentId: 'wa:mini-dsh:ghost', workItemId: 'wi:mini-dsh:ghost',
      actorId: 'actor:mini-dsh:ghost', assignmentKind: 'PRIMARY',
    }, 'wa:mini-dsh:ghost')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 17').run()

    const actor = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    append({
      assignmentId: 'wa:mini-dsh:ghost', workItemId: 'wi:mini-dsh:IMPORT-001',
      actorId: actor.actorId, roleId: 'role:mini-dsh:ghost', assignmentKind: 'PRIMARY',
    }, 'wa:mini-dsh:ghost')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "roleId" names no replayed role (role:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 18').run()

    append({
      assignmentId: 'wa:mini-dsh:18', workItemId: 'wi:mini-dsh:IMPORT-001',
      actorId: actor.actorId, assignmentKind: 'PRIMARY',
    }, 'wa:mini-dsh:18')
    append({
      assignmentId: 'wa:mini-dsh:19', workItemId: 'wi:mini-dsh:SCHEMA-001',
      actorId: actor.actorId, assignmentKind: 'PRIMARY',
    }, 'wa:mini-dsh:19')
    append({
      assignmentId: 'wa:mini-dsh:20', workItemId: 'wi:mini-dsh:IMPORT-001',
      actorId: actor.actorId, assignmentKind: 'PRIMARY',
    }, 'wa:mini-dsh:20')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('assigns a second PRIMARY to work item "wi:mini-dsh:IMPORT-001" while live assignment "wa:mini-dsh:18"')
    db.close()
  })

  it('fails replay on work/assigned payloads with missing, mistyped, or invalid fields', async () => {
    const db = await goldenLedger()
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }
    const baseAssigned: Record<string, unknown> = {
      assignmentId: 'wa:mini-dsh:17',
      workItemId: 'wi:mini-dsh:IMPORT-001',
      actorId: 'actor:mini-dsh:payload',
      assignmentKind: 'PRIMARY',
    }
    const assigned = appendProjectEvent(db, PROJECT, 'work/assigned', baseAssigned, {
      entityType: 'work_assignment',
      entityId: 'wa:mini-dsh:17',
      nowMs: 2,
    })
    for (const field of ['assignmentId', 'workItemId', 'actorId', 'assignmentKind']) {
      const payload = Object.fromEntries(Object.entries(baseAssigned).filter(([key]) => key !== field))
      setPayload(assigned.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(assigned.sequenceNo, { ...baseAssigned, roleId: 7 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "roleId" must be a string')
    setPayload(assigned.sequenceNo, { ...baseAssigned, assignmentKind: 'LEAD' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "assignmentKind" is not a work-assignment kind: "LEAD"')
    setPayload(assigned.sequenceNo, baseAssigned)
    db.close()
  })

  it('replays handoff/recorded events with the sender and recipient resolved', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const second = registerActor(db, PROJECT, {
      actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
    }, { nowMs: 11, actorRef: 'tester' })
    const role = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 12, actorRef: 'tester' })
    const item = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    appendProjectEvent(db, PROJECT, 'handoff/recorded', {
      handoffId: 'ho:mini-dsh:19',
      workItemId: item,
      fromActorId: lane.actorId,
      toActorId: second.actorId,
      handoffKind: 'DELEGATE',
      summary: 'first pass',
      artifactRefsJson: '{"pr":4193}',
    }, { entityType: 'handoff', entityId: 'ho:mini-dsh:19', nowMs: 4 })
    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed.handoffs.get(brandString<HandoffId>('ho:mini-dsh:19'))).toEqual({
      workItemId: item,
      fromActorId: lane.actorId,
      toActorId: second.actorId,
      toRoleId: undefined,
      handoffKind: 'DELEGATE',
    })
    appendProjectEvent(db, PROJECT, 'handoff/recorded', {
      handoffId: 'ho:mini-dsh:20',
      workItemId: item,
      fromActorId: second.actorId,
      toRoleId: role.roleId,
      handoffKind: 'RETURN',
      summary: 'back to the role',
    }, { entityType: 'handoff', entityId: 'ho:mini-dsh:20', nowMs: 5 })
    expect(replayProjectEvents(db, PROJECT).handoffs.get(brandString<HandoffId>('ho:mini-dsh:20'))).toEqual({
      workItemId: item,
      fromActorId: second.actorId,
      toActorId: undefined,
      toRoleId: role.roleId,
      handoffKind: 'RETURN',
    })
    db.close()
  })

  it('fails replay on handoff/recorded events naming unreplayed entities', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const append = (payload: Record<string, unknown>): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'handoff/recorded', payload, {
        entityType: 'handoff', entityId: 'ho:mini-dsh:ghost', nowMs: 2,
      })
    const base: Record<string, unknown> = {
      handoffId: 'ho:mini-dsh:ghost', workItemId: 'wi:mini-dsh:IMPORT-001',
      fromActorId: lane.actorId, toActorId: lane.actorId,
      handoffKind: 'DELEGATE', summary: 's',
    }
    append({ ...base, workItemId: 'wi:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 18').run()
    append({ ...base, fromActorId: 'actor:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "actorId" names no replayed actor (actor:mini-dsh:ghost)')
    db.prepare('DELETE FROM project_events WHERE sequence_no = 18').run()
    append({ ...base, toActorId: undefined, toRoleId: 'role:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "roleId" names no replayed role (role:mini-dsh:ghost)')
    db.close()
  })

  it('fails replay on handoff payloads with missing, mistyped, or ambiguous recipients', async () => {
    const db = await goldenLedger()
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }
    const baseHandoff: Record<string, unknown> = {
      handoffId: 'ho:mini-dsh:17',
      workItemId: 'wi:mini-dsh:IMPORT-001',
      fromActorId: 'actor:mini-dsh:payload',
      toActorId: 'actor:mini-dsh:recipient',
      handoffKind: 'DELEGATE',
      summary: 'pass it on',
    }
    const handoff = appendProjectEvent(db, PROJECT, 'handoff/recorded', baseHandoff, {
      entityType: 'handoff',
      entityId: 'ho:mini-dsh:17',
      nowMs: 2,
    })
    for (const field of ['handoffId', 'workItemId', 'fromActorId', 'handoffKind', 'summary']) {
      const payload = Object.fromEntries(Object.entries(baseHandoff).filter(([key]) => key !== field))
      setPayload(handoff.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(handoff.sequenceNo, { ...baseHandoff, toActorId: 7 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "toActorId" must be a string')
    setPayload(handoff.sequenceNo, { ...baseHandoff, handoffKind: 'ESCALATE' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "handoffKind" is not a handoff kind: "ESCALATE"')
    setPayload(handoff.sequenceNo, { ...baseHandoff, toRoleId: 'role:mini-dsh:executor' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('must name exactly one handoff recipient')
    setPayload(handoff.sequenceNo, { ...baseHandoff, toActorId: undefined, toRoleId: undefined })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('must name exactly one handoff recipient')
    setPayload(handoff.sequenceNo, baseHandoff)
    db.close()
  })

  it('replays the scope-reservation domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 20, actorRef: 'tester' })
    const second = registerActor(db, PROJECT, {
      actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
    }, { nowMs: 21, actorRef: 'tester' })
    const item = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    const active = reserveScope(db, {
      workItemId: item,
      actorId: lane.actorId,
      scopeKind: 'PATH',
      scopeValue: 'packages/ledger/src',
      expiresAtMs: 900,
    }, { nowMs: 30, actorRef: 'tester' })
    reserveScope(db, {
      workItemId: item,
      actorId: second.actorId,
      scopeKind: 'PATH',
      scopeValue: 'packages/ledger/tests',
      expiresAtMs: 900,
    }, { nowMs: 31, actorRef: 'tester' })
    const released = releaseScopeReservation(db, active.reservationId, { nowMs: 32, actorRef: 'tester' })
    const reaped = reapExpiredScopeReservations(db, {
      nowMs: 41,
      actorRef: 'tester',
    })
    expect(reaped.map(entry => entry.reservationId)).toEqual([])

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.scopeReservations.get(active.reservationId)).toEqual({
      workItemId: item,
      actorId: lane.actorId,
      scopeKind: 'PATH',
      scopeValue: 'packages/ledger/src',
      expiresAtMs: 900,
      status: 'RELEASED',
    })
    expect(released.releasedAtMs).toBe(32)
    db.close()
  })

  it('replays scope reservation events through their lifecycle', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const item = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    appendProjectEvent(db, PROJECT, 'scope/reserved', {
      reservationId: 'sr:mini-dsh:17',
      workItemId: item,
      actorId: lane.actorId,
      scopeKind: 'PATH',
      scopeValue: 'src/foo.ts',
      expiresAtMs: 900,
    }, { entityType: 'scope_reservation', entityId: 'sr:mini-dsh:17', nowMs: 4 })
    expect(replayProjectEvents(db, PROJECT).scopeReservations.get(brandString<ScopeReservationId>('sr:mini-dsh:17')))
      .toEqual({
        workItemId: item,
        actorId: lane.actorId,
        scopeKind: 'PATH',
        scopeValue: 'src/foo.ts',
        expiresAtMs: 900,
        status: 'ACTIVE',
      })
    appendProjectEvent(db, PROJECT, 'scope/released', {
      reservationId: 'sr:mini-dsh:17',
    }, { entityType: 'scope_reservation', entityId: 'sr:mini-dsh:17', nowMs: 6 })
    expect(replayProjectEvents(db, PROJECT).scopeReservations.get(brandString<ScopeReservationId>('sr:mini-dsh:17')))
      .toEqual({
        workItemId: item,
        actorId: lane.actorId,
        scopeKind: 'PATH',
        scopeValue: 'src/foo.ts',
        expiresAtMs: 900,
        status: 'RELEASED',
      })
    appendProjectEvent(db, PROJECT, 'scope/reserved', {
      reservationId: 'sr:mini-dsh:19',
      workItemId: item,
      actorId: lane.actorId,
      scopeKind: 'PATH',
      scopeValue: 'src/bar.ts',
      expiresAtMs: 800,
    }, { entityType: 'scope_reservation', entityId: 'sr:mini-dsh:19', nowMs: 5 })
    appendProjectEvent(db, PROJECT, 'scope/expired', {
      reservationId: 'sr:mini-dsh:19',
    }, { entityType: 'scope_reservation', entityId: 'sr:mini-dsh:19', nowMs: 7 })
    expect(replayProjectEvents(db, PROJECT).scopeReservations.get(brandString<ScopeReservationId>('sr:mini-dsh:19')))
      .toEqual({
        workItemId: item,
        actorId: lane.actorId,
        scopeKind: 'PATH',
        scopeValue: 'src/bar.ts',
        expiresAtMs: 800,
        status: 'EXPIRED',
      })
    db.close()
  })

  it('fails replay on scope/reserved events naming unreplayed entities or a held scope', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const item = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    const append = (payload: Record<string, unknown>): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'scope/reserved', payload, {
        entityType: 'scope_reservation', entityId: 'sr:mini-dsh:ghost', nowMs: 2,
      })
    const appendReleased = (reservationId: string): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'scope/released', { reservationId }, {
        entityType: 'scope_reservation', entityId: reservationId, nowMs: 3,
      })
    const base: Record<string, unknown> = {
      reservationId: 'sr:mini-dsh:ghost', workItemId: item,
      actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/ghost.ts', expiresAtMs: 900,
    }
    const deleteLast = (): void => {
      db.prepare('DELETE FROM project_events WHERE sequence_no = (SELECT MAX(sequence_no) FROM project_events)').run()
    }
    append({ ...base, workItemId: 'wi:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:ghost)')
    deleteLast()
    append({ ...base, actorId: 'actor:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "actorId" names no replayed actor (actor:mini-dsh:ghost)')
    deleteLast()
    append(base)
    append({ ...base, reservationId: 'sr:mini-dsh:second' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('reserves PATH scope "src/ghost.ts" while active reservation "sr:mini-dsh:ghost" already holds it')
    deleteLast()
    // A released reservation frees the scope: re-reserving replays clean.
    appendReleased('sr:mini-dsh:ghost')
    append({ ...base, reservationId: 'sr:mini-dsh:again' })
    expect(replayProjectEvents(db, PROJECT).scopeReservations.size).toBe(2)
    db.close()
  })

  it('fails replay on release and expiry events naming unknown or finished reservations', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    appendProjectEvent(db, PROJECT, 'scope/reserved', {
      reservationId: 'sr:mini-dsh:twice',
      workItemId: 'wi:mini-dsh:IMPORT-001',
      actorId: lane.actorId,
      scopeKind: 'PATH',
      scopeValue: 'src/twice.ts',
      expiresAtMs: 900,
    }, { entityType: 'scope_reservation', entityId: 'sr:mini-dsh:twice', nowMs: 2 })
    const appendEnd = (eventType: 'scope/released' | 'scope/expired', reservationId: string): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, eventType, { reservationId }, {
        entityType: 'scope_reservation', entityId: reservationId, nowMs: 3,
      })
    const deleteLast = (): void => {
      db.prepare('DELETE FROM project_events WHERE sequence_no = (SELECT MAX(sequence_no) FROM project_events)').run()
    }
    appendEnd('scope/released', 'sr:mini-dsh:ghost')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "reservationId" names no replayed scope reservation (sr:mini-dsh:ghost)')
    deleteLast()
    appendEnd('scope/expired', 'sr:mini-dsh:ghost')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "reservationId" names no replayed scope reservation (sr:mini-dsh:ghost)')
    deleteLast()
    appendEnd('scope/released', 'sr:mini-dsh:twice')
    appendEnd('scope/released', 'sr:mini-dsh:twice')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('releases reservation "sr:mini-dsh:twice" that is no longer active')
    deleteLast()
    appendEnd('scope/expired', 'sr:mini-dsh:twice')
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('expires reservation "sr:mini-dsh:twice" that is no longer active')
    db.close()
  })

  it('fails replay on scope payloads with missing or mistyped fields', async () => {
    const db = await goldenLedger()
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }
    const base: Record<string, unknown> = {
      reservationId: 'sr:mini-dsh:17',
      workItemId: 'wi:mini-dsh:IMPORT-001',
      actorId: 'actor:mini-dsh:holder',
      scopeKind: 'PATH',
      scopeValue: 'src/x.ts',
      expiresAtMs: 900,
    }
    const reserved = appendProjectEvent(db, PROJECT, 'scope/reserved', base, {
      entityType: 'scope_reservation', entityId: 'sr:mini-dsh:17', nowMs: 2,
    })
    for (const field of ['reservationId', 'workItemId', 'actorId', 'scopeKind', 'scopeValue', 'expiresAtMs']) {
      const payload = Object.fromEntries(Object.entries(base).filter(([key]) => key !== field))
      setPayload(reserved.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(reserved.sequenceNo, { ...base, scopeKind: 'HOST' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "scopeKind" is not a scope-reservation kind: "HOST"')
    setPayload(reserved.sequenceNo, { ...base, expiresAtMs: 'soon' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "expiresAtMs" must be a number')
    setPayload(reserved.sequenceNo, base)
    db.close()
  })

  it('replays the collaboration-conflict domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 20, actorRef: 'tester' })
    const itemA = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    const itemB = brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001')
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'overlap-ruling',
      title: 'Overlap ruling',
      question: 'Who keeps the overlapping path?',
      blockingLevel: 'BLOCKING',
      raisedBy: 'owner',
    }, { nowMs: 21, actorRef: 'tester' })
    const decision = recordDecision(db, request.requestId, {
      decidedBy: 'owner',
      decisionText: 'Lane keeps the path; Second takes the sibling directory.',
    }, { nowMs: 22, actorRef: 'tester' })
    const conflict = recordConflict(db, {
      workItemAId: itemA,
      workItemBId: itemB,
      raisedByActorId: lane.actorId,
      conflictKind: 'SCOPE_OVERLAP',
      description: 'src/one.ts sits inside the reserved src/ tree; the equal-value check did not judge it.',
    }, { nowMs: 30, actorRef: 'tester' })
    const resolved = resolveConflict(db, conflict.conflictId, decision.decisionId, { nowMs: 31, actorRef: 'tester' })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.conflicts.get(conflict.conflictId)).toEqual({
      workItemAId: itemA,
      workItemBId: itemB,
      raisedByActorId: lane.actorId,
      conflictKind: 'SCOPE_OVERLAP',
      description: 'src/one.ts sits inside the reserved src/ tree; the equal-value check did not judge it.',
      status: 'RESOLVED',
      resolutionDecisionId: decision.decisionId,
    })
    expect(resolved.resolvedAtMs).toBe(31)
    db.close()
  })

  it('replays conflict events through their lifecycle', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'raw-ruling',
      title: 'Raw ruling',
      question: 'Which stream yields?',
      blockingLevel: 'ADVISORY',
      raisedBy: 'owner',
    }, { nowMs: 11, actorRef: 'tester' })
    const decision = recordDecision(db, request.requestId, {
      decidedBy: 'owner',
      decisionText: 'The first stream yields.',
    }, { nowMs: 12, actorRef: 'tester' })
    const itemA = brandString<WorkItemId>('wi:mini-dsh:IMPORT-001')
    const itemB = brandString<WorkItemId>('wi:mini-dsh:DB-001')
    appendProjectEvent(db, PROJECT, 'conflict/recorded', {
      conflictId: 'cf:mini-dsh:raw',
      workItemAId: itemA,
      workItemBId: itemB,
      raisedByActorId: lane.actorId,
      conflictKind: 'SCOPE_OVERLAP',
      description: 'raw lifecycle',
    }, { entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:raw', nowMs: 4 })
    expect(replayProjectEvents(db, PROJECT).conflicts.get(brandString<ConflictId>('cf:mini-dsh:raw')))
      .toEqual({
        workItemAId: itemA,
        workItemBId: itemB,
        raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP',
        description: 'raw lifecycle',
        status: 'OPEN',
        resolutionDecisionId: undefined,
      })
    appendProjectEvent(db, PROJECT, 'conflict/resolved', {
      conflictId: 'cf:mini-dsh:raw',
      resolutionDecisionId: decision.decisionId,
    }, { entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:raw', nowMs: 6 })
    expect(replayProjectEvents(db, PROJECT).conflicts.get(brandString<ConflictId>('cf:mini-dsh:raw')))
      .toEqual({
        workItemAId: itemA,
        workItemBId: itemB,
        raisedByActorId: lane.actorId,
        conflictKind: 'SCOPE_OVERLAP',
        description: 'raw lifecycle',
        status: 'RESOLVED',
        resolutionDecisionId: decision.decisionId,
      })
    db.close()
  })

  it('fails replay on conflict/recorded events naming unreplayed entities', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const base: Record<string, unknown> = {
      conflictId: 'cf:mini-dsh:ghost',
      workItemAId: 'wi:mini-dsh:IMPORT-001',
      workItemBId: 'wi:mini-dsh:DB-001',
      raisedByActorId: lane.actorId,
      conflictKind: 'SCOPE_OVERLAP',
      description: 'ghost hunt',
    }
    const append = (payload: Record<string, unknown>): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'conflict/recorded', payload, {
        entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:ghost', nowMs: 2,
      })
    const deleteLast = (): void => {
      db.prepare('DELETE FROM project_events WHERE sequence_no = (SELECT MAX(sequence_no) FROM project_events)').run()
    }
    append({ ...base, workItemAId: 'wi:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:ghost)')
    deleteLast()
    append({ ...base, workItemBId: 'wi:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:ghost)')
    deleteLast()
    append({ ...base, raisedByActorId: 'actor:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "actorId" names no replayed actor (actor:mini-dsh:ghost)')
    db.close()
  })

  it('fails replay on resolution events naming unknown referents or finished conflicts', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'twice-ruling',
      title: 'Twice ruling',
      question: 'Who yields?',
      blockingLevel: 'ADVISORY',
      raisedBy: 'owner',
    }, { nowMs: 11, actorRef: 'tester' })
    const decision = recordDecision(db, request.requestId, {
      decidedBy: 'owner',
      decisionText: 'The second stream yields.',
    }, { nowMs: 12, actorRef: 'tester' })
    appendProjectEvent(db, PROJECT, 'conflict/recorded', {
      conflictId: 'cf:mini-dsh:twice',
      workItemAId: 'wi:mini-dsh:IMPORT-001',
      workItemBId: 'wi:mini-dsh:DB-001',
      raisedByActorId: lane.actorId,
      conflictKind: 'SCOPE_OVERLAP',
      description: 'resolved once only',
    }, { entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:twice', nowMs: 2 })
    const appendResolved = (payload: Record<string, unknown>): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'conflict/resolved', payload, {
        entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:twice', nowMs: 3,
      })
    const deleteLast = (): void => {
      db.prepare('DELETE FROM project_events WHERE sequence_no = (SELECT MAX(sequence_no) FROM project_events)').run()
    }
    appendResolved({ conflictId: 'cf:mini-dsh:ghost', resolutionDecisionId: decision.decisionId })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "conflictId" names no replayed collaboration conflict (cf:mini-dsh:ghost)')
    deleteLast()
    appendResolved({ conflictId: 'cf:mini-dsh:twice', resolutionDecisionId: 'dc:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "resolutionDecisionId" names no replayed decision (dc:mini-dsh:ghost)')
    deleteLast()
    appendResolved({ conflictId: 'cf:mini-dsh:twice', resolutionDecisionId: decision.decisionId })
    appendResolved({ conflictId: 'cf:mini-dsh:twice', resolutionDecisionId: decision.decisionId })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('resolves conflict "cf:mini-dsh:twice" that is no longer open')
    db.close()
  })

  it('fails replay on conflict payloads with missing or mistyped fields', async () => {
    const db = await goldenLedger()
    const lane = registerActor(db, PROJECT, {
      actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
    }, { nowMs: 10, actorRef: 'tester' })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }
    const base: Record<string, unknown> = {
      conflictId: 'cf:mini-dsh:17',
      workItemAId: 'wi:mini-dsh:IMPORT-001',
      workItemBId: 'wi:mini-dsh:DB-001',
      raisedByActorId: lane.actorId,
      conflictKind: 'SCOPE_OVERLAP',
      description: 'payload check',
    }
    const recorded = appendProjectEvent(db, PROJECT, 'conflict/recorded', base, {
      entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:17', nowMs: 2,
    })
    for (const field of ['conflictId', 'workItemAId', 'workItemBId', 'raisedByActorId', 'conflictKind', 'description']) {
      const payload = Object.fromEntries(Object.entries(base).filter(([key]) => key !== field))
      setPayload(recorded.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(recorded.sequenceNo, { ...base, conflictKind: 'ITEM_OVERLAP' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "conflictKind" is not a conflict kind: "ITEM_OVERLAP"')
    setPayload(recorded.sequenceNo, base)

    const resolvedBase: Record<string, unknown> = {
      conflictId: 'cf:mini-dsh:17',
      resolutionDecisionId: 'dc:dr:mini-dsh:pinned:2',
    }
    const resolved = appendProjectEvent(db, PROJECT, 'conflict/resolved', resolvedBase, {
      entityType: 'collaboration_conflict', entityId: 'cf:mini-dsh:17', nowMs: 3,
    })
    for (const field of ['conflictId', 'resolutionDecisionId']) {
      const payload = Object.fromEntries(Object.entries(resolvedBase).filter(([key]) => key !== field))
      setPayload(resolved.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(resolved.sequenceNo, resolvedBase)
    db.close()
  })
})
