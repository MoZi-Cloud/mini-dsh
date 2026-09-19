/**
 * Versioned append-only project events (v1.6a F13, attachment §11/§15/§16):
 * the envelope every ledger writer stamps, the vocabulary, and the
 * fail-closed read/replay codec. {@link appendProjectEvent} allocates the
 * `project_events` sequence and is called inside the writer's own
 * `BEGIN IMMEDIATE` transaction, per the §15 concept order. Reading fails
 * closed on rows this codec cannot interpret: an unknown event type recorded
 * as required, or an `event_format_version` newer than this build. A row
 * stamped with an older format decodes, because the vocabulary is cumulative
 * and this build knows every type an older writer could record. Unknown
 * ignorable rows are observational extensions from a newer writer — the
 * reader preserves them, and replay changes no state for them; they must
 * never carry projection semantics (§16).
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/project-events
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId, ActorRoleId, RoleId } from './actors.js'
import type { ApprovalId } from './approvals.js'
import type { DecisionId, DecisionRequestId } from './decisions.js'
import type { HandoffId } from './handoffs.js'
import type { ResourceInstanceId, ResourceRequirementId, ResourceVerificationId } from './resources.js'
import type { WorkAssignmentId } from './work-assignments.js'
import type { WorkExternalBlockerId } from './versioning.js'
import type { WorkLeaseId } from './lease.js'
import type { AcceptanceCriterionId, PlanId, PlanVersionId, ProjectId, SourceDocumentHash, WorkItemId } from './plan-compile.js'
import type { PlanAcceptanceKind, PlanWorkItemStatus } from './plan-document.js'
import { PLAN_ACCEPTANCE_KINDS, PLAN_WORK_ITEM_STATUSES } from './plan-schema.js'
import type { WorkPacketId } from './work-packet.js'
import {
  WORK_READINESS_BLOCKER_KINDS,
  type WorkReadinessBlockerKind,
  type WorkReadinessReason,
} from './work-readiness.js'

const WORK_ITEM_STATUS_SET: ReadonlySet<string> = new Set<string>(PLAN_WORK_ITEM_STATUSES)
const ACCEPTANCE_KIND_SET: ReadonlySet<string> = new Set<string>(PLAN_ACCEPTANCE_KINDS)
const BLOCKER_KIND_SET: ReadonlySet<string> = new Set<string>(WORK_READINESS_BLOCKER_KINDS)

/**
 * The controlled status of one acceptance criterion row — the projection
 * `acceptance/evaluated` events move (§10: evaluations are append-only
 * history, the current status is the projection).
 */
export const ACCEPTANCE_CRITERION_STATUSES = [
  'PENDING',
  'PASSING',
  'FAILING',
  'BLOCKED',
  'WAIVED',
] as const

/** The controlled status of one acceptance criterion row. */
export type AcceptanceCriterionStatus = (typeof ACCEPTANCE_CRITERION_STATUSES)[number]

/** The outcome one evaluation records for a criterion. */
export const ACCEPTANCE_EVALUATION_RESULTS = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'ERROR',
  'WAIVED',
] as const

/** The outcome one evaluation records for a criterion. */
export type AcceptanceEvaluationResult = (typeof ACCEPTANCE_EVALUATION_RESULTS)[number]

const CRITERION_STATUS_SET: ReadonlySet<string> = new Set<string>(ACCEPTANCE_CRITERION_STATUSES)
const EVALUATION_RESULT_SET: ReadonlySet<string> = new Set<string>(ACCEPTANCE_EVALUATION_RESULTS)

/**
 * The closed set of work-packet reference kinds a
 * `project/work-packet-prepared` recipe may name. Owned here (not in the
 * packet module) because the payload codec validates it on read.
 */
export const WORK_PACKET_REFERENCE_KINDS = [
  'plan-version',
  'repo-snapshot',
  'work-item',
  'phase',
  'blocking-relation',
  'acceptance-criterion',
  'verification-spec',
] as const

/** A reference kind of the work-packet recipe vocabulary. */
export type WorkPacketReferenceKind = (typeof WORK_PACKET_REFERENCE_KINDS)[number]

const PACKET_REFERENCE_KIND_SET: ReadonlySet<string> = new Set<string>(WORK_PACKET_REFERENCE_KINDS)

/**
 * The supersede policy a `plan/version-superseded` payload must carry
 * (§22). Owned here (not in the versioning module) because the payload
 * codec validates it on read.
 */
export const SUPERSEDE_POLICY = 'freeze-new-claims-and-review-active'

/**
 * The blocking levels a `decision/requested` payload may carry. Owned here
 * (not in the decisions module) because the payload codec validates it on
 * read.
 */
export const DECISION_BLOCKING_LEVELS = ['BLOCKING', 'ADVISORY'] as const

/** A blocking level of one decision request. */
export type DecisionBlockingLevel = (typeof DECISION_BLOCKING_LEVELS)[number]

const DECISION_BLOCKING_LEVEL_SET: ReadonlySet<string> = new Set<string>(DECISION_BLOCKING_LEVELS)

/**
 * The closed set of subject kinds an `approval/requested` payload may name
 * (blueprint §24: approvals hang beside a typed subject reference). Owned
 * here (not in the approvals module) because the payload codec validates it
 * on read.
 */
export const APPROVAL_SUBJECT_TYPES = ['plan-version', 'work-item', 'decision'] as const

/** A subject kind of one approval. */
export type ApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number]

const APPROVAL_SUBJECT_TYPE_SET: ReadonlySet<string> = new Set<string>(APPROVAL_SUBJECT_TYPES)

/**
 * The outcomes an `approval/decided` payload may record. Owned here (not in
 * the approvals module) because the payload codec validates it on read.
 */
export const APPROVAL_OUTCOMES = ['APPROVED', 'REJECTED'] as const

/** The outcome one approval decision records. */
export type ApprovalDecisionOutcome = (typeof APPROVAL_OUTCOMES)[number]

const APPROVAL_OUTCOME_SET: ReadonlySet<string> = new Set<string>(APPROVAL_OUTCOMES)

/**
 * The outcomes a `resource/verified` payload may record. Owned here (not in
 * the resources module) because the payload codec validates it on read.
 */
export const RESOURCE_VERIFICATION_RESULTS = ['PASS', 'FAIL'] as const

/** The outcome one resource verification records. */
export type ResourceVerificationResult = (typeof RESOURCE_VERIFICATION_RESULTS)[number]

const RESOURCE_VERIFICATION_RESULT_SET: ReadonlySet<string> = new Set<string>(RESOURCE_VERIFICATION_RESULTS)

/**
 * The verifier kinds a `resource/verified` payload may name — the same five
 * kinds the acceptance vocabulary uses, owned here under a resource name so
 * the resource seam never imports the plan-document types. The payload codec
 * validates it on read.
 */
export const RESOURCE_VERIFIER_KINDS = [
  'COMMAND',
  'TEST',
  'SQL_ASSERTION',
  'GRAPH_ASSERTION',
  'OWNER_CONFIRMATION',
] as const

/** A verifier kind of one resource verification. */
export type ResourceVerifierKind = (typeof RESOURCE_VERIFIER_KINDS)[number]

const RESOURCE_VERIFIER_KIND_SET: ReadonlySet<string> = new Set<string>(RESOURCE_VERIFIER_KINDS)

/**
 * The kinds an `actor/registered` payload may name (blueprint §3's actor
 * kinds, uppercased to the ledger's controlled-set convention). Owned here
 * (not in the actors module) because the payload codec validates it on read.
 */
export const ACTOR_KINDS = ['HUMAN', 'AGENT', 'SERVICE', 'SYSTEM'] as const

/** A kind of one project actor. */
export type ActorKind = (typeof ACTOR_KINDS)[number]

const ACTOR_KIND_SET: ReadonlySet<string> = new Set<string>(ACTOR_KINDS)

/**
 * The kinds a `role/defined` payload may name — the two duties the ledger's
 * roles carry: `GOVERNANCE` roles (like `owner`, the referent of approval
 * `required_role` references) gate decisions and approvals; `EXECUTION`
 * roles (like `executor`) claim and complete work. The blueprint leaves
 * `role_kind` unvalued; this build closes it to these two. Owned here (not
 * in the actors module) because the payload codec validates it on read.
 */
export const ROLE_KINDS = ['GOVERNANCE', 'EXECUTION'] as const

/** A kind of one project role. */
export type RoleKind = (typeof ROLE_KINDS)[number]

const ROLE_KIND_SET: ReadonlySet<string> = new Set<string>(ROLE_KINDS)

/**
 * The duties a `work/assigned` payload may name (blueprint §18's assignment
 * kinds, uppercased to the ledger convention).
 */
export const WORK_ASSIGNMENT_KINDS = [
  'PRIMARY',
  'COLLABORATOR',
  'REVIEWER',
  'TESTER',
  'OBSERVER',
  'ACCOUNTABLE',
] as const

/** A duty kind of one work assignment. */
export type WorkAssignmentKind = (typeof WORK_ASSIGNMENT_KINDS)[number]

const WORK_ASSIGNMENT_KIND_SET: ReadonlySet<string> = new Set<string>(WORK_ASSIGNMENT_KINDS)

/**
 * The passes a `handoff/recorded` payload may record (blueprint §28's
 * handoff kinds, uppercased to the ledger convention). The blueprint leaves
 * `handoff_kind` unvalued; this build closes it to these two. Owned here
 * (not in the handoffs module) because the payload codec validates it on
 * read.
 */
export const HANDOFF_KINDS = ['DELEGATE', 'RETURN'] as const

/** A kind of one recorded handoff. */
export type HandoffKind = (typeof HANDOFF_KINDS)[number]

const HANDOFF_KIND_SET: ReadonlySet<string> = new Set<string>(HANDOFF_KINDS)

/**
 * The event envelope version recorded in the `event_format_version` column of
 * every `project_events` row — the single home of this constant. Adding a
 * required vocabulary entry bumps it together with the codec; purely
 * observational events must not. Reads stay adjacent: a row stamped with an
 * older format decodes when this build knows every type the row can carry
 * (the vocabulary is cumulative), and only a row stamped newer than this
 * build rejects.
 */
export const PROJECT_EVENT_FORMAT_VERSION = 7

/**
 * The event vocabulary. Every listed type is required: rows carry
 * `ignorable = 0`, replay knows their projection effect (this build applies
 * `plan/imported`, `work/created`, `work/status-changed`, `work/blocked`,
 * `work/unblocked`, `work/claimed`, `work/lease-heartbeat`,
 * `work/lease-expired`, `work/lease-released`, `acceptance/evaluated`,
 * `project/work-packet-prepared`, `decision/requested`,
 * `decision/recorded`, `approval/requested`, `approval/decided`,
 * `resource/required`, `resource/provided`, `resource/verified`,
 * `actor/registered`, `role/defined`, `role/assigned`, `work/assigned`, and
 * `handoff/recorded`), and a
 * reader that does not know the type
 * fails closed. `plan/version-superseded` and `baseline/drift-detected` are
 * validated without state change: their writers own lifecycle columns and
 * external blocker rows, which the fold's projection facts do not carry.
 */
