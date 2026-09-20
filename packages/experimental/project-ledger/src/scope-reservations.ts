/**
 * The v1.6d stage-B scope-reservation domain (blueprint §21, adapted like
 * the assignment and handoff domains): one actor's exclusive claim on one
 * project scope — a repository path — while working a work item, so a
 * second agent sees the scope is taken. {@link reserveScope} gives the
 * claim its row and event, {@link releaseScopeReservation} gives it back,
 * and {@link reapExpiredScopeReservations} moves the rows whose expiry has
 * passed — the lifecycle mirrors the work leases, with one active
 * reservation per project scope enforced by the partial unique index, the
 * seam, and the replay fold alike. Every write runs in one `BEGIN
 * IMMEDIATE` transaction; reservation ids derive from the event's timeline
 * sequence (`sr:<projectId>:<sequence>`). The blueprint's `mode` column is
 * dropped: every reservation ships exclusive.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/scope-reservations
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ActorId } from './actors.js'
import { SCOPE_RESERVATION_KINDS, type ScopeReservationKind } from './project-events.js'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one scope-reservation row (`scope_reservations.id`). */
export type ScopeReservationId = Branded<'ScopeReservationId'>

/** The controlled status of one reservation; all three statuses have writers. */
export type ScopeReservationStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED'

/** Actor recorded on reservation events when the caller does not name one. */
export const DEFAULT_SCOPE_RESERVATION_ACTOR_REF = 'dsh-experimental-project-ledger/scope-reservations'

/** Closed set of scope-reservation rejection reasons. */
export type ScopeReservationErrorCode =
  | 'invalid-argument'
  | 'unknown-work-item'
  | 'unknown-actor'
  | 'duplicate-reservation'
  | 'unknown-reservation'
  | 'reservation-not-active'

/**
 * Thrown when a scope-reservation write is rejected on ledger state or
 * input. The failing transaction has already rolled back, so the rejection
 * itself never writes.
 */
export class ScopeReservationError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ScopeReservationErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: ScopeReservationErrorCode, message: string) {
    super(message)
    this.name = 'ScopeReservationError'
    this.code = code
  }
}

/** The reservation {@link reserveScope} records. */
export interface ReserveScopeInput {
  /** The work item the reserving actor is working; its project scopes the reservation. */
  readonly workItemId: WorkItemId
  readonly actorId: ActorId
  /** The reserved scope's kind; the closed set lives with the event codec. */
  readonly scopeKind: ScopeReservationKind
  /** The reserved scope's project-local value, judged for overlap at the equal value. */
  readonly scopeValue: string
  /** Wall-clock instant the reservation lapses; must be in the future. */
  readonly expiresAtMs: number
}

/** Options every reservation write shares. */
export interface ScopeReservationWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_SCOPE_RESERVATION_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One scope reservation as {@link readProjectScopeReservations} lists it. */
export interface ScopeReservation {
  readonly reservationId: ScopeReservationId
  readonly projectId: ProjectId
  readonly workItemId: WorkItemId
  /** The reserved item's stable key, resolved through the work item row. */
  readonly stableKey: string
  readonly actorId: ActorId
  /** The reserving actor's project key, resolved through the actors row. */
  readonly actorKey: string
  readonly scopeKind: ScopeReservationKind
  readonly scopeValue: string
  readonly status: ScopeReservationStatus
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
  /** Set exactly on `RELEASED` rows; `EXPIRED` rows never held a release. */
  readonly releasedAtMs: number | undefined
}

/** The result of {@link releaseScopeReservation}. */
export interface ReleasedScopeReservation {
  readonly reservationId: ScopeReservationId
  readonly releasedAtMs: number
}

/** One reservation {@link reapExpiredScopeReservations} moved to `EXPIRED`. */
export interface ReapedScopeReservation {
  readonly reservationId: ScopeReservationId
  readonly projectId: ProjectId
  readonly sequenceNo: number
}

/** Reject an input string that must carry content. */
function requireNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new ScopeReservationError('invalid-argument', `${field} must not be empty`)
  }
}

/**
 * Expire one stale active reservation inside the caller's transaction: the
 * `scope/expired` event and the row move. Mirrors the lease claim's
 * stale-row reap — the row would otherwise block the partial unique index.
 */
function expireReservation(
  db: DatabaseSync,
  stale: { readonly id: string; readonly project_id: string },
  actorRef: string,
  nowMs: number,
): number {
  const reservationId = brandString<ScopeReservationId>(stale.id)
  const envelope = appendProjectEvent(
    db,
    brandString<ProjectId>(stale.project_id),
    'scope/expired',
    { reservationId },
    { entityType: 'scope_reservation', entityId: reservationId, actorRef, nowMs },
  )
  db.prepare("UPDATE scope_reservations SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'").run(stale.id)
  return envelope.sequenceNo
}

