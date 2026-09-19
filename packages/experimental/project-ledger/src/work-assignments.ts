/**
 * The v1.6d work-assignment domain (blueprint §18, stage A of the v1.6d
 * scope proposal): a project records which actor holds which duty on which
 * work item. {@link assignWorkItem} writes the assignment and its
 * `work/assigned` event atomically; {@link readProjectWorkAssignments}
 * lists the project's assignments newest-first with their item, actor, and
 * role labels resolved through joins. Every write runs in one `BEGIN
 * IMMEDIATE` transaction; assignment ids derive from the event's timeline
 * sequence (`wa:<projectId>:<sequence>`), because an item's PRIMARY duty
 * can end and be reassigned. The PRIMARY duty is singular: the schema's
 * partial unique index over live PRIMARY rows and this seam both refuse a
 * second. `ENDED` and the acceptance and completion timestamps are reserved
 * with no writer yet.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/work-assignments
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { WORK_ASSIGNMENT_KINDS, type WorkAssignmentKind } from './project-events.js'
import type { ActorId, RoleId } from './actors.js'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one work-assignment row (`work_assignments.id`). */
export type WorkAssignmentId = Branded<'WorkAssignmentId'>

/** The controlled status of one work-assignment row; only `ACTIVE` has a writer. */
export type WorkAssignmentStatus = 'ACTIVE' | 'ENDED'

/** Actor recorded on work-assignment events when the caller does not name one. */
export const DEFAULT_WORK_ASSIGNMENT_ACTOR_REF = 'dsh-experimental-project-ledger/work-assignments'

/** Closed set of work-assignment-domain rejection reasons. */
export type WorkAssignmentErrorCode =
  | 'invalid-argument'
  | 'unknown-work-item'
  | 'unknown-actor'
  | 'unknown-role'
  | 'duplicate-assignment'

/**
 * Thrown when a work-assignment write is rejected on ledger state or input.
 * The failing transaction has already rolled back, so the rejection itself
 * never writes.
 */
export class WorkAssignmentError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: WorkAssignmentErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: WorkAssignmentErrorCode, message: string) {
    super(message)
    this.name = 'WorkAssignmentError'
    this.code = code
  }
}

/** The assignment {@link assignWorkItem} records. */
export interface AssignWorkItemInput {
  readonly workItemId: WorkItemId
  readonly actorId: ActorId
  readonly assignmentKind: WorkAssignmentKind
  /** The role the duty names, when it names one (blueprint §18's nullable role). */
  readonly roleId?: RoleId | undefined
}

/** Options every work-assignment write shares. */
export interface WorkAssignmentWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_WORK_ASSIGNMENT_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One work assignment as {@link readProjectWorkAssignments} lists it. */
export interface WorkAssignment {
  readonly assignmentId: WorkAssignmentId
  readonly workItemId: WorkItemId
  /** The assigned item's stable key, resolved through the work item row. */
  readonly stableKey: string
  readonly actorId: ActorId
  /** The assigned actor's project key, resolved through the actors row. */
  readonly actorKey: string
  readonly roleId: RoleId | undefined
  /** The named role's project name, resolved through the roles row. */
  readonly roleName: string | undefined
  readonly assignmentKind: WorkAssignmentKind
  readonly status: WorkAssignmentStatus
  readonly assignedAtMs: number
}

/**
 * Assign one actor one duty on one work item: validate the inputs, then
 * record the assignment and one `work/assigned` event in a single `BEGIN
 * IMMEDIATE` transaction. The actor, and the role when one is named, must
 * belong to the item's project; a work item holds at most one live PRIMARY
 * assignment (the schema's partial unique index and this seam both refuse a
 * second).
 * @param db - open ledger database.
 * @param input - the item, the actor, the duty, and the optional role.
 * @param options - actor and clock overrides.
 * @returns the recorded live assignment.
 * @throws {WorkAssignmentError} on `invalid-argument`, `unknown-work-item`,
 * `unknown-actor`, `unknown-role`, and `duplicate-assignment`.
 */