export const PROJECT_EVENT_TYPES = [
  'plan/imported',
  'plan/version-activated',
  'plan/version-superseded',
  'work/created',
  'work/status-changed',
  'work/blocked',
  'work/unblocked',
  'work/claimed',
  'work/lease-heartbeat',
  'work/lease-expired',
  'work/lease-released',
  'acceptance/evaluated',
  'project/work-packet-prepared',
  'baseline/drift-detected',
  'decision/requested',
  'decision/recorded',
  'approval/requested',
  'approval/decided',
  'resource/required',
  'resource/provided',
  'resource/verified',
  'actor/registered',
  'role/defined',
  'role/assigned',
  'work/assigned',
  'handoff/recorded',
] as const

/** A vocabulary type of the v1 event format. */
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number]

const REQUIRED_EVENT_TYPES: ReadonlySet<string> = new Set<string>(PROJECT_EVENT_TYPES)

/** Closed set of project-event rejection reasons. */
export type ProjectEventErrorCode =
  | 'required-event-not-ignorable'
  | 'unregistered-event-type'
  | 'event-format-unsupported'
  | 'unknown-required-event'
  | 'malformed-event-payload'

/**
 * Thrown by the append and read/replay seams on rows or drafts the codec
 * rejects. Append rejections write nothing; the caller's transaction owns
 * rollback.
 */
export class ProjectEventError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ProjectEventErrorCode

  /** @param code - why the event draft or row was rejected. @param message - the concrete reason. */
  constructor(code: ProjectEventErrorCode, message: string) {
    super(message)
    this.name = 'ProjectEventError'
    this.code = code
  }
}

/** One decoded `project_events` row. */
export interface ProjectEventEnvelope {
  /** Project the event belongs to (the `PRIMARY KEY` prefix). */
  readonly projectId: ProjectId
  /** 1-based position within the project's event timeline. */
  readonly sequenceNo: number
  /** {@link PROJECT_EVENT_FORMAT_VERSION} of the writing codec. */
  readonly eventFormatVersion: number
  /** A {@link ProjectEventType} for rows this codec appends; reads preserve foreign observational types. */
  readonly eventType: string
  /** `true` for observational rows that replay must skip. */
  readonly ignorable: boolean
  /** Kind of the entity the event is about, when the event names one. */
  readonly entityType: string | undefined
  /** Ledger id of the entity the event is about, when the event names one. */
  readonly entityId: string | undefined
  /** Writer identity recorded on the row. */
  readonly actorRef: string | undefined
  /** JSON value decoded from `payload_json`. */
  readonly payload: unknown
  /** Wall-clock stamp of the write. */
  readonly createdAtMs: number
}

