/**
 * The ledger's replay audit: one read-only pass that folds a project's event
 * timeline through the fail-closed replay codec and compares the rebuilt
 * projection with the materialized tables, entity family by entity family
 * and in both directions — a row nothing replays and a replay nothing
 * materializes are both drift. Work packets compare against no table: the
 * recorded recipe is the packet's whole durable record, so they count on the
 * replayed side only. When this build cannot decode the timeline, the audit
 * reports why and skips the comparison instead of half-reading it. The audit
 * never mutates and never executes a verifier command.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/project-replay
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId, ActorRoleId, RoleId } from './actors.js'
import type { ApprovalId } from './approvals.js'
import type { DecisionId, DecisionRequestId } from './decisions.js'
import type { HandoffId } from './handoffs.js'
import type { WorkLeaseId } from './lease.js'
import type { AcceptanceCriterionId, PlanVersionId, ProjectId, WorkItemId } from './plan-compile.js'
import type { ResourceInstanceId, ResourceRequirementId, ResourceVerificationId } from './resources.js'
import type { ScopeReservationId } from './scope-reservations.js'
import type { WorkAssignmentId } from './work-assignments.js'
import { replayProjectEvents, type ReplayedProjectProjection } from './project-events.js'

/** One replay-audit finding: the rebuilt projection and the materialized rows disagree. */
export interface ProjectReplayDrift {
  /** Ledger id of the row or replayed entity the finding names. */
  readonly refId: string
  /** The concrete, caller-displayable finding. */
  readonly message: string
}

/** Entity counts of one side of the replay comparison. */
export interface ProjectReplayEntityCounts {
  readonly planVersions: number
  readonly workItems: number
  readonly criteria: number
  readonly leases: number
  readonly decisionRequests: number
  readonly decisions: number
  readonly approvals: number
  readonly resourceRequirements: number
  readonly resourceInstances: number
  readonly resourceVerifications: number
  readonly actors: number
  readonly roles: number
  readonly actorRoles: number
  readonly workAssignments: number
  readonly handoffs: number
  readonly scopeReservations: number
}

/** What the fold rebuilt, plus the packet recipes that have no materialized table. */
export interface ReplayedEntityCounts extends ProjectReplayEntityCounts {
  /** Prepared packet recipes the timeline replays; the recorded recipe is the packet's whole durable record. */
  readonly workPackets: number
}

/** The replay audit's outcome when the timeline decoded and parity was compared. */
export interface ProjectReplayCompared {
  readonly outcome: 'compared'
  /** Project whose timeline was audited. */
  readonly projectId: ProjectId
  /** Rows in the project's event timeline, ignorable rows included. */
  readonly eventCount: number
  /** The timeline's highest sequence number; `0` when the project records no event. */
  readonly lastSequenceNo: number
  readonly replayed: ReplayedEntityCounts
  readonly materialized: ProjectReplayEntityCounts
  /** Every drift finding, versions, items, criteria, then leases; empty exactly when both sides agree. */
  readonly drift: readonly ProjectReplayDrift[]
}

/** The replay audit's outcome when this build cannot decode the timeline. */
export interface ProjectReplayUndecodable {
  readonly outcome: 'undecodable'
  /** Project whose timeline was audited. */
  readonly projectId: ProjectId
  /** Rows in the project's event timeline, ignorable rows included. */
  readonly eventCount: number
  /** The timeline's highest sequence number; `0` when the project records no event. */
  readonly lastSequenceNo: number
  /** Why the fold refused the timeline; no parity was compared. */
  readonly timelineError: string
  readonly materialized: ProjectReplayEntityCounts
}

/** The outcome of one replay audit pass. */
export type ProjectReplayReport = ProjectReplayCompared | ProjectReplayUndecodable

/** One `plan_versions` row the audit reads, in select order. */
interface VersionFactsRow {
  readonly id: string
  readonly plan_id: string
  readonly version_no: number
  readonly source_document_hash: string
}

