/**
 * The v1.6d handoff domain (blueprint §28, stage A of the v1.6d scope
 * proposal): one recorded pass of a work item between actors. {@link
 * recordHandoff} writes the handoff and its `handoff/recorded` event
 * atomically; {@link readProjectHandoffs} lists the project's handoffs
 * newest-first with their item, sender, and recipient labels resolved
 * through joins. Every write runs in one `BEGIN IMMEDIATE` transaction;
 * handoff ids derive from the event's timeline sequence
 * (`ho:<projectId>:<sequence>`), because one item passes between actors
 * repeatedly. The recipient is an actor or a role — exactly one. The
 * blueprint's `summary_content_id` indirection becomes inline summary text,
 * and artifact and memory references ride as JSON objects the seam
 * serializes. `accepted_at_ms` is reserved with no writer yet.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/handoffs
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { HANDOFF_KINDS, type HandoffKind } from './project-events.js'
import type { ActorId, RoleId } from './actors.js'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one handoff row (`handoffs.id`). */
export type HandoffId = Branded<'HandoffId'>

/** Actor recorded on handoff events when the caller does not name one. */
export const DEFAULT_HANDOFF_ACTOR_REF = 'dsh-experimental-project-ledger/handoffs'

/** Closed set of handoff-domain rejection reasons. */
export type HandoffErrorCode =
  | 'invalid-argument'
  | 'unknown-work-item'
  | 'unknown-actor'
  | 'unknown-role'

/**
 * Thrown when a handoff write is rejected on ledger state or input. The
 * failing transaction has already rolled back, so the rejection itself
 * never writes.
 */
export class HandoffError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: HandoffErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: HandoffErrorCode, message: string) {
    super(message)
    this.name = 'HandoffError'
    this.code = code
  }
}

/** The handoff {@link recordHandoff} records. */
export interface RecordHandoffInput {
  readonly workItemId: WorkItemId
  /** The actor the item passes from. */
  readonly fromActorId: ActorId
  /** The actor the item passes to, when the recipient names one. */
  readonly toActorId?: ActorId | undefined
  /** The role the item passes to, when the recipient names one. */
  readonly toRoleId?: RoleId | undefined
  readonly handoffKind: HandoffKind
  /** The inline pass-along summary the blueprint records through content indirection. */
  readonly summary: string
  /** Structured artifact references, serialized to `artifact_refs_json`. */
  readonly artifactRefs?: Record<string, unknown> | undefined
  /** Structured memory references, serialized to `memory_refs_json`. */
  readonly memoryRefs?: Record<string, unknown> | undefined
}

/** Options every handoff write shares. */
export interface HandoffWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_HANDOFF_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One handoff as {@link readProjectHandoffs} lists it. */
export interface Handoff {
  readonly handoffId: HandoffId
  readonly workItemId: WorkItemId
  /** The handed item's stable key, resolved through the work item row. */
  readonly stableKey: string
  readonly fromActorId: ActorId
  /** The sending actor's project key, resolved through the actors row. */
  readonly fromActorKey: string
  readonly toActorId: ActorId | undefined
  /** The recipient actor's project key, resolved through the actors row. */
  readonly toActorKey: string | undefined
  readonly toRoleId: RoleId | undefined
  /** The recipient role's project name, resolved through the roles row. */
  readonly toRoleName: string | undefined
  readonly handoffKind: HandoffKind
  readonly summary: string
  readonly artifactRefsJson: string | undefined
  readonly memoryRefsJson: string | undefined
  readonly recordedAtMs: number
}

/**
 * Record one pass of a work item between actors: validate the inputs, then
 * record the handoff and one `handoff/recorded` event in a single `BEGIN
 * IMMEDIATE` transaction. The sender, the recipient actor when one is
 * named, and the recipient role when one is named must belong to the item's
 * project; exactly one of the recipient actor and recipient role is
 * required.
 * @param db - open ledger database.
 * @param input - the item, the sender, the recipient, the kind, and the summary.
 * @param options - actor and clock overrides.
 * @returns the recorded handoff.
 * @throws {HandoffError} on `invalid-argument`, `unknown-work-item`,
 * `unknown-actor`, and `unknown-role`.
 */