/**
 * Reserve one project scope for one actor: validate the inputs, expire a
 * stale reservation still holding the scope, refuse a live second, then
 * record the reservation and one `scope/reserved` event in a single `BEGIN
 * IMMEDIATE` transaction. The scope's uniqueness is project-scoped at the
 * equal kind and value — one active reservation per (project, kind, value),
 * as the partial unique index states.
 * @param db - open ledger database.
 * @param input - the item, actor, scope, and expiry of the reservation.
 * @param options - actor and clock overrides.
 * @returns the recorded active reservation.
 * @throws {ScopeReservationError} on `invalid-argument`, `unknown-work-item`,
 * `unknown-actor`, and `duplicate-reservation`.
 */
export function reserveScope(
  db: DatabaseSync,
  input: ReserveScopeInput,
  options: ScopeReservationWriteOptions = {},
): ScopeReservation {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_SCOPE_RESERVATION_ACTOR_REF
  if (!SCOPE_RESERVATION_KINDS.includes(input.scopeKind)) {
    throw new ScopeReservationError(
      'invalid-argument',
      `scopeKind must be one of ${SCOPE_RESERVATION_KINDS.join(', ')}, got ${JSON.stringify(input.scopeKind)}`,
    )
  }
  requireNonEmpty('scopeValue', input.scopeValue)
  if (!Number.isInteger(input.expiresAtMs) || input.expiresAtMs <= nowMs) {
    throw new ScopeReservationError(
      'invalid-argument',
      `expiresAtMs must be an integer after now (${nowMs}), got ${String(input.expiresAtMs)}`,
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const item = db.prepare('SELECT id, project_id, stable_key FROM work_items WHERE id = ?')
      .get(input.workItemId) as { id: string; project_id: string; stable_key: string } | undefined
    if (item === undefined) {
      throw new ScopeReservationError(
        'unknown-work-item',
        `work item "${input.workItemId}" is not recorded in this ledger`,
      )
    }
    const actor = db.prepare('SELECT id, project_id, actor_key FROM actors WHERE id = ?')
      .get(input.actorId) as { id: string; project_id: string; actor_key: string } | undefined
    if (actor === undefined || actor.project_id !== item.project_id) {
      throw new ScopeReservationError(
        'unknown-actor',
        `actor "${input.actorId}" is not registered in project "${item.project_id}"`,
      )
    }
    const stale = db.prepare(
      'SELECT id, project_id FROM scope_reservations '
      + "WHERE project_id = ? AND scope_kind = ? AND scope_value = ? AND status = 'ACTIVE' AND expires_at_ms <= ?",
    ).get(item.project_id, input.scopeKind, input.scopeValue, nowMs) as
      | { id: string; project_id: string }
      | undefined
    if (stale !== undefined) {
      expireReservation(db, stale, actorRef, nowMs)
    }
    const live = db.prepare(
      'SELECT id, project_id FROM scope_reservations '
      + "WHERE project_id = ? AND scope_kind = ? AND scope_value = ? AND status = 'ACTIVE'",
    ).get(item.project_id, input.scopeKind, input.scopeValue) as { id: string } | undefined
    if (live !== undefined) {
      throw new ScopeReservationError(
        'duplicate-reservation',
        `scope ${input.scopeKind} "${input.scopeValue}" is already reserved in project "${item.project_id}" `
          + `(${live.id})`,
      )
    }
    const projectId = brandString<ProjectId>(item.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the reservation id is its event's.
    const reservationId = brandString<ScopeReservationId>(
      `sr:${item.project_id}:${nextProjectEventSequence(db, projectId)}`,
    )
    appendProjectEvent(
      db,
      projectId,
      'scope/reserved',
      {
        reservationId,
        workItemId: input.workItemId,
        actorId: input.actorId,
        scopeKind: input.scopeKind,
        scopeValue: input.scopeValue,
        expiresAtMs: input.expiresAtMs,
      },
      { entityType: 'scope_reservation', entityId: reservationId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO scope_reservations '
      + '(id, project_id, work_item_id, actor_id, scope_kind, scope_value, acquired_at_ms, expires_at_ms, '
      + 'released_at_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      reservationId,
      item.project_id,
      input.workItemId,
      input.actorId,
      input.scopeKind,
      input.scopeValue,
      nowMs,
      input.expiresAtMs,
      null,
      'ACTIVE',
    )
    db.exec('COMMIT')
    return {
      reservationId,
      projectId,
      workItemId: input.workItemId,
      stableKey: item.stable_key,
      actorId: input.actorId,
      actorKey: actor.actor_key,
      scopeKind: input.scopeKind,
      scopeValue: input.scopeValue,
      status: 'ACTIVE',
      acquiredAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
      releasedAtMs: undefined,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Release one active reservation, giving the scope back: record the
 * `scope/released` event and move the row in a single `BEGIN IMMEDIATE`
 * transaction. A released or expired reservation never releases again.
 * @param db - open ledger database.
 * @param reservationId - the reservation to release.
 * @param options - actor and clock overrides.
 * @returns the release facts.
 * @throws {ScopeReservationError} on `unknown-reservation` and
 * `reservation-not-active`.
 */
export function releaseScopeReservation(
  db: DatabaseSync,
  reservationId: ScopeReservationId,
  options: ScopeReservationWriteOptions = {},
): ReleasedScopeReservation {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_SCOPE_RESERVATION_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT id, project_id, status FROM scope_reservations WHERE id = ?')
      .get(reservationId) as { id: string; project_id: string; status: ScopeReservationStatus } | undefined
    if (row === undefined) {
      throw new ScopeReservationError(
        'unknown-reservation',
        `scope reservation "${reservationId}" is not recorded in this ledger`,
      )
    }
    if (row.status !== 'ACTIVE') {
      throw new ScopeReservationError(
        'reservation-not-active',
        `scope reservation "${reservationId}" is ${row.status} and cannot release`,
      )
    }
    appendProjectEvent(
      db,
      brandString<ProjectId>(row.project_id),
      'scope/released',
      { reservationId },
      { entityType: 'scope_reservation', entityId: reservationId, actorRef, nowMs },
    )
    db.prepare(
      "UPDATE scope_reservations SET status = 'RELEASED', released_at_ms = ? WHERE id = ? AND status = 'ACTIVE'",
    ).run(nowMs, reservationId)
    db.exec('COMMIT')
    return { reservationId, releasedAtMs: nowMs }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Options for {@link reapExpiredScopeReservations}. */
export interface ReapScopeReservationsOptions {
  /** Actor recorded on the expiry events; defaults to the domain default. */
  readonly actorRef?: string | undefined
  /** Now, for the expiry comparison; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
  /** Maximum rows one batch moves; defaults to 64. */
  readonly limit?: number | undefined
}

/**
 * Reap every reservation whose expiry has passed, in one bounded batch
 * inside a single transaction: each gets a `scope/expired` event and its
 * row moves to `EXPIRED`. The scope then accepts a new reservation.
 * @param db - open ledger database.
 * @param options - batch limit, actor, and clock overrides.
 * @returns one summary per reaped reservation; empty when nothing has expired.
 * @throws {ScopeReservationError} on `invalid-argument`.
 */
export function reapExpiredScopeReservations(
  db: DatabaseSync,
  options: ReapScopeReservationsOptions = {},
): ReapedScopeReservation[] {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_SCOPE_RESERVATION_ACTOR_REF
  const limit = options.limit ?? 64
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ScopeReservationError('invalid-argument', `reap limit must be a positive integer, got ${limit}`)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const stale = db.prepare(
      "SELECT id, project_id FROM scope_reservations WHERE status = 'ACTIVE' AND expires_at_ms <= ? "
      + 'ORDER BY id LIMIT ?',
    ).all(nowMs, limit) as { id: string; project_id: string }[]
    const reaped: ReapedScopeReservation[] = []
    for (const row of stale) {
      const sequenceNo = expireReservation(db, row, actorRef, nowMs)
      reaped.push({
        reservationId: brandString<ScopeReservationId>(row.id),
        projectId: brandString<ProjectId>(row.project_id),
        sequenceNo,
      })
    }
    db.exec('COMMIT')
    return reaped
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One `scope_reservations` row the read joins, in select order. */
interface ScopeReservationRow {
  readonly id: string
  readonly project_id: string
  readonly work_item_id: string
  readonly stable_key: string
  readonly actor_id: string
  readonly actor_key: string
  readonly scope_kind: ScopeReservationKind
  readonly scope_value: string
  readonly status: ScopeReservationStatus
  readonly acquired_at_ms: number
  readonly expires_at_ms: number
  readonly released_at_ms: number | null
}

/**
 * List one project's scope reservations newest-first, with the item and
 * actor labels resolved through joins.
 * @param db - open ledger database.
 * @param projectId - project whose reservations are read.
 * @returns the reservations; a project the ledger records no reservation
 * for reads as empty.
 */
export function readProjectScopeReservations(db: DatabaseSync, projectId: ProjectId): readonly ScopeReservation[] {
  const rows = db.prepare(
    'SELECT r.id, r.project_id, r.work_item_id, w.stable_key, r.actor_id, c.actor_key, r.scope_kind, '
    + 'r.scope_value, r.status, r.acquired_at_ms, r.expires_at_ms, r.released_at_ms '
    + 'FROM scope_reservations r '
    + 'JOIN work_items w ON w.id = r.work_item_id '
    + 'JOIN actors c ON c.id = r.actor_id '
    + 'WHERE r.project_id = ? ORDER BY r.acquired_at_ms DESC, r.id',
  ).all(projectId) as unknown as ScopeReservationRow[]
  return rows.map(row => ({
    reservationId: brandString<ScopeReservationId>(row.id),
    projectId: brandString<ProjectId>(row.project_id),
    workItemId: brandString<WorkItemId>(row.work_item_id),
    stableKey: row.stable_key,
    actorId: brandString<ActorId>(row.actor_id),
    actorKey: row.actor_key,
    scopeKind: row.scope_kind,
    scopeValue: row.scope_value,
    status: row.status,
    acquiredAtMs: row.acquired_at_ms,
    expiresAtMs: row.expires_at_ms,
    releasedAtMs: row.released_at_ms ?? undefined,
  }))
}