/** One `work_items` row the audit reads, in select order. */
interface ItemStatusRow {
  readonly id: string
  readonly status: string
}

/** One `acceptance_criteria` row the audit reads, in select order. */
interface CriterionStatusRow {
  readonly id: string
  readonly work_item_id: string
  readonly status: string
}

/** One `work_leases` row the audit reads, in select order. */
interface LeaseStatusRow {
  readonly id: string
  readonly status: string
}

/** One `decision_requests` row the audit reads, in select order. */
interface DecisionRequestStatusRow {
  readonly id: string
  readonly status: string
}

/** One `decisions` row the audit reads, in select order. */
interface DecisionRow {
  readonly id: string
  readonly request_id: string
  readonly decided_by: string
}

/** One `approvals` row the audit reads, in select order. */
interface ApprovalRow {
  readonly id: string
  readonly subject_type: string
  readonly subject_id: string
  readonly status: string
  readonly decided_by: string | null
}

/** One `resource_requirements` row the audit reads, in select order. */
interface RequirementFactsRow {
  readonly id: string
  readonly requirement_key: string
  readonly requirement_kind: string
  readonly name: string
  readonly status: string
}

/** One `resource_instances` row the audit reads, in select order. */
interface InstanceFactsRow {
  readonly id: string
  readonly requirement_id: string
  readonly status: string
}

/** One `resource_verifications` row the audit reads, in select order. */
interface VerificationFactsRow {
  readonly id: string
  readonly resource_instance_id: string
  readonly result: string
}

/** One `actors` row the audit reads, in select order. */
interface ActorFactsRow {
  readonly id: string
  readonly actor_key: string
  readonly actor_kind: string
  readonly display_name: string
  readonly status: string
}

/** One `roles` row the audit reads, in select order. */
interface RoleFactsRow {
  readonly id: string
  readonly role_name: string
  readonly role_kind: string
}

/** One `actor_roles` row the audit reads, in select order. */
interface AssignmentFactsRow {
  readonly id: string
  readonly actor_id: string
  readonly role_id: string
  readonly valid_to_ms: number | null
}

/** One `work_assignments` row the audit reads, in select order. */
interface WorkAssignmentFactsRow {
  readonly id: string
  readonly work_item_id: string
  readonly actor_id: string
  readonly role_id: string | null
  readonly assignment_kind: string
  readonly status: string
}

/** One `handoffs` row the audit reads, in select order. */
interface HandoffFactsRow {
  readonly id: string
  readonly work_item_id: string
  readonly from_actor_id: string
  readonly to_actor_id: string | null
  readonly to_role_id: string | null
  readonly handoff_kind: string
}

/** One `scope_reservations` row the audit reads, in select order. */
interface ScopeReservationFactsRow {
  readonly id: string
  readonly work_item_id: string
  readonly actor_id: string
  readonly scope_kind: string
  readonly scope_value: string
  readonly status: string
}

/**
 * Audit one project's ledger integrity read-only: fold the project's event
 * timeline and compare the rebuilt projection with the materialized tables,
 * family by family and in both directions.
 * @param db - open ledger database.
 * @param projectId - project whose timeline is audited; the caller resolves the id (the plan directory lists projects).
 * @returns the audit report — `compared` with the drift list, or `undecodable` with why the fold refused.
 */
