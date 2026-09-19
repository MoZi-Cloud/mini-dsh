/**
 * The v1.6b actor/role domain (blueprint §3/§4, adapted like the decision,
 * approval, and resource domains): a project registers the actors its other
 * domains record as strings, defines the roles those strings reference, and
 * assigns actors to roles — {@link registerActor} gives every `requested_by`,
 * `decided_by`, `raised_by`, and claim identity a durable referent,
 * {@link defineRole} gives every approval `required_role` reference one, and
 * {@link assignRole} records who holds what. {@link readProjectActors} lists
 * the project's actors, roles, and live assignments. Every write runs in one
 * `BEGIN IMMEDIATE` transaction; actor and role ids derive from identity
 * (`actor:<projectId>:<actorKey>`, `role:<projectId>:<roleName>`), assignment
 * ids from the event's timeline sequence. Ending an assignment and
 * deactivating an actor are reserved (the schema keeps `valid_to_ms` and
 * `INACTIVE` legal) with no writer yet.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/actors
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import {
  ACTOR_KINDS,
  ROLE_KINDS,
  type ActorKind,
  type RoleKind,
} from './project-events.js'
import type { ProjectId } from './plan-compile.js'
import { requireJsonObject } from './json-text.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one actor row (`actors.id`). */
export type ActorId = Branded<'ActorId'>

/** Identity of one role row (`roles.id`). */
export type RoleId = Branded<'RoleId'>

/** Identity of one actor-role assignment row (`actor_roles.id`). */
export type ActorRoleId = Branded<'ActorRoleId'>

/** The controlled status of one actor row; only `ACTIVE` has a writer. */
export type ActorStatus = 'ACTIVE' | 'INACTIVE'

/** Actor recorded on actor/role events when the caller does not name one. */
export const DEFAULT_ACTOR_ACTOR_REF = 'dsh-experimental-project-ledger/actors'

/** Closed set of actor/role-domain rejection reasons. */
export type ActorErrorCode =
  | 'invalid-argument'
  | 'duplicate-actor-key'
  | 'duplicate-role-name'
  | 'unknown-actor'
  | 'unknown-role'
  | 'duplicate-assignment'

/**
 * Thrown when an actor/role-domain write is rejected on ledger state or
 * input. The failing transaction has already rolled back, so the rejection
 * itself never writes.
 */
export class ActorError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ActorErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: ActorErrorCode, message: string) {
    super(message)
    this.name = 'ActorError'
    this.code = code
  }
}

/** The actor {@link registerActor} records. */
export interface RegisterActorInput {
  /** The project-local actor string the other domains already record. */
  readonly actorKey: string
  readonly actorKind: ActorKind
  readonly displayName: string
  /** The actor's identity in an external system, when one is named. */
  readonly externalIdentity?: string | undefined
  /** JSON text of actor metadata; must parse as a JSON object when present. */
  readonly metadataJson?: string | undefined
}

/** The role {@link defineRole} records. */
export interface DefineRoleInput {
  /** The project-local role name approval `required_role` references record. */
  readonly roleName: string
  readonly roleKind: RoleKind
  readonly description?: string | undefined
}

/** The assignment {@link assignRole} records. */
export interface AssignRoleInput {
  readonly actorId: ActorId
  readonly roleId: RoleId
}

/** Options every actor/role write shares. */
export interface ActorWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_ACTOR_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One registered actor as {@link readProjectActors} lists it. */
export interface Actor {
  readonly actorId: ActorId
  readonly projectId: ProjectId
  readonly actorKey: string
  readonly actorKind: ActorKind
  readonly displayName: string
  readonly externalIdentity: string | undefined
  readonly metadataJson: string | undefined
  readonly status: ActorStatus
  readonly createdAtMs: number
}

/** One defined role as {@link readProjectActors} lists it. */
export interface Role {
  readonly roleId: RoleId
  readonly projectId: ProjectId
  readonly roleName: string
  readonly roleKind: RoleKind
  readonly description: string | undefined
  readonly createdAtMs: number
}