/** Options for {@link appendProjectEvent}. */
export interface AppendProjectEventOptions {
  /** Kind of the entity the event is about; omitted when the event names none. */
  readonly entityType?: string | undefined
  /** Ledger id of the entity the event is about; omitted when the event names none. */
  readonly entityId?: string | undefined
  /**
   * Record the row as observational. Required vocabulary entries refuse this
   * flag — projection-affecting semantics must not hide in ignorable rows
   * (§16); unregistered types require it.
   */
  readonly ignorable?: boolean | undefined
  /** Writer identity recorded on the row. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the row; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/**
 * Allocate the next position in a project's timeline. Exported for writers
 * whose event payload must name an id derived from that position (the lease
 * id); such a caller holds `BEGIN IMMEDIATE`, so the pre-read equals the
 * appended envelope's sequence.
 * @param db - open ledger database inside the caller's write transaction.
 * @param projectId - project whose timeline allocates.
 * @returns the sequence number the next appended event will carry.
 */
export function nextProjectEventSequence(db: DatabaseSync, projectId: ProjectId): number {
  return (db
    .prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max_sequence FROM project_events WHERE project_id = ?')
    .get(projectId) as { max_sequence: number }).max_sequence + 1
}

/**
 * Append one event to a project's timeline and return the envelope as
 * written. The sequence is allocated from the project's current maximum, so
 * callers must hold their `BEGIN IMMEDIATE` transaction across the read and
 * this insert (§15).
 * @param db - open ledger database inside the caller's write transaction.
 * @param projectId - project whose timeline receives the event.
 * @param eventType - a {@link ProjectEventType}, or an unregistered observational type with `ignorable: true`.
 * @param payload - JSON-serializable event payload.
 * @param options - entity, observational flag, actor, and clock overrides.
 * @returns the envelope as recorded.
 * @throws {ProjectEventError} on `required-event-not-ignorable` and `unregistered-event-type`.
 */
export function appendProjectEvent(
  db: DatabaseSync,
  projectId: ProjectId,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  options: AppendProjectEventOptions = {},
): ProjectEventEnvelope {
  const ignorable = options.ignorable ?? false
  if (REQUIRED_EVENT_TYPES.has(eventType)) {
    if (ignorable) {
      throw new ProjectEventError(
        'required-event-not-ignorable',
        `project event "${eventType}" is a required vocabulary entry and is recorded as required; `
          + 'observational rows need an unregistered type',
      )
    }
  } else if (!ignorable) {
    throw new ProjectEventError(
      'unregistered-event-type',
      `project event "${eventType}" is not in the v1 vocabulary; unregistered types are observational `
        + 'and are recorded with ignorable: true',
    )
  }
  const nowMs = options.nowMs ?? Date.now()
  const sequenceNo = nextProjectEventSequence(db, projectId)
  db.prepare(
    'INSERT INTO project_events '
    + '(project_id, sequence_no, event_format_version, event_type, ignorable, entity_type, entity_id, actor_ref, '
    + 'payload_json, created_at_ms) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    projectId,
    sequenceNo,
    PROJECT_EVENT_FORMAT_VERSION,
    eventType,
    ignorable ? 1 : 0,
    options.entityType ?? null,
    options.entityId ?? null,
    options.actorRef ?? null,
    JSON.stringify(payload),
    nowMs,
  )
  return {
    projectId,
    sequenceNo,
    eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION,
    eventType,
    ignorable,
    entityType: options.entityType,
    entityId: options.entityId,
    actorRef: options.actorRef,
    payload,
    createdAtMs: nowMs,
  }
}

/** One raw `project_events` row, in select order. */
interface ProjectEventRow {
  readonly sequence_no: number
  readonly event_format_version: number
  readonly event_type: string
  readonly ignorable: number
  readonly entity_type: string | null
  readonly entity_id: string | null
  readonly actor_ref: string | null
  readonly payload_json: string
  readonly created_at_ms: number
}

/**
 * Read a project's complete event timeline in sequence order. Unknown
 * required events fail the whole read (§11): the caller cannot get a
 * partially interpreted timeline.
 * @param db - open ledger database.
 * @param projectId - project whose timeline is read.
 * @returns one envelope per row, `sequence_no` ascending.
 * @throws {ProjectEventError} on `event-format-unsupported`, `unknown-required-event`, and `malformed-event-payload`.
 */
export function readProjectEvents(db: DatabaseSync, projectId: ProjectId): ProjectEventEnvelope[] {
  const rows = db.prepare(
    'SELECT sequence_no, event_format_version, event_type, ignorable, entity_type, entity_id, actor_ref, '
    + 'payload_json, created_at_ms '
    + 'FROM project_events WHERE project_id = ? ORDER BY sequence_no',
  ).all(projectId) as unknown as ProjectEventRow[]
  return rows.map(row => decodeEventRow(projectId, row))
}

/** Decode one raw row into the envelope, failing closed on unreadable facts. */
function decodeEventRow(projectId: ProjectId, row: ProjectEventRow): ProjectEventEnvelope {
  if (row.event_format_version > PROJECT_EVENT_FORMAT_VERSION) {
    throw new ProjectEventError(
      'event-format-unsupported',
      `project event ${row.sequence_no} of "${projectId}" carries event format ${row.event_format_version}; `
        + `this build reads up to format ${PROJECT_EVENT_FORMAT_VERSION}`,
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch (error: unknown) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${row.sequence_no} of "${projectId}" carries invalid payload JSON: ${(error as Error).message}`,
    )
  }
  const ignorable = row.ignorable === 1
  if (!REQUIRED_EVENT_TYPES.has(row.event_type) && !ignorable) {
    throw new ProjectEventError(
      'unknown-required-event',
      `project event ${row.sequence_no} of "${projectId}" carries unknown required event "${row.event_type}"; `
        + 'a newer codec is required to read this ledger',
    )
  }
  return {
    projectId,
    sequenceNo: row.sequence_no,
    eventFormatVersion: row.event_format_version,
    eventType: row.event_type,
    ignorable,
    entityType: row.entity_type ?? undefined,
    entityId: row.entity_id ?? undefined,
    actorRef: row.actor_ref ?? undefined,
    payload,
    createdAtMs: row.created_at_ms,
  }
}

/** Plan-version facts carried by a `plan/imported` event. */
export interface ReplayedPlanVersion {
  readonly planId: PlanId
  readonly versionNo: number
  readonly sourceDocumentHash: SourceDocumentHash
}

/** One acceptance criterion of a replayed work item. */
export interface ReplayedCriterion {
  /** Zero-based position within the work item's criteria. */
  readonly ordinal: number
  readonly criterionKind: PlanAcceptanceKind
  /** `true` when a failing or blocked criterion blocks claiming. */
  readonly required: boolean
  /** The current projection status, moved by `acceptance/evaluated` events. */
  readonly status: AcceptanceCriterionStatus
}

/** Work-item facts carried by a `work/created` event. */
export interface ReplayedWorkItem {
  readonly stableKey: string
  readonly title: string
  readonly planVersionId: PlanVersionId
  /** The materialized status, moved forward by `work/status-changed` events. */
  readonly status: PlanWorkItemStatus
  /** The criteria created with the item, moved forward by `acceptance/evaluated` events. */
  readonly criteria: ReadonlyMap<AcceptanceCriterionId, ReplayedCriterion>
}

/** The replay-reachable statuses of one work lease; `REVOKED` has no writer. */
export type ReplayedLeaseStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED'

/**
 * Lease facts carried by the lease lifecycle events. The token hash never
 * replays: it is bearer-credential material, not projection state.
 */
export interface ReplayedLease {
  readonly workItemId: WorkItemId
  readonly workerIdentity: string
  readonly status: ReplayedLeaseStatus
  readonly acquiredAtMs: number
  readonly heartbeatAtMs: number
  readonly expiresAtMs: number
  readonly releasedAtMs: number | undefined
}

/** One ordered recipe entry of a replayed `project/work-packet-prepared` event. */
export interface ReplayedWorkPacketReference {
  readonly kind: WorkPacketReferenceKind
  readonly refId: string
  readonly contentHash: string
}

/**
 * The reconstruction recipe one `project/work-packet-prepared` event records.
 * The recipe is the whole durable record of a packet — replay keys it by
 * packet id, and the rebuild seam decodes it to re-derive the packet from the
 * referenced rows.
 */
export interface ReplayedWorkPacket {
  readonly packetId: WorkPacketId
  readonly packetFormatVersion: number
  readonly builderVersion: string
  readonly workItemId: WorkItemId
  readonly planVersionId: PlanVersionId
  readonly repoSnapshotId: string
  readonly references: readonly ReplayedWorkPacketReference[]
  readonly packetHash: string
  readonly serializedBytes: number
}

/** Decision-request facts the decision events replay. */
export interface ReplayedDecisionRequest {
  readonly decisionKey: string
  /** The option keys the request was opened with; a recorded decision may select one of them. */
  readonly optionKeys: ReadonlySet<string>
  /** `RESOLVED` once a `decision/recorded` event answered the request. */
  readonly status: 'OPEN' | 'RESOLVED'
}

/** Decision facts the `decision/recorded` event replays. */
export interface ReplayedDecision {
  readonly requestId: DecisionRequestId
  readonly decidedBy: string
}

/** Approval facts the approval events replay; the requested stamp is the requesting event's `createdAtMs`. */
export interface ReplayedApproval {
  readonly subjectType: ApprovalSubjectType
  readonly subjectId: string
  /** `APPROVED` or `REJECTED` once an `approval/decided` event answered it. */
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED'
  /** The deciding actor once an `approval/decided` event answered it. */
  readonly decidedBy: string | undefined
}

/** Resource-requirement facts the resource events replay; the opened stamp is the requesting event's `createdAtMs`. */
export interface ReplayedResourceRequirement {
  readonly requirementKey: string
  readonly requirementKind: string
  readonly name: string
  /** `FULFILLED`/`CANCELLED` are reserved statuses with no writer yet. */
  readonly status: 'OPEN'
}

/** Resource-instance facts the `resource/provided` event replays. */
export interface ReplayedResourceInstance {
  readonly requirementId: ResourceRequirementId
  readonly label: string
  /** `RETIRED` is a reserved status with no writer yet. */
  readonly status: 'AVAILABLE'
}

/** Resource-verification facts the `resource/verified` event replays. */
export interface ReplayedResourceVerification {
  readonly instanceId: ResourceInstanceId
  readonly result: ResourceVerificationResult
}

/** Actor facts the `actor/registered` event replays; the registered stamp is the event's `createdAtMs`. */
export interface ReplayedActor {
  readonly actorKey: string
  readonly actorKind: ActorKind
  readonly displayName: string
  /** `INACTIVE` is a reserved status with no writer yet. */
  readonly status: 'ACTIVE'
}

/** Role facts the `role/defined` event replays; the defined stamp is the event's `createdAtMs`. */
export interface ReplayedRole {
  readonly roleName: string
  readonly roleKind: RoleKind
}

/**
 * Assignment facts the `role/assigned` event replays; the assignment's
 * `valid_from_ms` is the event's `createdAtMs` and `valid_to_ms` is reserved
 * (no end-of-assignment writer yet, so the fold always replays `undefined`).
 */
export interface ReplayedActorRole {
  readonly actorId: ActorId
  readonly roleId: RoleId
  readonly validToMs: number | undefined
}

/**
 * Work-assignment facts the `work/assigned` event replays; the assignment's
 * `assigned_at_ms` is the event's `createdAtMs`. `ENDED` and the acceptance
 * and completion timestamps are reserved with no writer yet, so the fold
 * always replays `ACTIVE`.
 */
export interface ReplayedWorkAssignment {
  readonly workItemId: WorkItemId
  readonly actorId: ActorId
  readonly roleId: RoleId | undefined
  readonly assignmentKind: WorkAssignmentKind
  readonly status: 'ACTIVE'
}

/**
 * Handoff facts the `handoff/recorded` event replays; the handoff's
 * `recorded_at_ms` is the event's `createdAtMs` and its inline summary and
 * reference texts are not projection facts (the materialized row owns
 * them, like the decision domain's decision text). `accepted_at_ms` is
 * reserved with no writer yet.
 */
export interface ReplayedHandoff {
  readonly workItemId: WorkItemId
  readonly fromActorId: ActorId
  readonly toActorId: ActorId | undefined
  readonly toRoleId: RoleId | undefined
  readonly handoffKind: HandoffKind
}

/** The projection replaying a project's events rebuilds. */
export interface ReplayedProjectProjection {
  readonly planVersions: ReadonlyMap<PlanVersionId, ReplayedPlanVersion>
  readonly workItems: ReadonlyMap<WorkItemId, ReplayedWorkItem>
  /** The lease lifecycle, rebuilt from `work/claimed` and the lease end events. */
  readonly leases: ReadonlyMap<WorkLeaseId, ReplayedLease>
  /** Every prepared packet recipe, keyed by packet id. */
  readonly workPackets: ReadonlyMap<WorkPacketId, ReplayedWorkPacket>
  /** The decision domain, rebuilt from `decision/requested` and `decision/recorded`. */
  readonly decisionRequests: ReadonlyMap<DecisionRequestId, ReplayedDecisionRequest>
  readonly decisions: ReadonlyMap<DecisionId, ReplayedDecision>
  /** The approval domain, rebuilt from `approval/requested` and `approval/decided`. */
  readonly approvals: ReadonlyMap<ApprovalId, ReplayedApproval>
  /** The resource domain, rebuilt from the `resource/*` events. */
  readonly resourceRequirements: ReadonlyMap<ResourceRequirementId, ReplayedResourceRequirement>
  readonly resourceInstances: ReadonlyMap<ResourceInstanceId, ReplayedResourceInstance>
  readonly resourceVerifications: ReadonlyMap<ResourceVerificationId, ReplayedResourceVerification>
  /** The actor/role domain, rebuilt from the `actor/*` and `role/*` events. */
  readonly actors: ReadonlyMap<ActorId, ReplayedActor>
  readonly roles: ReadonlyMap<RoleId, ReplayedRole>
  readonly actorRoles: ReadonlyMap<ActorRoleId, ReplayedActorRole>
  /** The work-assignment domain, rebuilt from the `work/assigned` event. */
  readonly workAssignments: ReadonlyMap<WorkAssignmentId, ReplayedWorkAssignment>
  /** The handoff domain, rebuilt from the `handoff/recorded` event. */
  readonly handoffs: ReadonlyMap<HandoffId, ReplayedHandoff>
}

/**
 * Fold a project's event timeline into the projection the events record.
 * Vocabulary types without a projection effect in this build, and unknown
 * ignorable rows, change no state — each owning work package adds its applier
 * together with its writer, and the replay-parity tests compare the fold
 * against the materialized tables after every such extension.
 * @param db - open ledger database.
 * @param projectId - project whose events are replayed.
 * @returns the replayed projection, keyed by ledger id.
 * @throws {ProjectEventError} the {@link readProjectEvents} failures plus `malformed-event-payload` for applier payloads.
 */
export function replayProjectEvents(db: DatabaseSync, projectId: ProjectId): ReplayedProjectProjection {
  const planVersions = new Map<PlanVersionId, ReplayedPlanVersion>()
  const workItems = new Map<WorkItemId, ReplayedWorkItem>()
  const leases = new Map<WorkLeaseId, ReplayedLease>()
  const workPackets = new Map<WorkPacketId, ReplayedWorkPacket>()
  const decisionRequests = new Map<DecisionRequestId, ReplayedDecisionRequest>()
  const decisions = new Map<DecisionId, ReplayedDecision>()
  const approvals = new Map<ApprovalId, ReplayedApproval>()
  const resourceRequirements = new Map<ResourceRequirementId, ReplayedResourceRequirement>()
  const resourceInstances = new Map<ResourceInstanceId, ReplayedResourceInstance>()
  const resourceVerifications = new Map<ResourceVerificationId, ReplayedResourceVerification>()
  const actors = new Map<ActorId, ReplayedActor>()
  const roles = new Map<RoleId, ReplayedRole>()
  const actorRoles = new Map<ActorRoleId, ReplayedActorRole>()
  const workAssignments = new Map<WorkAssignmentId, ReplayedWorkAssignment>()
  const handoffs = new Map<HandoffId, ReplayedHandoff>()
  // Validation state for the supersede applier: a version retires once.
  const supersededPlanVersionIds = new Set<PlanVersionId>()
  for (const event of readProjectEvents(db, projectId)) {
    switch (event.eventType) {
      case 'plan/imported': {
        const payload = decodePlanImportedPayload(event)
        planVersions.set(payload.planVersionId, {
          planId: payload.planId,
          versionNo: payload.versionNo,
          sourceDocumentHash: payload.sourceDocumentHash,
        })
        break
      }
      case 'work/created': {
        const payload = decodeWorkCreatedPayload(event)
        workItems.set(payload.workItemId, {
          stableKey: payload.stableKey,
          title: payload.title,
          planVersionId: payload.planVersionId,
          status: payload.status,
          criteria: new Map(payload.criteria.map(criterion => [criterion.criterionId, {
            ordinal: criterion.ordinal,
            criterionKind: criterion.criterionKind,
            required: criterion.required,
            status: criterion.status,
          }])),
        })
        break
      }
      case 'work/status-changed': {
        const payload = decodeStatusMovePayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        workItems.set(payload.workItemId, { ...replayed, status: payload.toStatus })
        break
      }
      case 'work/blocked': {
        const payload = decodeWorkBlockedPayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        if (payload.toStatus !== 'BLOCKED') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "toStatus" `
              + `of a work/blocked event must be BLOCKED, got ${JSON.stringify(payload.toStatus)}`,
          )
        }
        workItems.set(payload.workItemId, { ...replayed, status: payload.toStatus })
        break
      }
      case 'work/unblocked': {
        const payload = decodeStatusMovePayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        if (payload.toStatus !== 'READY') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "toStatus" `
              + `of a work/unblocked event must be READY, got ${JSON.stringify(payload.toStatus)}`,
          )
        }
        workItems.set(payload.workItemId, { ...replayed, status: payload.toStatus })
        break
      }
      case 'work/claimed': {
        const payload = decodeWorkClaimedPayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        if (leases.has(payload.leaseId)) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "leaseId" `
              + `names an already replayed work lease (${payload.leaseId})`,
          )
        }
        if (payload.toStatus !== 'IN_PROGRESS') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "toStatus" `
              + `of a work/claimed event must be IN_PROGRESS, got ${JSON.stringify(payload.toStatus)}`,
          )
        }
        workItems.set(payload.workItemId, { ...replayed, status: payload.toStatus })
        leases.set(payload.leaseId, {
          workItemId: payload.workItemId,
          workerIdentity: payload.workerIdentity,
          status: 'ACTIVE',
          acquiredAtMs: payload.acquiredAtMs,
          heartbeatAtMs: payload.acquiredAtMs,
          expiresAtMs: payload.expiresAtMs,
          releasedAtMs: undefined,
        })
        break
      }
      case 'work/lease-heartbeat': {
        const payload = decodeWorkLeaseHeartbeatPayload(event)
        const lease = requireReplayedLease(leases, payload.leaseId, event)
        if (lease.status !== 'ACTIVE') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload heartbeats work lease `
              + `"${payload.leaseId}" whose replayed status is ${lease.status}`,
          )
        }
        leases.set(payload.leaseId, {
          ...lease,
          heartbeatAtMs: event.createdAtMs,
          expiresAtMs: payload.expiresAtMs,
        })
        break
      }
      case 'work/lease-expired': {
        const payload = decodeWorkLeaseEndedPayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        const lease = requireReplayedLease(leases, payload.leaseId, event)
        if (lease.status !== 'ACTIVE') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload expires work lease `
              + `"${payload.leaseId}" whose replayed status is ${lease.status}`,
          )
        }
        leases.set(payload.leaseId, { ...lease, status: 'EXPIRED' })
        workItems.set(payload.workItemId, { ...replayed, status: payload.toStatus })
        break
      }
      case 'work/lease-released': {
        const payload = decodeWorkLeaseEndedPayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        const lease = requireReplayedLease(leases, payload.leaseId, event)
        if (lease.status !== 'ACTIVE') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload releases work lease `
              + `"${payload.leaseId}" whose replayed status is ${lease.status}`,
          )
        }
        leases.set(payload.leaseId, { ...lease, status: 'RELEASED', releasedAtMs: event.createdAtMs })
        workItems.set(payload.workItemId, { ...replayed, status: payload.toStatus })
        break
      }
      case 'acceptance/evaluated': {
        const payload = decodeAcceptanceEvaluatedPayload(event)
        const replayed = requireReplayedWorkItem(workItems, payload.workItemId, event)
        const criterion = replayed.criteria.get(payload.criterionId)
        if (criterion === undefined) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "criterionId" `
              + `names no replayed acceptance criterion (${payload.criterionId})`,
          )
        }
        const criteria = new Map(replayed.criteria)
        criteria.set(payload.criterionId, { ...criterion, status: payload.status })
        workItems.set(payload.workItemId, { ...replayed, criteria })
        break
      }
      case 'project/work-packet-prepared': {
        const payload = decodeWorkPacketPreparedPayload(event)
        requireReplayedWorkItem(workItems, payload.workItemId, event)
        if (workPackets.has(payload.packetId)) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "packetId" `
              + `names an already replayed work packet (${payload.packetId})`,
          )
        }
        workPackets.set(payload.packetId, payload)
        break
      }
      case 'plan/version-superseded': {
        // Validation-only: the supersede owns lifecycle columns and the
        // plans pointer, which the fold's version facts do not carry.
        const payload = decodePlanVersionSupersededPayload(event)
        const version = planVersions.get(payload.planVersionId)
        if (version === undefined) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "planVersionId" `
              + `names no replayed plan version (${payload.planVersionId})`,
          )
        }
        if (version.planId !== payload.planId) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "planId" `
              + `names plan "${payload.planId}", but version "${payload.planVersionId}" belongs to `
              + `plan "${version.planId}"`,
          )
        }
        if (supersededPlanVersionIds.has(payload.planVersionId)) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload supersedes plan version `
              + `"${payload.planVersionId}" twice in this timeline`,
          )
        }
        for (const attempt of payload.reviewAttempts) {
          requireReplayedWorkItem(workItems, attempt.workItemId, event)
        }
        supersededPlanVersionIds.add(payload.planVersionId)
        break
      }
      case 'baseline/drift-detected': {
        // Validation-only: the drift owns external blocker rows, which the
        // fold does not project.
        const payload = decodeBaselineDriftDetectedPayload(event)
        requireReplayedWorkItem(workItems, payload.workItemId, event)
        break
      }
      case 'decision/requested': {
        const payload = decodeDecisionRequestedPayload(event)
        if (payload.planVersionId !== undefined) {
          requireReplayedPlanVersion(planVersions, payload.planVersionId, event)
        }
        decisionRequests.set(payload.requestId, {
          decisionKey: payload.decisionKey,
          optionKeys: new Set(payload.options.map(option => option.optionKey)),
          status: 'OPEN',
        })
        break
      }
      case 'decision/recorded': {
        const payload = decodeDecisionRecordedPayload(event)
        const request = requireReplayedDecisionRequest(decisionRequests, payload.requestId, event)
        if (request.status === 'RESOLVED') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" resolves decision request `
              + `"${payload.requestId}" twice in this timeline`,
          )
        }
        if (payload.selectedOptionKey !== undefined && !request.optionKeys.has(payload.selectedOptionKey)) {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" payload field "selectedOptionKey" `
              + `names no option of decision request "${payload.requestId}" (${payload.selectedOptionKey})`,
          )
        }
        decisionRequests.set(payload.requestId, { ...request, status: 'RESOLVED' })
        decisions.set(payload.decisionId, { requestId: payload.requestId, decidedBy: payload.decidedBy })
        break
      }
      case 'approval/requested': {
        const payload = decodeApprovalRequestedPayload(event)
        requireReplayedApprovalSubject(planVersions, workItems, decisions, payload, event)
        approvals.set(payload.approvalId, {
          subjectType: payload.subjectType,
          subjectId: payload.subjectId,
          status: 'PENDING',
          decidedBy: undefined,
        })
        break
      }
      case 'approval/decided': {
        const payload = decodeApprovalDecidedPayload(event)
        const approval = requireReplayedApproval(approvals, payload.approvalId, event)
        if (approval.status !== 'PENDING') {
          throw new ProjectEventError(
            'malformed-event-payload',
            `project event ${event.sequenceNo} of "${event.projectId}" decides approval `
              + `"${payload.approvalId}" twice in this timeline`,
          )
        }
        approvals.set(payload.approvalId, { ...approval, status: payload.outcome, decidedBy: payload.decidedBy })
        break
      }
      case 'resource/required': {
        const payload = decodeResourceRequiredPayload(event)
        if (payload.planVersionId !== undefined) {
          requireReplayedPlanVersion(planVersions, payload.planVersionId, event)
        }
        resourceRequirements.set(payload.requirementId, {
          requirementKey: payload.requirementKey,
          requirementKind: payload.requirementKind,
          name: payload.name,
          status: 'OPEN',
        })
        break
      }
      case 'resource/provided': {
        const payload = decodeResourceProvidedPayload(event)
        requireReplayedResourceRequirement(resourceRequirements, payload.requirementId, event)
        resourceInstances.set(payload.instanceId, {
          requirementId: payload.requirementId,
          label: payload.label,
          status: 'AVAILABLE',
        })
        break
      }
      case 'resource/verified': {
        const payload = decodeResourceVerifiedPayload(event)
        requireReplayedResourceInstance(resourceInstances, payload.instanceId, event)
        resourceVerifications.set(payload.verificationId, {
          instanceId: payload.instanceId,
          result: payload.result,
        })
        break
      }
      case 'actor/registered': {
        const payload = decodeActorRegisteredPayload(event)
        actors.set(payload.actorId, {
          actorKey: payload.actorKey,
          actorKind: payload.actorKind,
          displayName: payload.displayName,
          status: 'ACTIVE',
        })
        break
      }
      case 'role/defined': {
        const payload = decodeRoleDefinedPayload(event)
        roles.set(payload.roleId, {
          roleName: payload.roleName,
          roleKind: payload.roleKind,
        })
        break
      }
      case 'role/assigned': {
        const payload = decodeRoleAssignedPayload(event)
        requireReplayedActor(actors, payload.actorId, event)
        requireReplayedRole(roles, payload.roleId, event)
        for (const [assignmentId, assignment] of actorRoles) {
          if (assignment.actorId === payload.actorId && assignment.roleId === payload.roleId
            && assignment.validToMs === undefined) {
            throw new ProjectEventError(
              'malformed-event-payload',
              `project event ${event.sequenceNo} of "${event.projectId}" assigns actor `
                + `"${payload.actorId}" to role "${payload.roleId}" while live assignment `
                + `"${assignmentId}" already holds it`,
            )
          }
        }
        actorRoles.set(payload.assignmentId, {
          actorId: payload.actorId,
          roleId: payload.roleId,
          validToMs: undefined,
        })
        break
      }
      case 'work/assigned': {
        const payload = decodeWorkAssignedPayload(event)
        requireReplayedWorkItem(workItems, payload.workItemId, event)
        requireReplayedActor(actors, payload.actorId, event)
        if (payload.roleId !== undefined) requireReplayedRole(roles, payload.roleId, event)
        if (payload.assignmentKind === 'PRIMARY') {
          for (const [assignmentId, assignment] of workAssignments) {
            if (assignment.assignmentKind === 'PRIMARY' && assignment.workItemId === payload.workItemId) {
              throw new ProjectEventError(
                'malformed-event-payload',
                `project event ${event.sequenceNo} of "${event.projectId}" assigns a second `
                  + `PRIMARY to work item "${payload.workItemId}" while live assignment `
                  + `"${assignmentId}" already holds it`,
              )
            }
          }
        }
        workAssignments.set(payload.assignmentId, {
          workItemId: payload.workItemId,
          actorId: payload.actorId,
          roleId: payload.roleId,
          assignmentKind: payload.assignmentKind,
          status: 'ACTIVE',
        })
        break
      }
      case 'handoff/recorded': {
        const payload = decodeHandoffRecordedPayload(event)
        requireReplayedWorkItem(workItems, payload.workItemId, event)
        requireReplayedActor(actors, payload.fromActorId, event)
        if (payload.toActorId !== undefined) requireReplayedActor(actors, payload.toActorId, event)
        if (payload.toRoleId !== undefined) requireReplayedRole(roles, payload.toRoleId, event)
        handoffs.set(payload.handoffId, {
          workItemId: payload.workItemId,
          fromActorId: payload.fromActorId,
          toActorId: payload.toActorId,
          toRoleId: payload.toRoleId,
          handoffKind: payload.handoffKind,
        })
        break
      }
      default:
        break
    }
  }
  return {
    planVersions,
    workItems,
    leases,
    workPackets,
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
  }
}