export function recordHandoff(
  db: DatabaseSync,
  input: RecordHandoffInput,
  options: HandoffWriteOptions = {},
): Handoff {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_HANDOFF_ACTOR_REF
  if (!HANDOFF_KINDS.includes(input.handoffKind)) {
    throw new HandoffError(
      'invalid-argument',
      `handoffKind must be one of ${HANDOFF_KINDS.join(', ')}, got ${JSON.stringify(input.handoffKind)}`,
    )
  }
  if ((input.toActorId === undefined) === (input.toRoleId === undefined)) {
    throw new HandoffError(
      'invalid-argument',
      'a handoff names exactly one recipient: pass toActorId or toRoleId, not both or neither',
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const item = db.prepare('SELECT id, project_id, stable_key FROM work_items WHERE id = ?')
      .get(input.workItemId) as { id: string; project_id: string; stable_key: string } | undefined
    if (item === undefined) {
      throw new HandoffError('unknown-work-item', `work item "${input.workItemId}" is not recorded in this ledger`)
    }
    const fromActor = db.prepare('SELECT id, project_id, actor_key FROM actors WHERE id = ?')
      .get(input.fromActorId) as { id: string; project_id: string; actor_key: string } | undefined
    if (fromActor === undefined || fromActor.project_id !== item.project_id) {
      throw new HandoffError(
        'unknown-actor',
        `actor "${input.fromActorId}" is not registered in project "${item.project_id}"`,
      )
    }
    let toActorKey: string | undefined
    if (input.toActorId !== undefined) {
      const toActor = db.prepare('SELECT id, project_id, actor_key FROM actors WHERE id = ?')
        .get(input.toActorId) as { id: string; project_id: string; actor_key: string } | undefined
      if (toActor === undefined || toActor.project_id !== item.project_id) {
        throw new HandoffError(
          'unknown-actor',
          `actor "${input.toActorId}" is not registered in project "${item.project_id}"`,
        )
      }
      toActorKey = toActor.actor_key
    }
    let toRoleName: string | undefined
    if (input.toRoleId !== undefined) {
      const toRole = db.prepare('SELECT id, project_id, role_name FROM roles WHERE id = ?')
        .get(input.toRoleId) as { id: string; project_id: string; role_name: string } | undefined
      if (toRole === undefined || toRole.project_id !== item.project_id) {
        throw new HandoffError(
          'unknown-role',
          `role "${input.toRoleId}" is not defined for project "${item.project_id}"`,
        )
      }
      toRoleName = toRole.role_name
    }
    const projectId = brandString<ProjectId>(item.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the handoff id is its event's.
    const handoffId = brandString<HandoffId>(`ho:${item.project_id}:${nextProjectEventSequence(db, projectId)}`)
    const artifactRefsJson = input.artifactRefs === undefined ? undefined : JSON.stringify(input.artifactRefs)
    const memoryRefsJson = input.memoryRefs === undefined ? undefined : JSON.stringify(input.memoryRefs)
    appendProjectEvent(
      db,
      projectId,
      'handoff/recorded',
      {
        handoffId,
        workItemId: input.workItemId,
        fromActorId: input.fromActorId,
        ...(input.toActorId === undefined ? {} : { toActorId: input.toActorId }),
        ...(input.toRoleId === undefined ? {} : { toRoleId: input.toRoleId }),
        handoffKind: input.handoffKind,
        summary: input.summary,
        ...(artifactRefsJson === undefined ? {} : { artifactRefsJson }),
        ...(memoryRefsJson === undefined ? {} : { memoryRefsJson }),
      },
      { entityType: 'handoff', entityId: handoffId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO handoffs '
      + '(id, work_item_id, from_actor_id, to_actor_id, to_role_id, handoff_kind, summary, '
      + 'artifact_refs_json, memory_refs_json, recorded_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      handoffId,
      input.workItemId,
      input.fromActorId,
      input.toActorId ?? null,
      input.toRoleId ?? null,
      input.handoffKind,
      input.summary,
      artifactRefsJson ?? null,
      memoryRefsJson ?? null,
      nowMs,
    )
    db.exec('COMMIT')
    return {
      handoffId,
      workItemId: input.workItemId,
      stableKey: item.stable_key,
      fromActorId: input.fromActorId,
      fromActorKey: fromActor.actor_key,
      toActorId: input.toActorId,
      toActorKey,
      toRoleId: input.toRoleId,
      toRoleName,
      handoffKind: input.handoffKind,
      summary: input.summary,
      artifactRefsJson,
      memoryRefsJson,
      recordedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One `handoffs` row the read joins, in select order. */
interface HandoffRow {
  readonly id: string
  readonly work_item_id: string
  readonly stable_key: string
  readonly from_actor_id: string
  readonly from_actor_key: string
  readonly to_actor_id: string | null
  readonly to_actor_key: string | null
  readonly to_role_id: string | null
  readonly to_role_name: string | null
  readonly handoff_kind: HandoffKind
  readonly summary: string
  readonly artifact_refs_json: string | null
  readonly memory_refs_json: string | null
  readonly recorded_at_ms: number
}

/**
 * List one project's handoffs newest-first, with the item, sender, and
 * recipient labels resolved through joins.
 * @param db - open ledger database.
 * @param projectId - project whose handoffs are read.
 * @returns the handoffs; a project the ledger records no handoff for reads
 * as empty.
 */
export function readProjectHandoffs(db: DatabaseSync, projectId: ProjectId): readonly Handoff[] {
  const rows = db.prepare(
    'SELECT h.id, h.work_item_id, w.stable_key, h.from_actor_id, f.actor_key AS from_actor_key, '
    + 'h.to_actor_id, t.actor_key AS to_actor_key, h.to_role_id, r.role_name AS to_role_name, '
    + 'h.handoff_kind, h.summary, h.artifact_refs_json, h.memory_refs_json, h.recorded_at_ms '
    + 'FROM handoffs h '
    + 'JOIN work_items w ON w.id = h.work_item_id '
    + 'JOIN actors f ON f.id = h.from_actor_id '
    + 'LEFT JOIN actors t ON t.id = h.to_actor_id '
    + 'LEFT JOIN roles r ON r.id = h.to_role_id '
    + 'WHERE w.project_id = ? ORDER BY h.recorded_at_ms DESC, h.id',
  ).all(projectId) as unknown as HandoffRow[]
  return rows.map(row => ({
    handoffId: brandString<HandoffId>(row.id),
    workItemId: brandString<WorkItemId>(row.work_item_id),
    stableKey: row.stable_key,
    fromActorId: brandString<ActorId>(row.from_actor_id),
    fromActorKey: row.from_actor_key,
    toActorId: row.to_actor_id === null ? undefined : brandString<ActorId>(row.to_actor_id),
    toActorKey: row.to_actor_key ?? undefined,
    toRoleId: row.to_role_id === null ? undefined : brandString<RoleId>(row.to_role_id),
    toRoleName: row.to_role_name ?? undefined,
    handoffKind: row.handoff_kind,
    summary: row.summary,
    artifactRefsJson: row.artifact_refs_json ?? undefined,
    memoryRefsJson: row.memory_refs_json ?? undefined,
    recordedAtMs: row.recorded_at_ms,
  }))
}