/** One live actor-role assignment as {@link readProjectActors} lists it. */
export interface ActorRole {
  readonly assignmentId: ActorRoleId
  readonly actorId: ActorId
  readonly roleId: RoleId
  /** The assigned actor's project key, resolved through the actors row. */
  readonly actorKey: string
  /** The assigned role's project name, resolved through the roles row. */
  readonly roleName: string
  readonly validFromMs: number
  /** Always `undefined` until an end-of-assignment writer lands; `valid_to_ms` is reserved. */
  readonly validToMs: number | undefined
}

/** The directory {@link readProjectActors} reads for one project. */
export interface ActorDirectory {
  readonly projectId: ProjectId
  readonly actors: readonly Actor[]
  readonly roles: readonly Role[]
  readonly assignments: readonly ActorRole[]
}

/** Reject an input string that must carry content. */
function requireNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new ActorError('invalid-argument', `${field} must not be empty`)
  }
}

/**
 * Register one project actor: validate the inputs, then record the actor and
 * one `actor/registered` event in a single `BEGIN IMMEDIATE` transaction.
 * @param db - open ledger database.
 * @param projectId - project the actor belongs to.
 * @param input - the actor's key, kind, display name, and optional externals.
 * @param options - actor and clock overrides.
 * @returns the recorded actor.
 * @throws {ActorError} on `invalid-argument` and `duplicate-actor-key`.
 */