/** Fail closed when a payload names a work item the fold has not replayed. */
function requireReplayedWorkItem(
  workItems: ReadonlyMap<WorkItemId, ReplayedWorkItem>,
  workItemId: WorkItemId,
  event: ProjectEventEnvelope,
): ReplayedWorkItem {
  const replayed = workItems.get(workItemId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "workItemId" `
        + `names no replayed work item (${workItemId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names a plan version the fold has not replayed. */
function requireReplayedPlanVersion(
  planVersions: ReadonlyMap<PlanVersionId, ReplayedPlanVersion>,
  planVersionId: PlanVersionId,
  event: ProjectEventEnvelope,
): ReplayedPlanVersion {
  const replayed = planVersions.get(planVersionId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "planVersionId" `
        + `names no replayed plan version (${planVersionId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names a decision request the fold has not replayed. */
function requireReplayedDecisionRequest(
  decisionRequests: ReadonlyMap<DecisionRequestId, ReplayedDecisionRequest>,
  requestId: DecisionRequestId,
  event: ProjectEventEnvelope,
): ReplayedDecisionRequest {
  const replayed = decisionRequests.get(requestId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "requestId" `
        + `names no replayed decision request (${requestId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names an approval the fold has not replayed. */
function requireReplayedApproval(
  approvals: ReadonlyMap<ApprovalId, ReplayedApproval>,
  approvalId: ApprovalId,
  event: ProjectEventEnvelope,
): ReplayedApproval {
  const replayed = approvals.get(approvalId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "approvalId" `
        + `names no replayed approval (${approvalId})`,
    )
  }
  return replayed
}

/**
 * Fail closed when an approval's typed subject names no entity this timeline
 * replayed — each subject kind resolves against its own projection family.
 */
function requireReplayedApprovalSubject(
  planVersions: ReadonlyMap<PlanVersionId, ReplayedPlanVersion>,
  workItems: ReadonlyMap<WorkItemId, ReplayedWorkItem>,
  decisions: ReadonlyMap<DecisionId, ReplayedDecision>,
  payload: ApprovalRequestedPayload,
  event: ProjectEventEnvelope,
): void {
  const known = payload.subjectType === 'plan-version'
    ? planVersions.has(brandString<PlanVersionId>(payload.subjectId))
    : payload.subjectType === 'work-item'
      ? workItems.has(brandString<WorkItemId>(payload.subjectId))
      : decisions.has(brandString<DecisionId>(payload.subjectId))
  if (!known) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "subjectId" `
        + `names no replayed ${payload.subjectType} of this timeline (${payload.subjectId})`,
    )
  }
}

/** Fail closed when a payload names a resource requirement the fold has not replayed. */
function requireReplayedResourceRequirement(
  requirements: ReadonlyMap<ResourceRequirementId, ReplayedResourceRequirement>,
  requirementId: ResourceRequirementId,
  event: ProjectEventEnvelope,
): ReplayedResourceRequirement {
  const replayed = requirements.get(requirementId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "requirementId" `
        + `names no replayed resource requirement (${requirementId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names a resource instance the fold has not replayed. */
function requireReplayedResourceInstance(
  instances: ReadonlyMap<ResourceInstanceId, ReplayedResourceInstance>,
  instanceId: ResourceInstanceId,
  event: ProjectEventEnvelope,
): ReplayedResourceInstance {
  const replayed = instances.get(instanceId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "instanceId" `
        + `names no replayed resource instance (${instanceId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names an actor the fold has not replayed. */
function requireReplayedActor(
  actors: ReadonlyMap<ActorId, ReplayedActor>,
  actorId: ActorId,
  event: ProjectEventEnvelope,
): ReplayedActor {
  const replayed = actors.get(actorId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "actorId" `
        + `names no replayed actor (${actorId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names a role the fold has not replayed. */
function requireReplayedRole(
  roles: ReadonlyMap<RoleId, ReplayedRole>,
  roleId: RoleId,
  event: ProjectEventEnvelope,
): ReplayedRole {
  const replayed = roles.get(roleId)
  if (replayed === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "roleId" `
        + `names no replayed role (${roleId})`,
    )
  }
  return replayed
}

/** Fail closed when a payload names a lease the fold has not replayed. */
function requireReplayedLease(
  leases: ReadonlyMap<WorkLeaseId, ReplayedLease>,
  leaseId: WorkLeaseId,
  event: ProjectEventEnvelope,
): ReplayedLease {
  const lease = leases.get(leaseId)
  if (lease === undefined) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "leaseId" `
        + `names no replayed work lease (${leaseId})`,
    )
  }
  return lease
}

/** Payload facts of one `plan/imported` event. */
interface PlanImportedPayload {
  readonly planId: PlanId
  readonly planVersionId: PlanVersionId
  readonly versionNo: number
  readonly sourceDocumentHash: SourceDocumentHash
}

/** One criterion of a `work/created` payload. */
interface WorkCreatedCriterion {
  readonly criterionId: AcceptanceCriterionId
  readonly ordinal: number
  readonly criterionKind: PlanAcceptanceKind
  readonly required: boolean
  readonly status: AcceptanceCriterionStatus
}

/** Payload facts of one `work/created` event. */
interface WorkCreatedPayload {
  readonly workItemId: WorkItemId
  readonly stableKey: string
  readonly title: string
  readonly planVersionId: PlanVersionId
  readonly status: PlanWorkItemStatus
  readonly criteria: readonly WorkCreatedCriterion[]
}

/** Payload facts of one `acceptance/evaluated` event. */
interface AcceptanceEvaluatedPayload {
  readonly workItemId: WorkItemId
  readonly criterionId: AcceptanceCriterionId
  readonly result: AcceptanceEvaluationResult
  /** The criterion's projection status after this evaluation. */
  readonly status: AcceptanceCriterionStatus
}

/** The lease facts every lease lifecycle event names. */
interface WorkLeaseRefPayload {
  readonly workItemId: WorkItemId
  readonly leaseId: WorkLeaseId
  readonly workerIdentity: string
}

/** Payload facts of one `work/claimed` event. */
interface WorkClaimedPayload extends WorkLeaseRefPayload {
  readonly fromStatus: PlanWorkItemStatus
  /** Always `IN_PROGRESS`; the applier refuses any other value. */
  readonly toStatus: PlanWorkItemStatus
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
}

/** Payload facts of one `work/lease-heartbeat` event; the heartbeat stamp is the envelope's `createdAtMs`. */
interface WorkLeaseHeartbeatPayload extends WorkLeaseRefPayload {
  readonly expiresAtMs: number
}

/** Payload facts of one `work/lease-expired` or `work/lease-released` event; the end stamp is the envelope's `createdAtMs`. */
interface WorkLeaseEndedPayload extends WorkLeaseRefPayload {
  /** The item's recomputed projection (`READY` or `BLOCKED`, §13). */
  readonly toStatus: PlanWorkItemStatus
}

/** Payload facts of one plain status move: `work/status-changed` or `work/unblocked`. */
interface StatusMovePayload {
  readonly workItemId: WorkItemId
  readonly fromStatus: PlanWorkItemStatus
  readonly toStatus: PlanWorkItemStatus
}

/** Payload facts of one `work/blocked` event. */
interface WorkBlockedPayload extends StatusMovePayload {
  /** Always `BLOCKED`; the applier refuses any other value. */
  readonly toStatus: PlanWorkItemStatus
  /** The recomputed blockers materialized by the move. */
  readonly reasons: readonly WorkReadinessReason[]
}

/** Payload facts of one `project/work-packet-prepared` event — the recorded recipe. */
type WorkPacketPreparedPayload = ReplayedWorkPacket

/** One review attempt a `plan/version-superseded` payload names. */
interface SupersededAttemptRef {
  readonly workItemId: WorkItemId
  readonly leaseId: WorkLeaseId
  readonly workerIdentity: string
  readonly expiresAtMs: number
}

/** Payload facts of one `plan/version-superseded` event. */
interface PlanVersionSupersededPayload {
  readonly planId: PlanId
  readonly planVersionId: PlanVersionId
  /** The successor version, when the supersede named one. */
  readonly succeededBy: PlanVersionId | undefined
  readonly policy: typeof SUPERSEDE_POLICY
  readonly supersededAtMs: number
  readonly reviewAttempts: readonly SupersededAttemptRef[]
}

/** Payload facts of one `baseline/drift-detected` event. */
interface BaselineDriftDetectedPayload {
  readonly workItemId: WorkItemId
  readonly planVersionId: PlanVersionId
  readonly blockerId: WorkExternalBlockerId
  readonly baselineRepoHead: string | null
  readonly baselineWorktreeHash: string | null
  readonly observedRepoHead: string | null
  readonly observedWorktreeHash: string | null
}

/** One option entry of a `decision/requested` payload. */
interface DecisionRequestedOption {
  readonly optionKey: string
  readonly label: string
  readonly description: string | undefined
  readonly recommended: boolean
  readonly ordinal: number
}

/** Payload facts of one `decision/requested` event; the raised stamp is the envelope's `createdAtMs`. */
interface DecisionRequestedPayload {
  readonly requestId: DecisionRequestId
  readonly decisionKey: string
  readonly title: string
  readonly question: string
  readonly context: string | undefined
  readonly blockingLevel: DecisionBlockingLevel
  readonly raisedBy: string | undefined
  readonly planVersionId: PlanVersionId | undefined
  readonly options: readonly DecisionRequestedOption[]
}

/** Payload facts of one `decision/recorded` event. */
interface DecisionRecordedPayload {
  readonly requestId: DecisionRequestId
  readonly decisionId: DecisionId
  readonly decidedBy: string
  readonly selectedOptionKey: string | undefined
  readonly decisionText: string
  readonly rationale: string | undefined
  readonly resolvedAtMs: number
}

/** Payload facts of one `approval/requested` event; the requested stamp is the envelope's `createdAtMs`. */
interface ApprovalRequestedPayload {
  readonly approvalId: ApprovalId
  readonly subjectType: ApprovalSubjectType
  readonly subjectId: string
  readonly requiredRole: string | undefined
  readonly requestedBy: string | undefined
}

/** Payload facts of one `approval/decided` event. */
interface ApprovalDecidedPayload {
  readonly approvalId: ApprovalId
  readonly outcome: ApprovalDecisionOutcome
  readonly decidedBy: string
  readonly decisionText: string
  readonly decidedAtMs: number
}

/** Payload facts of one `resource/required` event; the opened stamp is the envelope's `createdAtMs`. */
interface ResourceRequiredPayload {
  readonly requirementId: ResourceRequirementId
  readonly requirementKey: string
  readonly requirementKind: string
  readonly name: string
  readonly constraintsJson: string
  readonly requestedFrom: string | undefined
  readonly planVersionId: PlanVersionId | undefined
}

/** Payload facts of one `resource/provided` event; the provided stamp is the envelope's `createdAtMs`. */
interface ResourceProvidedPayload {
  readonly instanceId: ResourceInstanceId
  readonly requirementId: ResourceRequirementId
  readonly label: string
  readonly provider: string | undefined
  readonly metadataJson: string | undefined
}

/** Payload facts of one `resource/verified` event. */
interface ResourceVerifiedPayload {
  readonly verificationId: ResourceVerificationId
  readonly instanceId: ResourceInstanceId
  readonly verifierKind: ResourceVerifierKind
  readonly verifier: string | undefined
  readonly verificationSpec: string
  readonly observedJson: string | undefined
  readonly result: ResourceVerificationResult
  readonly verifiedAtMs: number
}

/** Payload facts of one `actor/registered` event; the registered stamp is the envelope's `createdAtMs`. */
interface ActorRegisteredPayload {
  readonly actorId: ActorId
  readonly actorKey: string
  readonly actorKind: ActorKind
  readonly displayName: string
  readonly externalIdentity: string | undefined
  readonly metadataJson: string | undefined
}

/** Payload facts of one `role/defined` event; the defined stamp is the envelope's `createdAtMs`. */
interface RoleDefinedPayload {
  readonly roleId: RoleId
  readonly roleName: string
  readonly roleKind: RoleKind
  readonly description: string | undefined
}

/** Payload facts of one `role/assigned` event; the assignment's `valid_from_ms` is the envelope's `createdAtMs`. */
interface RoleAssignedPayload {
  readonly assignmentId: ActorRoleId
  readonly actorId: ActorId
  readonly roleId: RoleId
}

/** Payload facts of one `work/assigned` event; the assignment stamp is the envelope's `createdAtMs`. */
interface WorkAssignedPayload {
  readonly assignmentId: WorkAssignmentId
  readonly workItemId: WorkItemId
  readonly actorId: ActorId
  readonly roleId: RoleId | undefined
  readonly assignmentKind: WorkAssignmentKind
}

/** Payload facts of one `handoff/recorded` event; the handoff stamp is the envelope's `createdAtMs`. */
interface HandoffRecordedPayload {
  readonly handoffId: HandoffId
  readonly workItemId: WorkItemId
  readonly fromActorId: ActorId
  readonly toActorId: ActorId | undefined
  readonly toRoleId: RoleId | undefined
  readonly handoffKind: HandoffKind
  readonly summary: string
  readonly artifactRefsJson: string | undefined
  readonly memoryRefsJson: string | undefined
}

/** The event payload must be a JSON object for appliers to read fields from. */
function payloadFields(event: ProjectEventEnvelope): Record<string, unknown> {
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" carries a non-object payload`,
    )
  }
  return event.payload as Record<string, unknown>
}

/**
 * Read one required string payload field. Brands are re-applied here: the
 * fields crossed the durable `payload_json` boundary, and the write side only
 * ever recorded ledger-branded values.
 * @param fields - the payload object to read from.
 * @param event - the envelope the payload came from, for the error message.
 * @param field - the key to read.
 * @param label - the field name quoted in the error message; defaults to `field`. Nested
 * arrays pass a path like `criteria[0].criterionId` while reading the bare key.
 */
function requiredString(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string, label: string = field): string {
  const value = fields[field]
  if (typeof value !== 'string') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" must be a string`,
    )
  }
  return value
}

/** Read one required number payload field. */
function requiredNumber(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string, label: string = field): number {
  const value = fields[field]
  if (typeof value !== 'number') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" must be a number`,
    )
  }
  return value
}

/**
 * Read one required work-item status payload field. The status crossed the
 * durable `payload_json` boundary, so the controlled vocabulary is re-applied
 * instead of trusting the string.
 */
function requiredStatus(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string): PlanWorkItemStatus {
  const value = requiredString(fields, event, field)
  if (!WORK_ITEM_STATUS_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a work item status: ${JSON.stringify(value)}`,
    )
  }
  return value as PlanWorkItemStatus
}

/** Read one required criterion projection status payload field. */
function requiredCriterionStatus(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
  label: string = field,
): AcceptanceCriterionStatus {
  const value = requiredString(fields, event, field, label)
  if (!CRITERION_STATUS_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" `
        + `is not an acceptance criterion status: ${JSON.stringify(value)}`,
    )
  }
  return value as AcceptanceCriterionStatus
}

/** Read one required evaluation outcome payload field. */
function requiredEvaluationResult(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
  label: string = field,
): AcceptanceEvaluationResult {
  const value = requiredString(fields, event, field, label)
  if (!EVALUATION_RESULT_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" `
        + `is not an acceptance evaluation result: ${JSON.stringify(value)}`,
    )
  }
  return value as AcceptanceEvaluationResult
}

/** Read one required acceptance kind payload field. */
function requiredAcceptanceKind(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
  label: string = field,
): PlanAcceptanceKind {
  const value = requiredString(fields, event, field, label)
  if (!ACCEPTANCE_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" `
        + `is not an acceptance kind: ${JSON.stringify(value)}`,
    )
  }
  return value as PlanAcceptanceKind
}

/** Read one required readiness blocker kind payload field. */
function requiredBlockerKind(fields: Record<string, unknown>, event: ProjectEventEnvelope, label: string): WorkReadinessBlockerKind {
  const value = requiredString(fields, event, 'kind', label)
  if (!BLOCKER_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" `
        + `is not a readiness blocker kind: ${JSON.stringify(value)}`,
    )
  }
  return value as WorkReadinessBlockerKind
}

/** Read one required boolean payload field. */
function requiredBoolean(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string, label: string = field): boolean {
  const value = fields[field]
  if (typeof value !== 'boolean') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" must be a boolean`,
    )
  }
  return value
}

/**
 * Decode the `criteria` array of one `work/created` payload, failing closed
 * on a non-array value and on entries this codec cannot read.
 */
function requiredCriteria(event: ProjectEventEnvelope, fields: Record<string, unknown>): WorkCreatedCriterion[] {
  const value = fields.criteria
  if (!Array.isArray(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "criteria" must be an array`,
    )
  }
  return value.map((entry, index): WorkCreatedCriterion => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProjectEventError(
        'malformed-event-payload',
        `project event ${event.sequenceNo} of "${event.projectId}" payload field "criteria[${index}]" must be an object`,
      )
    }
    const entryFields = entry as Record<string, unknown>
    return {
      criterionId: requiredString(entryFields, event, 'criterionId', `criteria[${index}].criterionId`) as AcceptanceCriterionId,
      ordinal: requiredNumber(entryFields, event, 'ordinal', `criteria[${index}].ordinal`),
      criterionKind: requiredAcceptanceKind(entryFields, event, 'criterionKind', `criteria[${index}].criterionKind`),
      required: requiredBoolean(entryFields, event, 'required', `criteria[${index}].required`),
      status: requiredCriterionStatus(entryFields, event, 'status', `criteria[${index}].status`),
    }
  })
}

/**
 * Decode the `reasons` array of one `work/blocked` payload, failing closed on
 * a non-array value and on entries this codec cannot read.
 */
function requiredReadinessReasons(event: ProjectEventEnvelope, fields: Record<string, unknown>): WorkReadinessReason[] {
  const value = fields.reasons
  if (!Array.isArray(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "reasons" must be an array`,
    )
  }
  return value.map((entry, index): WorkReadinessReason => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProjectEventError(
        'malformed-event-payload',
        `project event ${event.sequenceNo} of "${event.projectId}" payload field "reasons[${index}]" must be an object`,
      )
    }
    const entryFields = entry as Record<string, unknown>
    const refId = entryFields.refId
    if (refId !== undefined && typeof refId !== 'string') {
      throw new ProjectEventError(
        'malformed-event-payload',
        `project event ${event.sequenceNo} of "${event.projectId}" payload field "reasons[${index}].refId" must be a string`,
      )
    }
    return refId === undefined
      ? { kind: requiredBlockerKind(entryFields, event, `reasons[${index}].kind`), message: requiredString(entryFields, event, 'message', `reasons[${index}].message`) }
      : { kind: requiredBlockerKind(entryFields, event, `reasons[${index}].kind`), refId, message: requiredString(entryFields, event, 'message', `reasons[${index}].message`) }
  })
}

/** Decode one `plan/imported` payload, failing closed on missing or mistyped fields. */
function decodePlanImportedPayload(event: ProjectEventEnvelope): PlanImportedPayload {
  const fields = payloadFields(event)
  return {
    planId: requiredString(fields, event, 'planId') as PlanId,
    planVersionId: requiredString(fields, event, 'planVersionId') as PlanVersionId,
    versionNo: requiredNumber(fields, event, 'versionNo'),
    sourceDocumentHash: requiredString(fields, event, 'sourceDocumentHash') as SourceDocumentHash,
  }
}

/** Decode one `work/created` payload, failing closed on missing or mistyped fields. */
function decodeWorkCreatedPayload(event: ProjectEventEnvelope): WorkCreatedPayload {
  const fields = payloadFields(event)
  return {
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    stableKey: requiredString(fields, event, 'stableKey'),
    title: requiredString(fields, event, 'title'),
    planVersionId: requiredString(fields, event, 'planVersionId') as PlanVersionId,
    status: requiredStatus(fields, event, 'status'),
    criteria: requiredCriteria(event, fields),
  }
}

/** Decode one plain status-move payload (`work/status-changed`, `work/unblocked`), failing closed on missing or mistyped fields. */
function decodeStatusMovePayload(event: ProjectEventEnvelope): StatusMovePayload {
  const fields = payloadFields(event)
  return {
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    fromStatus: requiredStatus(fields, event, 'fromStatus'),
    toStatus: requiredStatus(fields, event, 'toStatus'),
  }
}

/** Decode one `acceptance/evaluated` payload, failing closed on missing or mistyped fields. */
function decodeAcceptanceEvaluatedPayload(event: ProjectEventEnvelope): AcceptanceEvaluatedPayload {
  const fields = payloadFields(event)
  return {
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    criterionId: requiredString(fields, event, 'criterionId') as AcceptanceCriterionId,
    result: requiredEvaluationResult(fields, event, 'result'),
    status: requiredCriterionStatus(fields, event, 'status'),
  }
}

/** Read the lease facts shared by every lease lifecycle payload. */
function requiredLeaseRef(fields: Record<string, unknown>, event: ProjectEventEnvelope): WorkLeaseRefPayload {
  return {
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    leaseId: requiredString(fields, event, 'leaseId') as WorkLeaseId,
    workerIdentity: requiredString(fields, event, 'workerIdentity'),
  }
}

/** Decode one `work/claimed` payload, failing closed on missing or mistyped fields. */
function decodeWorkClaimedPayload(event: ProjectEventEnvelope): WorkClaimedPayload {
  const fields = payloadFields(event)
  return {
    ...requiredLeaseRef(fields, event),
    fromStatus: requiredStatus(fields, event, 'fromStatus'),
    toStatus: requiredStatus(fields, event, 'toStatus'),
    acquiredAtMs: requiredNumber(fields, event, 'acquiredAtMs'),
    expiresAtMs: requiredNumber(fields, event, 'expiresAtMs'),
  }
}

/** Decode one `work/lease-heartbeat` payload, failing closed on missing or mistyped fields. */
function decodeWorkLeaseHeartbeatPayload(event: ProjectEventEnvelope): WorkLeaseHeartbeatPayload {
  const fields = payloadFields(event)
  return {
    ...requiredLeaseRef(fields, event),
    expiresAtMs: requiredNumber(fields, event, 'expiresAtMs'),
  }
}

/** Decode one `work/lease-expired` or `work/lease-released` payload, failing closed on missing or mistyped fields. */
function decodeWorkLeaseEndedPayload(event: ProjectEventEnvelope): WorkLeaseEndedPayload {
  const fields = payloadFields(event)
  return {
    ...requiredLeaseRef(fields, event),
    toStatus: requiredStatus(fields, event, 'toStatus'),
  }
}

/** Decode one `work/blocked` payload, failing closed on missing or mistyped fields. */
function decodeWorkBlockedPayload(event: ProjectEventEnvelope): WorkBlockedPayload {
  const fields = payloadFields(event)
  return {
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    fromStatus: requiredStatus(fields, event, 'fromStatus'),
    toStatus: requiredStatus(fields, event, 'toStatus'),
    reasons: requiredReadinessReasons(event, fields),
  }
}

/** Read one required work-packet reference kind payload field. */
function requiredPacketReferenceKind(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  label: string,
): WorkPacketReferenceKind {
  const value = requiredString(fields, event, 'kind', label)
  if (!PACKET_REFERENCE_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" `
        + `is not a work packet reference kind: ${JSON.stringify(value)}`,
    )
  }
  return value as WorkPacketReferenceKind
}

/**
 * Decode the `references` array of one `project/work-packet-prepared`
 * payload, failing closed on a non-array value and on entries this codec
 * cannot read.
 */
function requiredPacketReferences(event: ProjectEventEnvelope, fields: Record<string, unknown>): ReplayedWorkPacketReference[] {
  const value = fields.references
  if (!Array.isArray(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "references" must be an array`,
    )
  }
  return value.map((entry, index): ReplayedWorkPacketReference => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProjectEventError(
        'malformed-event-payload',
        `project event ${event.sequenceNo} of "${event.projectId}" payload field "references[${index}]" must be an object`,
      )
    }
    const entryFields = entry as Record<string, unknown>
    return {
      kind: requiredPacketReferenceKind(entryFields, event, `references[${index}].kind`),
      refId: requiredString(entryFields, event, 'refId', `references[${index}].refId`),
      contentHash: requiredString(entryFields, event, 'contentHash', `references[${index}].contentHash`),
    }
  })
}

/**
 * Decode one `project/work-packet-prepared` payload into the recorded
 * recipe, failing closed on missing or mistyped fields. Exported for the
 * packet rebuild seam, which re-derives the packet from the recipe's rows.
 * @param event - the prepared-packet envelope to decode.
 * @returns the recipe exactly as recorded.
 * @throws {ProjectEventError} on `malformed-event-payload`.
 */
export function decodeWorkPacketPreparedPayload(event: ProjectEventEnvelope): WorkPacketPreparedPayload {
  const fields = payloadFields(event)
  return {
    packetId: requiredString(fields, event, 'packetId') as WorkPacketId,
    packetFormatVersion: requiredNumber(fields, event, 'packetFormatVersion'),
    builderVersion: requiredString(fields, event, 'builderVersion'),
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    planVersionId: requiredString(fields, event, 'planVersionId') as PlanVersionId,
    repoSnapshotId: requiredString(fields, event, 'repoSnapshotId'),
    references: requiredPacketReferences(event, fields),
    packetHash: requiredString(fields, event, 'packetHash'),
    serializedBytes: requiredNumber(fields, event, 'serializedBytes'),
  }
}

/**
 * Read the event that recorded one work packet, by packet id. The id embeds
 * the owning work item and the project-local sequence, so matching on the
 * row's entity id needs no project up front; the row still decodes through
 * the fail-closed reader.
 * @param db - open ledger database.
 * @param packetId - the prepared packet to look up.
 * @returns the envelope of the recording event, or `undefined` when no packet
 * carries that id.
 * @throws {ProjectEventError} the {@link readProjectEvents} row failures.
 */
export function readWorkPacketEvent(db: DatabaseSync, packetId: WorkPacketId): ProjectEventEnvelope | undefined {
  const row = db.prepare(
    'SELECT project_id, sequence_no, event_format_version, event_type, ignorable, entity_type, entity_id, '
    + 'actor_ref, payload_json, created_at_ms '
    + "FROM project_events WHERE event_type = 'project/work-packet-prepared' AND entity_id = ?",
  ).get(packetId) as unknown as (ProjectEventRow & { project_id: string }) | undefined
  if (row === undefined) return undefined
  // The project id crossed the durable project_events row boundary.
  return decodeEventRow(row.project_id as ProjectId, row)
}

/** Read one required string-or-null payload field. */
function requiredStringOrNull(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
  label: string = field,
): string | null {
  const value = fields[field]
  if (value !== null && typeof value !== 'string') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" must be a string or null`,
    )
  }
  return value
}

/** Read one optional string payload field; absent stays `undefined`, any present value must be a string. */
function optionalString(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
  label: string = field,
): string | undefined {
  const value = fields[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${label}" must be a string`,
    )
  }
  return value
}

/**
 * Decode the `reviewAttempts` array of one `plan/version-superseded`
 * payload, failing closed on a non-array value and on entries this codec
 * cannot read.
 */
function requiredReviewAttempts(event: ProjectEventEnvelope, fields: Record<string, unknown>): SupersededAttemptRef[] {
  const value = fields.reviewAttempts
  if (!Array.isArray(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "reviewAttempts" must be an array`,
    )
  }
  return value.map((entry, index): SupersededAttemptRef => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProjectEventError(
        'malformed-event-payload',
        `project event ${event.sequenceNo} of "${event.projectId}" payload field "reviewAttempts[${index}]" must be an object`,
      )
    }
    const entryFields = entry as Record<string, unknown>
    return {
      workItemId: requiredString(entryFields, event, 'workItemId', `reviewAttempts[${index}].workItemId`) as WorkItemId,
      leaseId: requiredString(entryFields, event, 'leaseId', `reviewAttempts[${index}].leaseId`) as WorkLeaseId,
      workerIdentity: requiredString(entryFields, event, 'workerIdentity', `reviewAttempts[${index}].workerIdentity`),
      expiresAtMs: requiredNumber(entryFields, event, 'expiresAtMs', `reviewAttempts[${index}].expiresAtMs`),
    }
  })
}

/** Decode one `plan/version-superseded` payload, failing closed on missing or mistyped fields. */
function decodePlanVersionSupersededPayload(event: ProjectEventEnvelope): PlanVersionSupersededPayload {
  const fields = payloadFields(event)
  const policy = requiredString(fields, event, 'policy')
  if (policy !== SUPERSEDE_POLICY) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "policy" `
        + `is not the supersede policy: ${JSON.stringify(policy)}`,
    )
  }
  return {
    planId: requiredString(fields, event, 'planId') as PlanId,
    planVersionId: requiredString(fields, event, 'planVersionId') as PlanVersionId,
    succeededBy: optionalString(fields, event, 'succeededBy') as PlanVersionId | undefined,
    policy,
    supersededAtMs: requiredNumber(fields, event, 'supersededAtMs'),
    reviewAttempts: requiredReviewAttempts(event, fields),
  }
}

/** Decode one `baseline/drift-detected` payload, failing closed on missing or mistyped fields. */
function decodeBaselineDriftDetectedPayload(event: ProjectEventEnvelope): BaselineDriftDetectedPayload {
  const fields = payloadFields(event)
  return {
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    planVersionId: requiredString(fields, event, 'planVersionId') as PlanVersionId,
    blockerId: requiredString(fields, event, 'blockerId') as WorkExternalBlockerId,
    baselineRepoHead: requiredStringOrNull(fields, event, 'baselineRepoHead'),
    baselineWorktreeHash: requiredStringOrNull(fields, event, 'baselineWorktreeHash'),
    observedRepoHead: requiredStringOrNull(fields, event, 'observedRepoHead'),
    observedWorktreeHash: requiredStringOrNull(fields, event, 'observedWorktreeHash'),
  }
}

/** Read one required blocking level payload field. */
function requiredBlockingLevel(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): DecisionBlockingLevel {
  const value = requiredString(fields, event, field)
  if (!DECISION_BLOCKING_LEVEL_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a decision blocking level: ${JSON.stringify(value)}`,
    )
  }
  return value as DecisionBlockingLevel
}

/**
 * Decode the `options` array of one `decision/requested` payload, failing
 * closed on a non-array value and on entries this codec cannot read.
 */
function requiredDecisionOptions(event: ProjectEventEnvelope, fields: Record<string, unknown>): DecisionRequestedOption[] {
  const value = fields.options
  if (!Array.isArray(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "options" must be an array`,
    )
  }
  return value.map((entry, index): DecisionRequestedOption => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProjectEventError(
        'malformed-event-payload',
        `project event ${event.sequenceNo} of "${event.projectId}" payload field "options[${index}]" must be an object`,
      )
    }
    const entryFields = entry as Record<string, unknown>
    return {
      optionKey: requiredString(entryFields, event, 'optionKey', `options[${index}].optionKey`),
      label: requiredString(entryFields, event, 'label', `options[${index}].label`),
      description: optionalString(entryFields, event, 'description', `options[${index}].description`),
      recommended: requiredBoolean(entryFields, event, 'recommended', `options[${index}].recommended`),
      ordinal: requiredNumber(entryFields, event, 'ordinal', `options[${index}].ordinal`),
    }
  })
}

/** Decode one `decision/requested` payload, failing closed on missing or mistyped fields. */
function decodeDecisionRequestedPayload(event: ProjectEventEnvelope): DecisionRequestedPayload {
  const fields = payloadFields(event)
  return {
    requestId: requiredString(fields, event, 'requestId') as DecisionRequestId,
    decisionKey: requiredString(fields, event, 'decisionKey'),
    title: requiredString(fields, event, 'title'),
    question: requiredString(fields, event, 'question'),
    context: optionalString(fields, event, 'context'),
    blockingLevel: requiredBlockingLevel(fields, event, 'blockingLevel'),
    raisedBy: optionalString(fields, event, 'raisedBy'),
    planVersionId: optionalString(fields, event, 'planVersionId') as PlanVersionId | undefined,
    options: requiredDecisionOptions(event, fields),
  }
}

/** Decode one `decision/recorded` payload, failing closed on missing or mistyped fields. */
function decodeDecisionRecordedPayload(event: ProjectEventEnvelope): DecisionRecordedPayload {
  const fields = payloadFields(event)
  return {
    requestId: requiredString(fields, event, 'requestId') as DecisionRequestId,
    decisionId: requiredString(fields, event, 'decisionId') as DecisionId,
    decidedBy: requiredString(fields, event, 'decidedBy'),
    selectedOptionKey: optionalString(fields, event, 'selectedOptionKey'),
    decisionText: requiredString(fields, event, 'decisionText'),
    rationale: optionalString(fields, event, 'rationale'),
    resolvedAtMs: requiredNumber(fields, event, 'resolvedAtMs'),
  }
}

/** Read one required approval subject type payload field. */
function requiredApprovalSubjectType(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): ApprovalSubjectType {
  const value = requiredString(fields, event, field)
  if (!APPROVAL_SUBJECT_TYPE_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not an approval subject type: ${JSON.stringify(value)}`,
    )
  }
  return value as ApprovalSubjectType
}

/** Read one required approval outcome payload field. */
function requiredApprovalOutcome(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): ApprovalDecisionOutcome {
  const value = requiredString(fields, event, field)
  if (!APPROVAL_OUTCOME_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not an approval outcome: ${JSON.stringify(value)}`,
    )
  }
  return value as ApprovalDecisionOutcome
}

/** Decode one `approval/requested` payload, failing closed on missing or mistyped fields. */
function decodeApprovalRequestedPayload(event: ProjectEventEnvelope): ApprovalRequestedPayload {
  const fields = payloadFields(event)
  return {
    approvalId: requiredString(fields, event, 'approvalId') as ApprovalId,
    subjectType: requiredApprovalSubjectType(fields, event, 'subjectType'),
    subjectId: requiredString(fields, event, 'subjectId'),
    requiredRole: optionalString(fields, event, 'requiredRole'),
    requestedBy: optionalString(fields, event, 'requestedBy'),
  }
}

/** Decode one `approval/decided` payload, failing closed on missing or mistyped fields. */
function decodeApprovalDecidedPayload(event: ProjectEventEnvelope): ApprovalDecidedPayload {
  const fields = payloadFields(event)
  return {
    approvalId: requiredString(fields, event, 'approvalId') as ApprovalId,
    outcome: requiredApprovalOutcome(fields, event, 'outcome'),
    decidedBy: requiredString(fields, event, 'decidedBy'),
    decisionText: requiredString(fields, event, 'decisionText'),
    decidedAtMs: requiredNumber(fields, event, 'decidedAtMs'),
  }
}

/** Read one required resource verification outcome payload field. */
function requiredResourceVerificationResult(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): ResourceVerificationResult {
  const value = requiredString(fields, event, field)
  if (!RESOURCE_VERIFICATION_RESULT_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a resource verification result: ${JSON.stringify(value)}`,
    )
  }
  return value as ResourceVerificationResult
}

/** Decode one `resource/required` payload, failing closed on missing or mistyped fields. */
function decodeResourceRequiredPayload(event: ProjectEventEnvelope): ResourceRequiredPayload {
  const fields = payloadFields(event)
  return {
    requirementId: requiredString(fields, event, 'requirementId') as ResourceRequirementId,
    requirementKey: requiredString(fields, event, 'requirementKey'),
    requirementKind: requiredString(fields, event, 'requirementKind'),
    name: requiredString(fields, event, 'name'),
    constraintsJson: requiredString(fields, event, 'constraintsJson'),
    requestedFrom: optionalString(fields, event, 'requestedFrom'),
    planVersionId: optionalString(fields, event, 'planVersionId') as PlanVersionId | undefined,
  }
}

/** Decode one `resource/provided` payload, failing closed on missing or mistyped fields. */
function decodeResourceProvidedPayload(event: ProjectEventEnvelope): ResourceProvidedPayload {
  const fields = payloadFields(event)
  return {
    instanceId: requiredString(fields, event, 'instanceId') as ResourceInstanceId,
    requirementId: requiredString(fields, event, 'requirementId') as ResourceRequirementId,
    label: requiredString(fields, event, 'label'),
    provider: optionalString(fields, event, 'provider'),
    metadataJson: optionalString(fields, event, 'metadataJson'),
  }
}

/** Read one required resource verifier kind payload field. */
function requiredResourceVerifierKind(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): ResourceVerifierKind {
  const value = requiredString(fields, event, field)
  if (!RESOURCE_VERIFIER_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a resource verifier kind: ${JSON.stringify(value)}`,
    )
  }
  return value as ResourceVerifierKind
}

/** Decode one `resource/verified` payload, failing closed on missing or mistyped fields. */
function decodeResourceVerifiedPayload(event: ProjectEventEnvelope): ResourceVerifiedPayload {
  const fields = payloadFields(event)
  return {
    verificationId: requiredString(fields, event, 'verificationId') as ResourceVerificationId,
    instanceId: requiredString(fields, event, 'instanceId') as ResourceInstanceId,
    verifierKind: requiredResourceVerifierKind(fields, event, 'verifierKind'),
    verifier: optionalString(fields, event, 'verifier'),
    verificationSpec: requiredString(fields, event, 'verificationSpec'),
    observedJson: optionalString(fields, event, 'observedJson'),
    result: requiredResourceVerificationResult(fields, event, 'result'),
    verifiedAtMs: requiredNumber(fields, event, 'verifiedAtMs'),
  }
}

/** Read one required actor kind payload field. */
function requiredActorKind(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string): ActorKind {
  const value = requiredString(fields, event, field)
  if (!ACTOR_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not an actor kind: ${JSON.stringify(value)}`,
    )
  }
  return value as ActorKind
}

/** Read one required role kind payload field. */
function requiredRoleKind(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string): RoleKind {
  const value = requiredString(fields, event, field)
  if (!ROLE_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a role kind: ${JSON.stringify(value)}`,
    )
  }
  return value as RoleKind
}