export function assignWorkItem(
  db: DatabaseSync,
  input: AssignWorkItemInput,
  options: WorkAssignmentWriteOptions = {},
): WorkAssignment {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_WORK_ASSIGNMENT_ACTOR_REF
  if (!WORK_ASSIGNMENT_KINDS.includes(input.assignmentKind)) {
    throw new WorkAssignmentError(
      'invalid-argument',
      `assignmentKind must be one of ${WORK_ASSIGNMENT_KINDS.join(', ')}, got ${JSON.stringify(input.assignmentKind)}`,
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const item = db.prepare('SELECT id, project_id, stable_key FROM work_items WHERE id = ?')
      .get(input.workItemId) as { id: string; project_id: string; stable_key: string } | undefined
    if (item === undefined) {
      throw new WorkAssignmentError('unknown-work-item', `work item "${input.workItemId}" is not recorded in this ledger`)
    }
    const actor = db.prepare('SELECT id, project_id, actor_key FROM actors WHERE id = ?')
      .get(input.actorId) as { id: string; project_id: string; actor_key: string } | undefined
    if (actor === undefined || actor.project_id !== item.project_id) {
      throw new WorkAssignmentError(
        'unknown-actor',
        `actor "${input.actorId}" is not registered in project "${item.project_id}"`,
      )
    }
    let roleName: string | undefined
    if (input.roleId !== undefined) {
      const role = db.prepare('SELECT id, project_id, role_name FROM roles WHERE id = ?')
        .get(input.roleId) as { id: string; project_id: string; role_name: string } | undefined
      if (role === undefined || role.project_id !== item.project_id) {
        throw new WorkAssignmentError(
          'unknown-role',
          `role "${input.roleId}" is not defined for project "${item.project_id}"`,
        )
      }
      roleName = role.role_name
    }
    const livePrimary = db.prepare(
      "SELECT id FROM work_assignments WHERE work_item_id = ? AND status = 'ACTIVE' AND assignment_kind = 'PRIMARY'",
    ).get(input.workItemId) as { id: string } | undefined
    if (input.assignmentKind === 'PRIMARY' && livePrimary !== undefined) {
      throw new WorkAssignmentError(
        'duplicate-assignment',
        `work item "${input.workItemId}" already holds a live PRIMARY assignment (${livePrimary.id})`,
      )
    }
    const projectId = brandString<ProjectId>(item.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the assignment id is its event's.
    const assignmentId = brandString<WorkAssignmentId>(`wa:${item.project_id}:${nextProjectEventSequence(db, projectId)}`)
    appendProjectEvent(
      db,
      projectId,
      'work/assigned',
      {
        assignmentId,
        workItemId: input.workItemId,
        actorId: input.actorId,
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        assignmentKind: input.assignmentKind,
      },
      { entityType: 'work_assignment', entityId: assignmentId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO work_assignments '
      + '(id, work_item_id, actor_id, role_id, assignment_kind, status, assigned_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(assignmentId, input.workItemId, input.actorId, input.roleId ?? null, input.assignmentKind, 'ACTIVE', nowMs)
    db.exec('COMMIT')
    return {
      assignmentId,
      workItemId: input.workItemId,
      stableKey: item.stable_key,
      actorId: input.actorId,
      actorKey: actor.actor_key,
      roleId: input.roleId,
      roleName,
      assignmentKind: input.assignmentKind,
      status: 'ACTIVE',
      assignedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One `work_assignments` row the read joins, in select order. */
interface WorkAssignmentRow {
  readonly id: string
  readonly work_item_id: string
  readonly stable_key: string
  readonly actor_id: string
  readonly actor_key: string
  readonly role_id: string | null
  readonly role_name: string | null
  readonly assignment_kind: WorkAssignmentKind
  readonly status: WorkAssignmentStatus
  readonly assigned_at_ms: number
}

/**
 * List one project's work assignments newest-first, with the item, actor,
 * and role labels resolved through joins.
 * @param db - open ledger database.
 * @param projectId - project whose assignments are read.
 * @returns the assignments; a project the ledger records no assignment for
 * reads as empty.
 */
export function readProjectWorkAssignments(db: DatabaseSync, projectId: ProjectId): readonly WorkAssignment[] {
  const rows = db.prepare(
    'SELECT a.id, a.work_item_id, w.stable_key, a.actor_id, c.actor_key, a.role_id, r.role_name, '
    + 'a.assignment_kind, a.status, a.assigned_at_ms '
    + 'FROM work_assignments a '
    + 'JOIN work_items w ON w.id = a.work_item_id '
    + 'JOIN actors c ON c.id = a.actor_id '
    + 'LEFT JOIN roles r ON r.id = a.role_id '
    + 'WHERE w.project_id = ? ORDER BY a.assigned_at_ms DESC, a.id',
  ).all(projectId) as unknown as WorkAssignmentRow[]
  return rows.map(row => ({
    assignmentId: brandString<WorkAssignmentId>(row.id),
    workItemId: brandString<WorkItemId>(row.work_item_id),
    stableKey: row.stable_key,
    actorId: brandString<ActorId>(row.actor_id),
    actorKey: row.actor_key,
    roleId: row.role_id === null ? undefined : brandString<RoleId>(row.role_id),
    roleName: row.role_name ?? undefined,
    assignmentKind: row.assignment_kind,
    status: row.status,
    assignedAtMs: row.assigned_at_ms,
  }))
}