export function readProjectReplay(db: DatabaseSync, projectId: ProjectId): ProjectReplayReport {
  const timeline = db.prepare(
    'SELECT COUNT(*) AS events, COALESCE(MAX(sequence_no), 0) AS last_sequence '
      + 'FROM project_events WHERE project_id = ?',
  ).get(projectId) as { events: number; last_sequence: number }
  const versionRows = db.prepare(
    'SELECT v.id, v.plan_id, v.version_no, v.source_document_hash FROM plan_versions v '
      + 'JOIN plans p ON p.id = v.plan_id WHERE p.project_id = ? ORDER BY v.id',
  ).all(projectId) as unknown as VersionFactsRow[]
  const itemRows = db.prepare('SELECT id, status FROM work_items WHERE project_id = ? ORDER BY id')
    .all(projectId) as unknown as ItemStatusRow[]
  const criterionRows = db.prepare(
    'SELECT c.id, c.work_item_id, c.status FROM acceptance_criteria c '
      + 'JOIN work_items w ON w.id = c.work_item_id WHERE w.project_id = ? ORDER BY c.id',
  ).all(projectId) as unknown as CriterionStatusRow[]
  const leaseRows = db.prepare(
    'SELECT l.id, l.status FROM work_leases l JOIN work_items w ON w.id = l.work_item_id '
    + 'WHERE w.project_id = ? ORDER BY l.id',
  ).all(projectId) as unknown as LeaseStatusRow[]
  const decisionRequestRows = db.prepare(
    'SELECT id, status FROM decision_requests WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as DecisionRequestStatusRow[]
  const decisionRows = db.prepare(
    'SELECT d.id, d.decision_request_id AS request_id, d.decided_by FROM decisions d '
    + 'JOIN decision_requests r ON r.id = d.decision_request_id WHERE r.project_id = ? ORDER BY d.id',
  ).all(projectId) as unknown as DecisionRow[]
  const approvalRows = db.prepare(
    'SELECT id, subject_type, subject_id, status, decided_by FROM approvals WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as ApprovalRow[]
  const requirementRows = db.prepare(
    'SELECT id, requirement_key, requirement_kind, name, status FROM resource_requirements WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as RequirementFactsRow[]
  const instanceRows = db.prepare(
    'SELECT i.id, i.requirement_id, i.status FROM resource_instances i '
    + 'JOIN resource_requirements r ON r.id = i.requirement_id WHERE r.project_id = ? ORDER BY i.id',
  ).all(projectId) as unknown as InstanceFactsRow[]
  const verificationRows = db.prepare(
    'SELECT v.id, v.resource_instance_id, v.result FROM resource_verifications v '
    + 'JOIN resource_instances i ON i.id = v.resource_instance_id '
    + 'JOIN resource_requirements r ON r.id = i.requirement_id WHERE r.project_id = ? ORDER BY v.id',
  ).all(projectId) as unknown as VerificationFactsRow[]
  const actorRows = db.prepare(
    'SELECT id, actor_key, actor_kind, display_name, status FROM actors WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as ActorFactsRow[]
  const roleRows = db.prepare(
    'SELECT id, role_name, role_kind FROM roles WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as RoleFactsRow[]
  const assignmentRows = db.prepare(
    'SELECT a.id, a.actor_id, a.role_id, a.valid_to_ms FROM actor_roles a '
    + 'JOIN actors c ON c.id = a.actor_id WHERE c.project_id = ? ORDER BY a.id',
  ).all(projectId) as unknown as AssignmentFactsRow[]
  const workAssignmentRows = db.prepare(
    'SELECT a.id, a.work_item_id, a.actor_id, a.role_id, a.assignment_kind, a.status FROM work_assignments a '
    + 'JOIN work_items w ON w.id = a.work_item_id WHERE w.project_id = ? ORDER BY a.id',
  ).all(projectId) as unknown as WorkAssignmentFactsRow[]
  const handoffRows = db.prepare(
    'SELECT h.id, h.work_item_id, h.from_actor_id, h.to_actor_id, h.to_role_id, h.handoff_kind FROM handoffs h '
    + 'JOIN work_items w ON w.id = h.work_item_id WHERE w.project_id = ? ORDER BY h.id',
  ).all(projectId) as unknown as HandoffFactsRow[]
  const scopeReservationRows = db.prepare(
    'SELECT r.id, r.work_item_id, r.actor_id, r.scope_kind, r.scope_value, r.status FROM scope_reservations r '
    + 'WHERE r.project_id = ? ORDER BY r.id',
  ).all(projectId) as unknown as ScopeReservationFactsRow[]
  const materialized: ProjectReplayEntityCounts = {
    planVersions: versionRows.length,
    workItems: itemRows.length,
    criteria: criterionRows.length,
    leases: leaseRows.length,
    decisionRequests: decisionRequestRows.length,
    decisions: decisionRows.length,
    approvals: approvalRows.length,
    resourceRequirements: requirementRows.length,
    resourceInstances: instanceRows.length,
    resourceVerifications: verificationRows.length,
    actors: actorRows.length,
    roles: roleRows.length,
    actorRoles: assignmentRows.length,
    workAssignments: workAssignmentRows.length,
    handoffs: handoffRows.length,
    scopeReservations: scopeReservationRows.length,
  }
  let projection: ReplayedProjectProjection
  try {
    projection = replayProjectEvents(db, projectId)
  } catch (error: unknown) {
    // The audit reports, it does not diagnose: whatever blocked the fold, the
    // timeline is unreadable by this build and no parity can be compared.
    return {
      outcome: 'undecodable',
      projectId,
      eventCount: timeline.events,
      lastSequenceNo: timeline.last_sequence,
      timelineError: (error as Error).message,
      materialized,
    }
  }
  const replayedCriterionIds = collectReplayedCriterionIds(projection)
  const drift: ProjectReplayDrift[] = []
  collectVersionDrift(versionRows, projection, drift)
  collectItemDrift(itemRows, projection, drift)
  collectCriterionDrift(criterionRows, projection, replayedCriterionIds, drift)
  collectLeaseDrift(leaseRows, projection, drift)
  collectDecisionDrift(decisionRequestRows, decisionRows, projection, drift)
  collectApprovalDrift(approvalRows, projection, drift)
  collectResourceDrift(requirementRows, instanceRows, verificationRows, projection, drift)
  collectActorDrift(actorRows, roleRows, assignmentRows, projection, drift)
  collectWorkAssignmentDrift(workAssignmentRows, projection, drift)
  collectHandoffDrift(handoffRows, projection, drift)
  collectScopeReservationDrift(scopeReservationRows, projection, drift)
  return {
    outcome: 'compared',
    projectId,
    eventCount: timeline.events,
    lastSequenceNo: timeline.last_sequence,
    replayed: {
      planVersions: projection.planVersions.size,
      workItems: projection.workItems.size,
      criteria: replayedCriterionIds.size,
      leases: projection.leases.size,
      workPackets: projection.workPackets.size,
      decisionRequests: projection.decisionRequests.size,
      decisions: projection.decisions.size,
      approvals: projection.approvals.size,
      resourceRequirements: projection.resourceRequirements.size,
      resourceInstances: projection.resourceInstances.size,
      resourceVerifications: projection.resourceVerifications.size,
      actors: projection.actors.size,
      roles: projection.roles.size,
      actorRoles: projection.actorRoles.size,
      workAssignments: projection.workAssignments.size,
      handoffs: projection.handoffs.size,
      scopeReservations: projection.scopeReservations.size,
    },
    materialized,
    drift,
  }
}

/** Collect the criteria the fold rebuilt, across every replayed work item. */
function collectReplayedCriterionIds(projection: ReplayedProjectProjection): Set<AcceptanceCriterionId> {
  const ids = new Set<AcceptanceCriterionId>()
  for (const item of projection.workItems.values()) {
    for (const criterionId of item.criteria.keys()) ids.add(criterionId)
  }
  return ids
}

/** Compare plan-version identity facts and existence, both directions. */
function collectVersionDrift(
  rows: readonly VersionFactsRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.planVersions.keys())
  for (const row of rows) {
    const id = brandString<PlanVersionId>(row.id)
    const replayed = projection.planVersions.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `plan version "${row.id}" is materialized but no plan/imported event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.planId !== row.plan_id || replayed.versionNo !== row.version_no
      || replayed.sourceDocumentHash !== row.source_document_hash) {
      drift.push({
        refId: row.id,
        message: `plan version "${row.id}" materializes as ${row.plan_id} v${String(row.version_no)} `
          + `hash ${row.source_document_hash} but replays as ${replayed.planId} `
          + `v${String(replayed.versionNo)} hash ${replayed.sourceDocumentHash}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `plan version "${refId}" replays from a plan/imported event but no row is materialized`)
}

/** Compare work-item existence and status, both directions. */
function collectItemDrift(
  rows: readonly ItemStatusRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.workItems.keys())
  for (const row of rows) {
    const id = brandString<WorkItemId>(row.id)
    const replayed = projection.workItems.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `work item "${row.id}" is materialized but no work/created event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `work item "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `work item "${refId}" replays from a work/created event but no row is materialized`)
}

/** Compare criterion existence and status, both directions. */
function collectCriterionDrift(
  rows: readonly CriterionStatusRow[],
  projection: ReplayedProjectProjection,
  replayedIds: ReadonlySet<AcceptanceCriterionId>,
  drift: ProjectReplayDrift[],
): void {
  const unmatchedReplayedIds = new Set(replayedIds)
  for (const row of rows) {
    const id = brandString<AcceptanceCriterionId>(row.id)
    const replayed = projection.workItems.get(brandString<WorkItemId>(row.work_item_id))?.criteria.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `acceptance criterion "${row.id}" is materialized but replays to no criterion of its work item`,
      })
      continue
    }
    unmatchedReplayedIds.delete(id)
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `acceptance criterion "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(unmatchedReplayedIds, drift, refId => `acceptance criterion "${refId}" replays but no row is materialized`)
}

/** Compare lease existence and status, both directions. */
function collectLeaseDrift(
  rows: readonly LeaseStatusRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.leases.keys())
  for (const row of rows) {
    const id = brandString<WorkLeaseId>(row.id)
    const replayed = projection.leases.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `work lease "${row.id}" is materialized but no work/claimed event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `work lease "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `work lease "${refId}" replays from a work/claimed event but no row is materialized`)
}

/**
 * Compare the decision domain, both directions: request existence and
 * status, then decision existence and author against the request each side
 * names.
 */
function collectDecisionDrift(
  requestRows: readonly DecisionRequestStatusRow[],
  decisionRows: readonly DecisionRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedRequestIds = new Set(projection.decisionRequests.keys())
  for (const row of requestRows) {
    const id = brandString<DecisionRequestId>(row.id)
    const replayed = projection.decisionRequests.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `decision request "${row.id}" is materialized but no decision/requested event replays it`,
      })
      continue
    }
    replayedRequestIds.delete(id)
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `decision request "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedRequestIds, drift, refId => `decision request "${refId}" replays from a decision/requested event but no row is materialized`)
  const replayedDecisionIds = new Set(projection.decisions.keys())
  for (const row of decisionRows) {
    const id = brandString<DecisionId>(row.id)
    const replayed = projection.decisions.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `decision "${row.id}" is materialized but no decision/recorded event replays it`,
      })
      continue
    }
    replayedDecisionIds.delete(id)
    if (replayed.requestId !== row.request_id || replayed.decidedBy !== row.decided_by) {
      drift.push({
        refId: row.id,
        message: `decision "${row.id}" materializes for "${row.request_id}" by ${row.decided_by} `
          + `but replays for "${replayed.requestId}" by ${replayed.decidedBy}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedDecisionIds, drift, refId => `decision "${refId}" replays from a decision/recorded event but no row is materialized`)
}

/**
 * Compare the approval domain, both directions: existence, then subject
 * reference, status, and deciding actor against what each side records.
 */
function collectApprovalDrift(
  rows: readonly ApprovalRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.approvals.keys())
  for (const row of rows) {
    const id = brandString<ApprovalId>(row.id)
    const replayed = projection.approvals.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `approval "${row.id}" is materialized but no approval/requested event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.subjectType !== row.subject_type || replayed.subjectId !== row.subject_id) {
      drift.push({
        refId: row.id,
        message: `approval "${row.id}" materializes over ${row.subject_type} "${row.subject_id}" `
          + `but replays over ${replayed.subjectType} "${replayed.subjectId}"`,
      })
    }
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `approval "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
    if (replayed.decidedBy !== (row.decided_by ?? undefined)) {
      drift.push({
        refId: row.id,
        message: `approval "${row.id}" materializes decided by ${row.decided_by ?? 'nobody'} `
          + `but replays decided by ${replayed.decidedBy ?? 'nobody'}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `approval "${refId}" replays from an approval/requested event but no row is materialized`)
}

/**
 * Compare the resource domain, both directions, family by family:
 * requirement identity facts and status, instance requirement and status,
 * verification instance and result.
 */
function collectResourceDrift(
  requirements: readonly RequirementFactsRow[],
  instances: readonly InstanceFactsRow[],
  verifications: readonly VerificationFactsRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedRequirementIds = new Set(projection.resourceRequirements.keys())
  for (const row of requirements) {
    const id = brandString<ResourceRequirementId>(row.id)
    const replayed = projection.resourceRequirements.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `resource requirement "${row.id}" is materialized but no resource/required event replays it`,
      })
      continue
    }
    replayedRequirementIds.delete(id)
    if (replayed.requirementKey !== row.requirement_key || replayed.requirementKind !== row.requirement_kind
      || replayed.name !== row.name) {
      drift.push({
        refId: row.id,
        message: `resource requirement "${row.id}" materializes as ${row.requirement_kind} "${row.requirement_key}" `
          + `(${row.name}) but replays as ${replayed.requirementKind} "${replayed.requirementKey}" (${replayed.name})`,
      })
    }
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `resource requirement "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedRequirementIds, drift, refId => `resource requirement "${refId}" replays from a resource/required event but no row is materialized`)

  const replayedInstanceIds = new Set(projection.resourceInstances.keys())
  for (const row of instances) {
    const id = brandString<ResourceInstanceId>(row.id)
    const replayed = projection.resourceInstances.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `resource instance "${row.id}" is materialized but no resource/provided event replays it`,
      })
      continue
    }
    replayedInstanceIds.delete(id)
    if (replayed.requirementId !== row.requirement_id) {
      drift.push({
        refId: row.id,
        message: `resource instance "${row.id}" materializes for "${row.requirement_id}" `
          + `but replays for "${replayed.requirementId}"`,
      })
    }
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `resource instance "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedInstanceIds, drift, refId => `resource instance "${refId}" replays from a resource/provided event but no row is materialized`)

  const replayedVerificationIds = new Set(projection.resourceVerifications.keys())
  for (const row of verifications) {
    const id = brandString<ResourceVerificationId>(row.id)
    const replayed = projection.resourceVerifications.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `resource verification "${row.id}" is materialized but no resource/verified event replays it`,
      })
      continue
    }
    replayedVerificationIds.delete(id)
    if (replayed.instanceId !== row.resource_instance_id || replayed.result !== row.result) {
      drift.push({
        refId: row.id,
        message: `resource verification "${row.id}" materializes ${row.result} for "${row.resource_instance_id}" `
          + `but replays ${replayed.result} for "${replayed.instanceId}"`,
      })
    }
  }
  pushReplayOnlyDrift(replayedVerificationIds, drift, refId => `resource verification "${refId}" replays from a resource/verified event but no row is materialized`)
}