/** Decode one `actor/registered` payload, failing closed on missing or mistyped fields. */
function decodeActorRegisteredPayload(event: ProjectEventEnvelope): ActorRegisteredPayload {
  const fields = payloadFields(event)
  return {
    actorId: requiredString(fields, event, 'actorId') as ActorId,
    actorKey: requiredString(fields, event, 'actorKey'),
    actorKind: requiredActorKind(fields, event, 'actorKind'),
    displayName: requiredString(fields, event, 'displayName'),
    externalIdentity: optionalString(fields, event, 'externalIdentity'),
    metadataJson: optionalString(fields, event, 'metadataJson'),
  }
}

/** Decode one `role/defined` payload, failing closed on missing or mistyped fields. */
function decodeRoleDefinedPayload(event: ProjectEventEnvelope): RoleDefinedPayload {
  const fields = payloadFields(event)
  return {
    roleId: requiredString(fields, event, 'roleId') as RoleId,
    roleName: requiredString(fields, event, 'roleName'),
    roleKind: requiredRoleKind(fields, event, 'roleKind'),
    description: optionalString(fields, event, 'description'),
  }
}

/** Decode one `role/assigned` payload, failing closed on missing or mistyped fields. */
function decodeRoleAssignedPayload(event: ProjectEventEnvelope): RoleAssignedPayload {
  const fields = payloadFields(event)
  return {
    assignmentId: requiredString(fields, event, 'assignmentId') as ActorRoleId,
    actorId: requiredString(fields, event, 'actorId') as ActorId,
    roleId: requiredString(fields, event, 'roleId') as RoleId,
  }
}