export function registerActor(
  db: DatabaseSync,
  projectId: ProjectId,
  input: RegisterActorInput,
  options: ActorWriteOptions = {},
): Actor {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_ACTOR_ACTOR_REF
  requireNonEmpty('actorKey', input.actorKey)
  requireNonEmpty('displayName', input.displayName)
  requireJsonObject('metadataJson', input.metadataJson, message => new ActorError('invalid-argument', message))
  if (!ACTOR_KINDS.includes(input.actorKind)) {
    throw new ActorError(
      'invalid-argument',
      `actorKind must be one of ${ACTOR_KINDS.join(', ')}, got ${JSON.stringify(input.actorKind)}`,
    )
  }
  const actorId = brandString<ActorId>(`actor:${projectId}:${input.actorKey}`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const duplicate = db.prepare(
      'SELECT id FROM actors WHERE project_id = ? AND actor_key = ?',
    ).get(projectId, input.actorKey) as { id: string } | undefined
    if (duplicate !== undefined) {
      throw new ActorError(
        'duplicate-actor-key',
        `actor key "${input.actorKey}" is already registered in project "${projectId}" (${duplicate.id})`,
      )
    }
    appendProjectEvent(
      db,
      projectId,
      'actor/registered',
      {
        actorId,
        actorKey: input.actorKey,
        actorKind: input.actorKind,
        displayName: input.displayName,
        ...(input.externalIdentity === undefined ? {} : { externalIdentity: input.externalIdentity }),
        ...(input.metadataJson === undefined ? {} : { metadataJson: input.metadataJson }),
      },
      { entityType: 'actor', entityId: actorId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO actors '
      + '(id, project_id, actor_key, actor_kind, display_name, external_identity, metadata_json, status, created_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      actorId,
      projectId,
      input.actorKey,
      input.actorKind,
      input.displayName,
      input.externalIdentity ?? null,
      input.metadataJson ?? null,
      'ACTIVE',
      nowMs,
    )
    db.exec('COMMIT')
    return {
      actorId,
      projectId,
      actorKey: input.actorKey,
      actorKind: input.actorKind,
      displayName: input.displayName,
      externalIdentity: input.externalIdentity,
      metadataJson: input.metadataJson,
      status: 'ACTIVE',
      createdAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Define one project role: validate the inputs, then record the role and one
 * `role/defined` event in a single `BEGIN IMMEDIATE` transaction.
 * @param db - open ledger database.
 * @param projectId - project the role belongs to.
 * @param input - the role's name, kind, and optional description.
 * @param options - actor and clock overrides.
 * @returns the recorded role.
 * @throws {ActorError} on `invalid-argument` and `duplicate-role-name`.
 */
export function defineRole(
  db: DatabaseSync,
  projectId: ProjectId,
  input: DefineRoleInput,
  options: ActorWriteOptions = {},
): Role {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_ACTOR_ACTOR_REF
  requireNonEmpty('roleName', input.roleName)
  if (!ROLE_KINDS.includes(input.roleKind)) {
    throw new ActorError(
      'invalid-argument',
      `roleKind must be one of ${ROLE_KINDS.join(', ')}, got ${JSON.stringify(input.roleKind)}`,
    )
  }
  const roleId = brandString<RoleId>(`role:${projectId}:${input.roleName}`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const duplicate = db.prepare(
      'SELECT id FROM roles WHERE project_id = ? AND role_name = ?',
    ).get(projectId, input.roleName) as { id: string } | undefined
    if (duplicate !== undefined) {
      throw new ActorError(
        'duplicate-role-name',
        `role name "${input.roleName}" is already defined in project "${projectId}" (${duplicate.id})`,
      )
    }
    appendProjectEvent(
      db,
      projectId,
      'role/defined',
      {
        roleId,
        roleName: input.roleName,
        roleKind: input.roleKind,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      { entityType: 'role', entityId: roleId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO roles (id, project_id, role_name, role_kind, description, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(roleId, projectId, input.roleName, input.roleKind, input.description ?? null, nowMs)
    db.exec('COMMIT')
    return {
      roleId,
      projectId,
      roleName: input.roleName,
      roleKind: input.roleKind,
      description: input.description,
      createdAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Assign one actor to one role: validate the inputs, then record the
 * assignment and one `role/assigned` event in a single `BEGIN IMMEDIATE`
 * transaction. The role must belong to the actor's project; an actor holds a
 * role at most once at a time (the schema's partial unique index and this
 * seam both refuse a second live assignment of one pair).
 * @param db - open ledger database.
 * @param input - the actor and the role to assign.
 * @param options - actor and clock overrides.
 * @returns the recorded live assignment.
 * @throws {ActorError} on `unknown-actor`, `unknown-role`, and `duplicate-assignment`.
 */
export function assignRole(
  db: DatabaseSync,
  input: AssignRoleInput,
  options: ActorWriteOptions = {},
): ActorRole {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_ACTOR_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const actor = db.prepare(
      'SELECT id, project_id, actor_key FROM actors WHERE id = ?',
    ).get(input.actorId) as { id: string; project_id: string; actor_key: string } | undefined
    if (actor === undefined) {
      throw new ActorError('unknown-actor', `actor "${input.actorId}" is not registered in this ledger`)
    }
    const role = db.prepare(
      'SELECT id, project_id, role_name FROM roles WHERE id = ?',
    ).get(input.roleId) as { id: string; project_id: string; role_name: string } | undefined
    if (role === undefined || role.project_id !== actor.project_id) {
      throw new ActorError(
        'unknown-role',
        `role "${input.roleId}" is not defined for project "${actor.project_id}"`,
      )
    }
    const projectId = brandString<ProjectId>(actor.project_id)
    const live = db.prepare(
      'SELECT id FROM actor_roles WHERE actor_id = ? AND role_id = ? AND valid_to_ms IS NULL',
    ).get(input.actorId, input.roleId) as { id: string } | undefined
    if (live !== undefined) {
      throw new ActorError(
        'duplicate-assignment',
        `actor "${input.actorId}" already holds role "${input.roleId}" (${live.id})`,
      )
    }
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the assignment id is its event's.
    const assignmentId = brandString<ActorRoleId>(`asg:${projectId}:${nextProjectEventSequence(db, projectId)}`)
    appendProjectEvent(
      db,
      projectId,
      'role/assigned',
      { assignmentId, actorId: input.actorId, roleId: input.roleId },
      { entityType: 'actor_role', entityId: assignmentId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO actor_roles (id, actor_id, role_id, valid_from_ms, valid_to_ms) VALUES (?, ?, ?, ?, ?)',
    ).run(assignmentId, input.actorId, input.roleId, nowMs, null)
    db.exec('COMMIT')
    return {
      assignmentId,
      actorId: input.actorId,
      roleId: input.roleId,
      actorKey: actor.actor_key,
      roleName: role.role_name,
      validFromMs: nowMs,
      validToMs: undefined,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One `actors` row the read joins, in select order. */
interface ActorRow {
  readonly id: string
  readonly actor_key: string
  readonly actor_kind: ActorKind
  readonly display_name: string
  readonly external_identity: string | null
  readonly metadata_json: string | null
  readonly status: ActorStatus
  readonly created_at_ms: number
}

/** One `roles` row the read joins, in select order. */
interface RoleRow {
  readonly id: string
  readonly role_name: string
  readonly role_kind: RoleKind
  readonly description: string | null
  readonly created_at_ms: number
}

/** One `actor_roles` row the read joins, in select order. */
interface AssignmentRow {
  readonly id: string
  readonly actor_id: string
  readonly role_id: string
  readonly actor_key: string
  readonly role_name: string
  readonly valid_from_ms: number
  readonly valid_to_ms: number | null
}

/**
 * List one project's actors, roles, and live assignments: actors newest-first,
 * roles newest-first, assignments in assignment order.
 * @param db - open ledger database.
 * @param projectId - project whose directory is read.
 * @returns the directory; a project the ledger records no actor for reads as
 * empty.
 */
export function readProjectActors(db: DatabaseSync, projectId: ProjectId): ActorDirectory {
  const actorRows = db.prepare(
    'SELECT id, actor_key, actor_kind, display_name, external_identity, metadata_json, status, created_at_ms '
    + 'FROM actors WHERE project_id = ? ORDER BY created_at_ms DESC, id',
  ).all(projectId) as unknown as ActorRow[]
  const roleRows = db.prepare(
    'SELECT id, role_name, role_kind, description, created_at_ms FROM roles WHERE project_id = ? '
    + 'ORDER BY created_at_ms DESC, id',
  ).all(projectId) as unknown as RoleRow[]
  const assignmentRows = db.prepare(
    'SELECT a.id, a.actor_id, a.role_id, c.actor_key, r.role_name, a.valid_from_ms, a.valid_to_ms '
    + 'FROM actor_roles a '
    + 'JOIN actors c ON c.id = a.actor_id '
    + 'JOIN roles r ON r.id = a.role_id '
    + 'WHERE c.project_id = ? ORDER BY a.valid_from_ms, a.id',
  ).all(projectId) as unknown as AssignmentRow[]
  return {
    projectId,
    actors: actorRows.map(row => ({
      actorId: brandString<ActorId>(row.id),
      projectId,
      actorKey: row.actor_key,
      actorKind: row.actor_kind,
      displayName: row.display_name,
      externalIdentity: row.external_identity ?? undefined,
      metadataJson: row.metadata_json ?? undefined,
      status: row.status,
      createdAtMs: row.created_at_ms,
    })),
    roles: roleRows.map(row => ({
      roleId: brandString<RoleId>(row.id),
      projectId,
      roleName: row.role_name,
      roleKind: row.role_kind,
      description: row.description ?? undefined,
      createdAtMs: row.created_at_ms,
    })),
    assignments: assignmentRows.map(row => ({
      assignmentId: brandString<ActorRoleId>(row.id),
      actorId: brandString<ActorId>(row.actor_id),
      roleId: brandString<RoleId>(row.role_id),
      actorKey: row.actor_key,
      roleName: row.role_name,
      validFromMs: row.valid_from_ms,
      validToMs: row.valid_to_ms ?? undefined,
    })),
  }
}
