/**
 * The v1.6d stage-B collaboration-conflict domain (blueprint §29, adapted
 * like the assignment, handoff, and scope-reservation domains): one recorded
 * overlap that slipped through the scope reservations — the equal-value
 * uniqueness check does not judge containment, so two reserved repository
 * paths can still collide. {@link recordConflict} gives the conflict its row
 * and event; {@link resolveConflict} closes it through a v1.6b decision, the
 * ledger's recorded answer to the question the conflict asks. Every write
 * runs in one `BEGIN IMMEDIATE` transaction; conflict ids derive from the
 * event's timeline sequence (`cf:<projectId>:<sequence>`). The blueprint's
 * `description_content_id` indirection becomes inline description text, the
 * blueprint's nullable `raised_by_actor_id` and work-item columns close to
 * required, and `project_id` derives through the first work item row.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/collaboration-conflicts
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ActorId } from './actors.js'
import { CONFLICT_KINDS, type ConflictKind } from './project-events.js'
import type { DecisionId } from './decisions.js'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one collaboration-conflict row (`collaboration_conflicts.id`). */
export type ConflictId = Branded<'ConflictId'>

/** The controlled status of one conflict; both statuses have writers. */
export type ConflictStatus = 'OPEN' | 'RESOLVED'

/** Actor recorded on conflict events when the caller does not name one. */
export const DEFAULT_CONFLICT_ACTOR_REF = 'dsh-experimental-project-ledger/collaboration-conflicts'

/** Closed set of collaboration-conflict rejection reasons. */
export type ConflictErrorCode =
  | 'invalid-argument'
  | 'unknown-work-item'
  | 'unknown-actor'
  | 'unknown-decision'
  | 'unknown-conflict'
  | 'conflict-not-open'

/**
 * Thrown when a collaboration-conflict write is rejected on ledger state or
 * input. The failing transaction has already rolled back, so the rejection
 * itself never writes.
 */
export class ConflictError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ConflictErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: ConflictErrorCode, message: string) {
    super(message)
    this.name = 'ConflictError'
    this.code = code
  }
}

/** The conflict {@link recordConflict} records. */
export interface RecordConflictInput {
  /** One side of the overlap; its project scopes the conflict. */
  readonly workItemAId: WorkItemId
  /** The other side; a different work item of the same project. */
  readonly workItemBId: WorkItemId
  /** The actor reporting the overlap; registered in the items' project. */
  readonly raisedByActorId: ActorId
  /** The conflict's kind; the closed set lives with the event codec. */
  readonly conflictKind: ConflictKind
  /** The recorded account of what overlaps and how it was noticed. */
  readonly description: string
}

/** Options every conflict write shares. */
export interface ConflictWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_CONFLICT_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One collaboration conflict as {@link readProjectConflicts} lists it. */
export interface Conflict {
  readonly conflictId: ConflictId
  readonly projectId: ProjectId
  readonly workItemAId: WorkItemId
  /** The first item's stable key, resolved through the work item row. */
  readonly stableKeyA: string
  readonly workItemBId: WorkItemId
  /** The second item's stable key, resolved through the work item row. */
  readonly stableKeyB: string
  readonly raisedByActorId: ActorId
  /** The raising actor's project key, resolved through the actors row. */
  readonly raisedByKey: string
  readonly conflictKind: ConflictKind
  readonly description: string
  readonly status: ConflictStatus
  /** The v1.6b decision the resolution recorded; unset while `OPEN`. */
  readonly resolutionDecisionId: DecisionId | undefined
  readonly createdAtMs: number
  /** Set exactly on `RESOLVED` rows; `OPEN` rows hold no resolution. */
  readonly resolvedAtMs: number | undefined
}

/** The result of {@link resolveConflict}. */
export interface ResolvedConflict {
  readonly conflictId: ConflictId
  readonly resolutionDecisionId: DecisionId
  readonly resolvedAtMs: number
}

/** Reject an input string that must carry content. */
function requireNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new ConflictError('invalid-argument', `${field} must not be empty`)
  }
}

/**
 * Record one collaboration conflict: validate the inputs, refuse a
 * self-conflict, then record the conflict and one `conflict/recorded` event
 * in a single `BEGIN IMMEDIATE` transaction. The two work items must be
 * distinct rows of one project — a conflict records two work streams that
 * collided, not one stream reported twice.
 * @param db - open ledger database.
 * @param input - the two items, the raising actor, the kind, and the account.
 * @param options - actor and clock overrides.
 * @returns the recorded open conflict.
 * @throws {ConflictError} on `invalid-argument`, `unknown-work-item`, and
 * `unknown-actor`.
 */