/** Read one required work-assignment kind payload field. */
function requiredWorkAssignmentKind(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): WorkAssignmentKind {
  const value = requiredString(fields, event, field)
  if (!WORK_ASSIGNMENT_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a work-assignment kind: ${JSON.stringify(value)}`,
    )
  }
  return value as WorkAssignmentKind
}

/** Decode one `work/assigned` payload, failing closed on missing or mistyped fields. */
function decodeWorkAssignedPayload(event: ProjectEventEnvelope): WorkAssignedPayload {
  const fields = payloadFields(event)
  return {
    assignmentId: requiredString(fields, event, 'assignmentId') as WorkAssignmentId,
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    actorId: requiredString(fields, event, 'actorId') as ActorId,
    roleId: optionalString(fields, event, 'roleId') as RoleId | undefined,
    assignmentKind: requiredWorkAssignmentKind(fields, event, 'assignmentKind'),
  }
}

/** Read one required handoff-kind payload field. */
function requiredHandoffKind(
  fields: Record<string, unknown>,
  event: ProjectEventEnvelope,
  field: string,
): HandoffKind {
  const value = requiredString(fields, event, field)
  if (!HANDOFF_KIND_SET.has(value)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" `
        + `is not a handoff kind: ${JSON.stringify(value)}`,
    )
  }
  return value as HandoffKind
}

/** Decode one `handoff/recorded` payload, failing closed on missing or mistyped fields. */
function decodeHandoffRecordedPayload(event: ProjectEventEnvelope): HandoffRecordedPayload {
  const fields = payloadFields(event)
  const toActorId = optionalString(fields, event, 'toActorId') as ActorId | undefined
  const toRoleId = optionalString(fields, event, 'toRoleId') as RoleId | undefined
  if ((toActorId === undefined) === (toRoleId === undefined)) {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" must name exactly one handoff `
        + 'recipient: toActorId or toRoleId',
    )
  }
  return {
    handoffId: requiredString(fields, event, 'handoffId') as HandoffId,
    workItemId: requiredString(fields, event, 'workItemId') as WorkItemId,
    fromActorId: requiredString(fields, event, 'fromActorId') as ActorId,
    toActorId,
    toRoleId,
    handoffKind: requiredHandoffKind(fields, event, 'handoffKind'),
    summary: requiredString(fields, event, 'summary'),
    artifactRefsJson: optionalString(fields, event, 'artifactRefsJson'),
    memoryRefsJson: optionalString(fields, event, 'memoryRefsJson'),
  }
}