/** Record one drift per replayed entity no materialized row carries. */
function pushReplayOnlyDrift(
  ids: Iterable<string>,
  drift: ProjectReplayDrift[],
  describe: (refId: string) => string,
): void {
  for (const refId of ids) drift.push({ refId, message: describe(refId) })
}

/**
 * Compare the actor/role domain, both directions, family by family: actor
 * identity facts and status, role identity facts, assignment pair and
 * validity window.
 */
function collectActorDrift(
  actors: readonly ActorFactsRow[],
  roles: readonly RoleFactsRow[],
  assignments: readonly AssignmentFactsRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedActorIds = new Set(projection.actors.keys())
  for (const row of actors) {
    const id = brandString<ActorId>(row.id)
    const replayed = projection.actors.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `actor "${row.id}" is materialized but no actor/registered event replays it`,
      })
      continue
    }
    replayedActorIds.delete(id)
    if (replayed.actorKey !== row.actor_key || replayed.actorKind !== row.actor_kind
      || replayed.displayName !== row.display_name) {
      drift.push({
        refId: row.id,
        message: `actor "${row.id}" materializes as ${row.actor_kind} "${row.actor_key}" `
          + `(${row.display_name}) but replays as ${replayed.actorKind} "${replayed.actorKey}" `
          + `(${replayed.displayName})`,
      })
    }
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `actor "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedActorIds, drift, refId => `actor "${refId}" replays from an actor/registered event but no row is materialized`)

  const replayedRoleIds = new Set(projection.roles.keys())
  for (const row of roles) {
    const id = brandString<RoleId>(row.id)
    const replayed = projection.roles.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `role "${row.id}" is materialized but no role/defined event replays it`,
      })
      continue
    }
    replayedRoleIds.delete(id)
    if (replayed.roleName !== row.role_name || replayed.roleKind !== row.role_kind) {
      drift.push({
        refId: row.id,
        message: `role "${row.id}" materializes as ${row.role_kind} "${row.role_name}" `
          + `but replays as ${replayed.roleKind} "${replayed.roleName}"`,
      })
    }
  }
  pushReplayOnlyDrift(replayedRoleIds, drift, refId => `role "${refId}" replays from a role/defined event but no row is materialized`)

  const replayedAssignmentIds = new Set(projection.actorRoles.keys())
  for (const row of assignments) {
    const id = brandString<ActorRoleId>(row.id)
    const replayed = projection.actorRoles.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `actor role "${row.id}" is materialized but no role/assigned event replays it`,
      })
      continue
    }
    replayedAssignmentIds.delete(id)
    if (replayed.actorId !== row.actor_id || replayed.roleId !== row.role_id) {
      drift.push({
        refId: row.id,
        message: `actor role "${row.id}" materializes actor "${row.actor_id}" over role "${row.role_id}" `
          + `but replays actor "${replayed.actorId}" over role "${replayed.roleId}"`,
      })
    }
    if (replayed.validToMs !== (row.valid_to_ms ?? undefined)) {
      // The fold replays every assignment live (no end writer yet), so only a
      // non-null materialized valid_to_ms can reach this message.
      drift.push({
        refId: row.id,
        message: `actor role "${row.id}" materializes valid until ${String(row.valid_to_ms)} but replays valid until now`,
      })
    }
  }
  pushReplayOnlyDrift(replayedAssignmentIds, drift, refId => `actor role "${refId}" replays from a role/assigned event but no row is materialized`)
}

/**
 * Compare the work-assignment family, both directions: existence, then item
 * and actor references, role reference, kind, and status.
 */
function collectWorkAssignmentDrift(
  rows: readonly WorkAssignmentFactsRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.workAssignments.keys())
  for (const row of rows) {
    const id = brandString<WorkAssignmentId>(row.id)
    const replayed = projection.workAssignments.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `work assignment "${row.id}" is materialized but no work/assigned event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.workItemId !== row.work_item_id || replayed.actorId !== row.actor_id) {
      drift.push({
        refId: row.id,
        message: `work assignment "${row.id}" materializes actor "${row.actor_id}" over item "${row.work_item_id}" `
          + `but replays actor "${replayed.actorId}" over item "${replayed.workItemId}"`,
      })
    }
    if (replayed.roleId !== (row.role_id ?? undefined)) {
      drift.push({
        refId: row.id,
        message: `work assignment "${row.id}" materializes with role ${row.role_id === null ? 'none' : `"${row.role_id}"`} `
          + `but replays with role ${replayed.roleId === undefined ? 'none' : `"${replayed.roleId}"`}`,
      })
    }
    if (replayed.assignmentKind !== row.assignment_kind) {
      drift.push({
        refId: row.id,
        message: `work assignment "${row.id}" materializes ${row.assignment_kind} but replays ${replayed.assignmentKind}`,
      })
    }
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `work assignment "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `work assignment "${refId}" replays from a work/assigned event but no row is materialized`)
}

/**
 * Compare the handoff family, both directions: existence, then item and
 * sender references, the recipient actor/role pair, and the kind.
 */
function collectHandoffDrift(
  rows: readonly HandoffFactsRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.handoffs.keys())
  for (const row of rows) {
    const id = brandString<HandoffId>(row.id)
    const replayed = projection.handoffs.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `handoff "${row.id}" is materialized but no handoff/recorded event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.workItemId !== row.work_item_id || replayed.fromActorId !== row.from_actor_id) {
      drift.push({
        refId: row.id,
        message: `handoff "${row.id}" materializes actor "${row.from_actor_id}" handing item "${row.work_item_id}" `
          + `but replays actor "${replayed.fromActorId}" handing item "${replayed.workItemId}"`,
      })
    }
    const materializedRecipient = row.to_actor_id === null ? `role "${row.to_role_id}"` : `actor "${row.to_actor_id}"`
    const replayedRecipient = replayed.toActorId === undefined ? `role "${replayed.toRoleId}"` : `actor "${replayed.toActorId}"`
    if (replayed.toActorId !== (row.to_actor_id ?? undefined) || replayed.toRoleId !== (row.to_role_id ?? undefined)) {
      drift.push({
        refId: row.id,
        message: `handoff "${row.id}" materializes to ${materializedRecipient} but replays to ${replayedRecipient}`,
      })
    }
    if (replayed.handoffKind !== row.handoff_kind) {
      drift.push({
        refId: row.id,
        message: `handoff "${row.id}" materializes ${row.handoff_kind} but replays ${replayed.handoffKind}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `handoff "${refId}" replays from a handoff/recorded event but no row is materialized`)
}

/**
 * Compare the scope-reservation family, both directions: existence, then the
 * item and actor references, the reserved scope, and the lifecycle status.
 */
function collectScopeReservationDrift(
  rows: readonly ScopeReservationFactsRow[],
  projection: ReplayedProjectProjection,
  drift: ProjectReplayDrift[],
): void {
  const replayedIds = new Set(projection.scopeReservations.keys())
  for (const row of rows) {
    const id = brandString<ScopeReservationId>(row.id)
    const replayed = projection.scopeReservations.get(id)
    if (replayed === undefined) {
      drift.push({
        refId: row.id,
        message: `scope reservation "${row.id}" is materialized but no scope/reserved event replays it`,
      })
      continue
    }
    replayedIds.delete(id)
    if (replayed.workItemId !== row.work_item_id || replayed.actorId !== row.actor_id) {
      drift.push({
        refId: row.id,
        message: `scope reservation "${row.id}" materializes actor "${row.actor_id}" over item "${row.work_item_id}" `
          + `but replays actor "${replayed.actorId}" over item "${replayed.workItemId}"`,
      })
    }
    if (replayed.scopeKind !== row.scope_kind || replayed.scopeValue !== row.scope_value) {
      drift.push({
        refId: row.id,
        message: `scope reservation "${row.id}" materializes ${row.scope_kind} scope "${row.scope_value}" `
          + `but replays ${replayed.scopeKind} scope "${replayed.scopeValue}"`,
      })
    }
    if (replayed.status !== row.status) {
      drift.push({
        refId: row.id,
        message: `scope reservation "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  pushReplayOnlyDrift(replayedIds, drift, refId => `scope reservation "${refId}" replays from a scope/reserved event but no row is materialized`)
}
