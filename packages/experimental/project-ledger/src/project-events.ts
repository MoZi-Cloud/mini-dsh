/**
 * Versioned append-only project events (v1.6a F13, attachment §11/§15/§16):
 * the envelope every ledger writer stamps, the v1 vocabulary, and the
 * fail-closed read/replay codec. {@link appendProjectEvent} allocates the
 * `project_events` sequence and is called inside the writer's own
 * `BEGIN IMMEDIATE` transaction, per the §15 concept order. Reading fails
 * closed on rows this codec cannot interpret: an unknown event type recorded
 * as required, or any foreign `event_format_version`. Unknown ignorable rows
 * are observational extensions from a newer writer — the reader preserves
 * them, and replay changes no state for them; they must never carry
 * projection semantics (§16).
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/project-events
 */

import { DatabaseSync } from 'node:sqlite'
import type { PlanId, PlanVersionId, ProjectId, SourceDocumentHash, WorkItemId } from './plan-compile.js'

/**
 * The event envelope version recorded in the `event_format_version` column of
 * every `project_events` row — the single home of this constant. Adding a
 * required vocabulary entry bumps it together with the codec; purely
 * observational events must not.
 */
export const PROJECT_EVENT_FORMAT_VERSION = 1

/**
 * The §16 v1 vocabulary. Every listed type is required: rows carry
 * `ignorable = 0`, replay knows their projection effect (this build applies
 * `plan/imported` and `work/created`), and a reader that does not know the
 * type fails closed.
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
  const sequenceNo = (db
    .prepare('SELECT COALESCE(MAX(sequence_no), 0) AS max_sequence FROM project_events WHERE project_id = ?')
    .get(projectId) as { max_sequence: number }).max_sequence + 1
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
  if (row.event_format_version !== PROJECT_EVENT_FORMAT_VERSION) {
    throw new ProjectEventError(
      'event-format-unsupported',
      `project event ${row.sequence_no} of "${projectId}" carries event format ${row.event_format_version}; `
        + `this build reads format ${PROJECT_EVENT_FORMAT_VERSION}`,
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

/** Work-item facts carried by a `work/created` event. */
export interface ReplayedWorkItem {
  readonly stableKey: string
  readonly title: string
  readonly planVersionId: PlanVersionId
}

/** The projection replaying a project's events rebuilds. */
export interface ReplayedProjectProjection {
  readonly planVersions: ReadonlyMap<PlanVersionId, ReplayedPlanVersion>
  readonly workItems: ReadonlyMap<WorkItemId, ReplayedWorkItem>
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
        })
        break
      }
      default:
        break
    }
  }
  return { planVersions, workItems }
}

/** Payload facts of one `plan/imported` event. */
interface PlanImportedPayload {
  readonly planId: PlanId
  readonly planVersionId: PlanVersionId
  readonly versionNo: number
  readonly sourceDocumentHash: SourceDocumentHash
}

/** Payload facts of one `work/created` event. */
interface WorkCreatedPayload {
  readonly workItemId: WorkItemId
  readonly stableKey: string
  readonly title: string
  readonly planVersionId: PlanVersionId
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
 */
function requiredString(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string): string {
  const value = fields[field]
  if (typeof value !== 'string') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" must be a string`,
    )
  }
  return value
}

/** Read one required number payload field. */
function requiredNumber(fields: Record<string, unknown>, event: ProjectEventEnvelope, field: string): number {
  const value = fields[field]
  if (typeof value !== 'number') {
    throw new ProjectEventError(
      'malformed-event-payload',
      `project event ${event.sequenceNo} of "${event.projectId}" payload field "${field}" must be a number`,
    )
  }
  return value
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
  }
}