export function recordConflict(
  db: DatabaseSync,
  input: RecordConflictInput,
  options: ConflictWriteOptions = {},
): Conflict {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_CONFLICT_ACTOR_REF
  if (!CONFLICT_KINDS.includes(input.conflictKind)) {
    throw new ConflictError(
      'invalid-argument',
      `conflictKind must be one of ${CONFLICT_KINDS.join(', ')}, got ${JSON.stringify(input.conflictKind)}`,
    )
  }
  requireNonEmpty('description', input.description)
  if (input.workItemAId === input.workItemBId) {
    throw new ConflictError(
      'invalid-argument',
      `the two work items must differ, got ${input.workItemAId} twice`,
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const itemA = db.prepare('SELECT id, project_id, stable_key FROM work_items WHERE id = ?')
      .get(input.workItemAId) as { id: string; project_id: string; stable_key: string } | undefined
    if (itemA === undefined) {
      throw new ConflictError(
        'unknown-work-item',
        `work item "${input.workItemAId}" is not recorded in this ledger`,
      )
    }
    const itemB = db.prepare('SELECT id, project_id, stable_key FROM work_items WHERE id = ?')
      .get(input.workItemBId) as { id: string; project_id: string; stable_key: string } | undefined
    if (itemB === undefined || itemB.project_id !== itemA.project_id) {
      throw new ConflictError(
        'unknown-work-item',
        `work item "${input.workItemBId}" is not recorded in project "${itemA.project_id}"`,
      )
    }
    const actor = db.prepare('SELECT id, project_id, actor_key FROM actors WHERE id = ?')
      .get(input.raisedByActorId) as { id: string; project_id: string; actor_key: string } | undefined
    if (actor === undefined || actor.project_id !== itemA.project_id) {
      throw new ConflictError(
        'unknown-actor',
        `actor "${input.raisedByActorId}" is not registered in project "${itemA.project_id}"`,
      )
    }
    const projectId = brandString<ProjectId>(itemA.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the conflict id is its event's.
    const conflictId = brandString<ConflictId>(
      `cf:${itemA.project_id}:${nextProjectEventSequence(db, projectId)}`,
    )
    appendProjectEvent(
      db,
      projectId,
      'conflict/recorded',
      {
        conflictId,
        workItemAId: input.workItemAId,
        workItemBId: input.workItemBId,
        raisedByActorId: input.raisedByActorId,
        conflictKind: input.conflictKind,
        description: input.description,
      },
      { entityType: 'collaboration_conflict', entityId: conflictId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO collaboration_conflicts '
      + '(id, work_item_a, work_item_b, raised_by_actor_id, conflict_kind, description, status, '
      + 'resolution_decision_id, created_at_ms, resolved_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      conflictId,
      input.workItemAId,
      input.workItemBId,
      input.raisedByActorId,
      input.conflictKind,
      input.description,
      'OPEN',
      null,
      nowMs,
      null,
    )
    db.exec('COMMIT')
    return {
      conflictId,
      projectId,
      workItemAId: input.workItemAId,
      stableKeyA: itemA.stable_key,
      workItemBId: input.workItemBId,
      stableKeyB: itemB.stable_key,
      raisedByActorId: input.raisedByActorId,
      raisedByKey: actor.actor_key,
      conflictKind: input.conflictKind,
      description: input.description,
      status: 'OPEN',
      resolutionDecisionId: undefined,
      createdAtMs: nowMs,
      resolvedAtMs: undefined,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Resolve one open conflict through a v1.6b decision: record the
 * `conflict/resolved` event and move the row in a single `BEGIN IMMEDIATE`
 * transaction. The decision must be a recorded decision of the conflict's
 * project; a resolved conflict never resolves again.
 * @param db - open ledger database.
 * @param conflictId - the conflict to resolve.
 * @param resolutionDecisionId - the recorded decision answering the conflict.
 * @param options - actor and clock overrides.
 * @returns the resolution facts.
 * @throws {ConflictError} on `unknown-conflict`, `conflict-not-open`, and
 * `unknown-decision`.
 */
export function resolveConflict(
  db: DatabaseSync,
  conflictId: ConflictId,
  resolutionDecisionId: DecisionId,
  options: ConflictWriteOptions = {},
): ResolvedConflict {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_CONFLICT_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(
      'SELECT c.id, w.project_id, c.status FROM collaboration_conflicts c '
      + 'JOIN work_items w ON w.id = c.work_item_a WHERE c.id = ?',
    ).get(conflictId) as { id: string; project_id: string; status: ConflictStatus } | undefined
    if (row === undefined) {
      throw new ConflictError(
        'unknown-conflict',
        `collaboration conflict "${conflictId}" is not recorded in this ledger`,
      )
    }
    if (row.status !== 'OPEN') {
      throw new ConflictError(
        'conflict-not-open',
        `collaboration conflict "${conflictId}" is ${row.status} and cannot resolve`,
      )
    }
    const decision = db.prepare(
      'SELECT d.id FROM decisions d JOIN decision_requests r ON r.id = d.decision_request_id '
      + 'WHERE d.id = ? AND r.project_id = ?',
    ).get(resolutionDecisionId, row.project_id) as { id: string } | undefined
    if (decision === undefined) {
      throw new ConflictError(
        'unknown-decision',
        `decision "${resolutionDecisionId}" is not a recorded decision of project "${row.project_id}"`,
      )
    }
    appendProjectEvent(
      db,
      brandString<ProjectId>(row.project_id),
      'conflict/resolved',
      { conflictId, resolutionDecisionId },
      { entityType: 'collaboration_conflict', entityId: conflictId, actorRef, nowMs },
    )
    db.prepare(
      "UPDATE collaboration_conflicts SET status = 'RESOLVED', resolution_decision_id = ?, resolved_at_ms = ? "
      + 'WHERE id = ? AND status = \'OPEN\'',
    ).run(resolutionDecisionId, nowMs, conflictId)
    db.exec('COMMIT')
    return { conflictId, resolutionDecisionId, resolvedAtMs: nowMs }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One `collaboration_conflicts` row the read joins, in select order. */
interface ConflictRow {
  readonly id: string
  readonly project_id: string
  readonly work_item_a: string
  readonly stable_key_a: string
  readonly work_item_b: string
  readonly stable_key_b: string
  readonly raised_by_actor_id: string
  readonly raised_by_key: string
  readonly conflict_kind: ConflictKind
  readonly description: string
  readonly status: ConflictStatus
  readonly resolution_decision_id: string | null
  readonly created_at_ms: number
  readonly resolved_at_ms: number | null
}

/**
 * List one project's collaboration conflicts newest-first, with the two
 * items, the raiser, and the resolution decision resolved through joins.
 * @param db - open ledger database.
 * @param projectId - project whose conflicts are read.
 * @returns the conflicts; a project the ledger records no conflict for reads
 * as empty.
 */
export function readProjectConflicts(db: DatabaseSync, projectId: ProjectId): readonly Conflict[] {
  const rows = db.prepare(
    'SELECT c.id, wa.project_id, c.work_item_a, wa.stable_key AS stable_key_a, c.work_item_b, '
    + 'wb.stable_key AS stable_key_b, c.raised_by_actor_id, act.actor_key AS raised_by_key, '
    + 'c.conflict_kind, c.description, c.status, c.resolution_decision_id, c.created_at_ms, c.resolved_at_ms '
    + 'FROM collaboration_conflicts c '
    + 'JOIN work_items wa ON wa.id = c.work_item_a '
    + 'JOIN work_items wb ON wb.id = c.work_item_b '
    + 'JOIN actors act ON act.id = c.raised_by_actor_id '
    + 'WHERE wa.project_id = ? ORDER BY c.created_at_ms DESC, c.id',
  ).all(projectId) as unknown as ConflictRow[]
  return rows.map(row => ({
    conflictId: brandString<ConflictId>(row.id),
    projectId: brandString<ProjectId>(row.project_id),
    workItemAId: brandString<WorkItemId>(row.work_item_a),
    stableKeyA: row.stable_key_a,
    workItemBId: brandString<WorkItemId>(row.work_item_b),
    stableKeyB: row.stable_key_b,
    raisedByActorId: brandString<ActorId>(row.raised_by_actor_id),
    raisedByKey: row.raised_by_key,
    conflictKind: row.conflict_kind,
    description: row.description,
    status: row.status,
    resolutionDecisionId: row.resolution_decision_id === null
      ? undefined
      : brandString<DecisionId>(row.resolution_decision_id),
    createdAtMs: row.created_at_ms,
    resolvedAtMs: row.resolved_at_ms ?? undefined,
  }))
}
