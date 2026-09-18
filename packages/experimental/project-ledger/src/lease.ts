/**
 * Work lease lifecycle and the readiness projection writers (v1.6a F09-F11,
 * §12-§13, attachment §14/§16). {@link claimWorkItem} follows the §13 concept
 * order inside one `BEGIN IMMEDIATE` transaction — recompute readiness, reap
 * a stale lease for this item, create exactly one active lease — with the
 * `uq_one_active_lease_per_work` partial unique index as the final arbiter.
 * Heartbeats and releases must arrive before expiry; everything past expiry
 * belongs to {@link reapExpiredLeases}, which records `work/lease-expired`
 * and recomputes the item's projected status without ever declaring it
 * FAILED. {@link blockWorkItem}/{@link unblockWorkItem} materialize a
 * recomputed readiness onto the `READY`/`BLOCKED` pair through
 * `work/blocked`/`work/unblocked`.
 *
 * The lease token is a bearer credential: only its SHA-256 hash is stored,
 * and the token never enters a project event, so the log reconstructs lease
 * state without carrying secrets. `REVOKED` is a reserved row status with no
 * writer in this build.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/lease
 */

import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import type { PlanWorkItemStatus } from './plan-document.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'
import { computeWorkReadiness, type WorkReadiness, type WorkReadinessReason } from './work-readiness.js'

/** Identity of one work lease row (`work_leases.id`). */
export type WorkLeaseId = Branded<'WorkLeaseId'>

/** Actor recorded on lease events when the caller does not name one. */
export const DEFAULT_LEASE_ACTOR_REF = 'dsh-experimental-project-ledger/lease'

/** Actor recorded on readiness projection events when the caller does not name one. */
export const DEFAULT_READINESS_ACTOR_REF = 'dsh-experimental-project-ledger/readiness-projection'

/**
 * Lease policy of one deployment (§13). `ttlMs` is the claim and heartbeat
 * horizon, `heartbeatIntervalMs` the holder's cadence, `reaperIntervalMs` the
 * cadence of the caller's reaper loop — {@link reapExpiredLeases} is a
 * bounded batch, so the interval itself belongs to the caller.
 */
export interface LeaseConfig {
  readonly ttlMs: number
  readonly heartbeatIntervalMs: number
  readonly reaperIntervalMs: number
}

/**
 * The lease policy used when the caller does not supply one: heartbeats every
 * 60s sit well inside the 300s ttl at under half (§13).
 */
export const DEFAULT_LEASE_CONFIG: LeaseConfig = { ttlMs: 300_000, heartbeatIntervalMs: 60_000, reaperIntervalMs: 30_000 }

/**
 * Resolve a partial lease policy into a full one, failing loud on a policy
 * that violates §13 (`heartbeatIntervalMs < ttlMs / 2`). Overrides travel as
 * a pair: a `ttlMs` override without a compatible `heartbeatIntervalMs` is a
 * misconfiguration, not a silent mix with the default heartbeat.
 * @param config - the caller's partial policy.
 * @returns the resolved policy with every field set and validated.
 * @throws {LeaseError} on `invalid-lease-config`.
 */
export function resolveLeaseConfig(config: Partial<LeaseConfig> = {}): LeaseConfig {
  const resolved: LeaseConfig = {
    ttlMs: config.ttlMs ?? DEFAULT_LEASE_CONFIG.ttlMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_LEASE_CONFIG.heartbeatIntervalMs,
    reaperIntervalMs: config.reaperIntervalMs ?? DEFAULT_LEASE_CONFIG.reaperIntervalMs,
  }
  for (const field of ['ttlMs', 'heartbeatIntervalMs', 'reaperIntervalMs'] as const) {
    const value = resolved[field]
    if (!Number.isInteger(value) || value <= 0) {
      throw new LeaseError('invalid-lease-config', `lease config ${field} must be a positive integer, got ${value}`)
    }
  }
  if (resolved.heartbeatIntervalMs * 2 >= resolved.ttlMs) {
    throw new LeaseError(
      'invalid-lease-config',
      'lease config violates heartbeatIntervalMs < ttlMs / 2 '
        + `(got ttlMs ${resolved.ttlMs}, heartbeatIntervalMs ${resolved.heartbeatIntervalMs})`,
    )
  }
  return resolved
}

/** Closed set of lease and readiness-projection rejection reasons. */
export type LeaseErrorCode =
  | 'invalid-lease-config'
  | 'invalid-argument'
  | 'work-not-ready'
  | 'unknown-lease'
  | 'lease-token-mismatch'
  | 'lease-not-active'
  | 'nothing-to-block'
  | 'nothing-to-unblock'
  | 'status-not-projectable'

/**
 * Thrown when a lease or readiness-projection write is rejected on ledger
 * state or configuration. The failing transaction has already rolled back,
 * so the rejection itself never writes.
 */
export class LeaseError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: LeaseErrorCode
  /** The recomputed blockers behind a `work-not-ready` or projection rejection. */
  readonly reasons: readonly WorkReadinessReason[]

  /**
   * @param code - why the write was rejected.
   * @param message - the concrete reason.
   * @param reasons - the readiness blockers when the rejection recomputed them.
   */
  constructor(code: LeaseErrorCode, message: string, reasons: readonly WorkReadinessReason[] = []) {
    super(message)
    this.name = 'LeaseError'
    this.code = code
    this.reasons = reasons
  }
}

/** The controlled status of one lease row. `REVOKED` has no writer in this build. */
export type LeaseStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'REVOKED'

/** One work lease as the ledger records it. */
export interface WorkLease {
  readonly leaseId: WorkLeaseId
  readonly workItemId: WorkItemId
  readonly workerIdentity: string
  readonly status: LeaseStatus
  readonly acquiredAtMs: number
  readonly heartbeatAtMs: number
  readonly expiresAtMs: number
  readonly releasedAtMs: number | undefined
}

/** Outcome of one {@link claimWorkItem} call. */
export interface WorkLeaseClaim extends WorkLease {
  /**
   * The bearer token proving the claim. It is shown once to the claimer;
   * only its SHA-256 hash is stored.
   */
  readonly leaseToken: string
  /** The appended `work/claimed` event's position in the timeline. */
  readonly sequenceNo: number
}

/** Options for {@link claimWorkItem}. */
export interface ClaimWorkItemOptions {
  /** Partial lease policy; resolved and validated by {@link resolveLeaseConfig}. */
  readonly leaseConfig?: Partial<LeaseConfig> | undefined
  /** Actor recorded on the events; defaults to {@link DEFAULT_LEASE_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Options for {@link heartbeatWorkLease}. */
export interface HeartbeatWorkLeaseOptions {
  /** Partial lease policy; the resolved `ttlMs` is the new expiry horizon. */
  readonly leaseConfig?: Partial<LeaseConfig> | undefined
  /** Actor recorded on the event; defaults to {@link DEFAULT_LEASE_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the row and the event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Options for {@link releaseWorkLease}. */
export interface ReleaseWorkLeaseOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_LEASE_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and the event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Options for {@link reapExpiredLeases}. */
export interface ReapExpiredLeasesOptions {
  /** Maximum leases reaped per call, bounding the batch; defaults to 64. */
  readonly limit?: number | undefined
  /** Actor recorded on the events; defaults to {@link DEFAULT_LEASE_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One lease reaped by {@link reapExpiredLeases}. */
export interface ReapedLease {
  readonly leaseId: WorkLeaseId
  readonly workItemId: WorkItemId
  readonly workerIdentity: string
  /** The item's materialized status before the reaper's recompute. */
  readonly fromItemStatus: PlanWorkItemStatus
  /** The materialized status the recompute wrote (§13: `READY` or `BLOCKED`). */
  readonly toItemStatus: PlanWorkItemStatus
  /** The appended `work/lease-expired` event's position in the timeline. */
  readonly sequenceNo: number
}

/** Options for {@link blockWorkItem} and {@link unblockWorkItem}. */
export interface ReadinessProjectionOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_READINESS_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the row and the event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Outcome of one {@link blockWorkItem} or {@link unblockWorkItem} call. */
export interface WorkReadinessProjectionChange {
  readonly workItemId: WorkItemId
  readonly fromStatus: PlanWorkItemStatus
  readonly toStatus: PlanWorkItemStatus
  /** The recomputed readiness behind the move. */
  readonly readiness: WorkReadiness
  /** The appended event's position in the project's timeline. */
  readonly sequenceNo: number
  /** Wall-clock stamp written to the row and the event. */
  readonly createdAtMs: number
}

/** SHA-256 hex of one lease token — the only form the ledger keeps. */
function hashLeaseToken(leaseToken: string): string {
  return createHash('sha256').update(leaseToken).digest('hex')
}

/** One lease row joined with its work item's project and status. */
interface LeaseJoinRow {
  readonly id: string
  readonly work_item_id: string
  readonly worker_identity: string
  readonly lease_token_hash: string
  readonly status: LeaseStatus
  readonly acquired_at_ms: number
  readonly heartbeat_at_ms: number
  readonly expires_at_ms: number
  readonly project_id: string
  readonly item_status: PlanWorkItemStatus
}

/** Read one lease with its item's project id, failing with `unknown-lease` when absent. */
function selectLease(db: DatabaseSync, leaseId: WorkLeaseId): LeaseJoinRow {
  const lease = db.prepare(
    'SELECT l.id, l.work_item_id, l.worker_identity, l.lease_token_hash, l.status, l.acquired_at_ms, '
    + 'l.heartbeat_at_ms, l.expires_at_ms, w.project_id, w.status AS item_status '
    + 'FROM work_leases l JOIN work_items w ON w.id = l.work_item_id WHERE l.id = ?',
  ).get(leaseId) as LeaseJoinRow | undefined
  if (lease === undefined) {
    throw new LeaseError('unknown-lease', `work lease "${leaseId}" is not recorded in this ledger`)
  }
  return lease
}

/** Refuse any caller that cannot present the lease's own token. */
function requireTokenMatch(lease: LeaseJoinRow, leaseToken: string): void {
  if (lease.lease_token_hash !== hashLeaseToken(leaseToken)) {
    throw new LeaseError(
      'lease-token-mismatch',
      `work lease "${lease.id}" token does not match; only the lease holder may extend or release it`,
    )
  }
}

/** Refuse operations on a row that is no longer the item's active lease. */
function requireActive(lease: LeaseJoinRow, action: string): void {
  if (lease.status !== 'ACTIVE') {
    throw new LeaseError(
      'lease-not-active',
      `work lease "${lease.id}" has status ${lease.status}; only an ACTIVE lease can be ${action}`,
    )
  }
}

/** Refuse a heartbeat or release that arrives after expiry; the reaper owns recovery. */
function requireUnexpired(lease: LeaseJoinRow, nowMs: number): void {
  if (nowMs >= lease.expires_at_ms) {
    throw new LeaseError(
      'lease-not-active',
      `work lease "${lease.id}" expired at ${lease.expires_at_ms}; the reaper owns recovery `
        + 'and this call cannot resurrect it',
    )
  }
}

/**
 * The item status a giving-up lease leaves behind (§13: `READY`/`BLOCKED` by
 * recomputed projection). Only an in-flight item moves: its own status gate
 * and the lease being given up are excluded from the recompute, so every
 * other readiness input decides between `READY` and `BLOCKED`. An item whose
 * lifecycle moved on independently (`VERIFYING`, terminal statuses) keeps its
 * status and the event just records it.
 */
function projectedStatusAfterGiveUp(
  db: DatabaseSync,
  workItemId: WorkItemId,
  itemStatus: PlanWorkItemStatus,
  nowMs: number,
  ignoreLeaseId: string | undefined,
): PlanWorkItemStatus {
  if (itemStatus !== 'IN_PROGRESS') {
    return itemStatus
  }
  const recomputed = computeWorkReadiness(db, workItemId, {
    nowMs,
    treatStatusAsOpen: true,
    ignoreLeaseId,
  })
  return recomputed.ready ? 'READY' : 'BLOCKED'
}

interface ExpiredLeaseOutcome {
  readonly toItemStatus: PlanWorkItemStatus
  readonly sequenceNo: number
}

/**
 * Expire one stale ACTIVE lease inside the caller's transaction: the
 * `work/lease-expired` event, the row move, and the item's recomputed
 * projection. Never writes `FAILED` (§13).
 */
function expireLease(
  db: DatabaseSync,
  stale: { readonly id: string; readonly work_item_id: string; readonly worker_identity: string },
  actorRef: string,
  nowMs: number,
): ExpiredLeaseOutcome {
  const workItemId = brandString<WorkItemId>(stale.work_item_id)
  const item = db.prepare('SELECT project_id, status FROM work_items WHERE id = ?')
    .get(workItemId) as { project_id: string; status: PlanWorkItemStatus }
  const toStatus = projectedStatusAfterGiveUp(db, workItemId, item.status, nowMs, undefined)
  const envelope = appendProjectEvent(
    db,
    // The project id crossed the durable work_items row boundary.
    brandString<ProjectId>(item.project_id),
    'work/lease-expired',
    { workItemId, leaseId: brandString<WorkLeaseId>(stale.id), workerIdentity: stale.worker_identity, toStatus },
    { entityType: 'work_item', entityId: stale.work_item_id, actorRef, nowMs },
  )
  db.prepare("UPDATE work_leases SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'").run(stale.id)
  db.prepare('UPDATE work_items SET status = ?, updated_at_ms = ? WHERE id = ?').run(toStatus, nowMs, workItemId)
  return { toItemStatus: toStatus, sequenceNo: envelope.sequenceNo }
}

/**
 * Reap a stale ACTIVE lease for one item inside the caller's claim
 * transaction (§13 claim order). An in-flight item whose lease went stale is
 * closed to claims by readiness, so this path only clears rows blocking the
 * partial unique index; recovery of abandoned items is
 * {@link reapExpiredLeases}.
 */
function reapStaleLease(db: DatabaseSync, workItemId: WorkItemId, actorRef: string, nowMs: number): void {
  const stale = db.prepare(
    'SELECT id, worker_identity FROM work_leases '
    + "WHERE work_item_id = ? AND status = 'ACTIVE' AND expires_at_ms <= ?",
  ).get(workItemId, nowMs) as { id: string; worker_identity: string } | undefined
  if (stale === undefined) {
    return
  }
  expireLease(db, { id: stale.id, work_item_id: workItemId, worker_identity: stale.worker_identity }, actorRef, nowMs)
}

/**
 * Claim one work item for one worker (§13): inside a single
 * `BEGIN IMMEDIATE` transaction, recompute readiness, reap a stale lease for
 * this item, and create exactly one active lease — the
 * `uq_one_active_lease_per_work` partial unique index backs the arbitration,
 * and a competing claimer either serializes behind this one and is rejected
 * by the live-lease blocker, or loses the write lock. The item moves to
 * `IN_PROGRESS` under the `work/claimed` event. The lease id derives from the
 * appended event's sequence.
 * @param db - open ledger database.
 * @param workItemId - the work item to claim; readiness must recompute ready.
 * @param workerIdentity - the claiming worker, recorded on the lease row.
 * @param options - lease policy, actor, and clock overrides.
 * @returns the active lease with its one-time bearer token.
 * @throws {WorkReadinessError} on `unknown-work-item`.
 * @throws {LeaseError} on `work-not-ready` (carrying the recomputed blockers)
 * and `invalid-lease-config`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function claimWorkItem(
  db: DatabaseSync,
  workItemId: WorkItemId,
  workerIdentity: string,
  options: ClaimWorkItemOptions = {},
): WorkLeaseClaim {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_LEASE_ACTOR_REF
  const config = resolveLeaseConfig(options.leaseConfig)
  db.exec('BEGIN IMMEDIATE')
  try {
    const readiness = computeWorkReadiness(db, workItemId, { nowMs })
    if (!readiness.ready) {
      throw new LeaseError(
        'work-not-ready',
        `work item "${workItemId}" is not ready to claim: `
          + readiness.reasons.map(reason => reason.message).join('; '),
        readiness.reasons,
      )
    }
    reapStaleLease(db, workItemId, actorRef, nowMs)
    const item = db.prepare('SELECT project_id, status FROM work_items WHERE id = ?')
      .get(workItemId) as { project_id: string; status: PlanWorkItemStatus }
    // The claimer holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the lease id is the claimed event's.
    const leaseId = brandString<WorkLeaseId>(
      `ls:${workItemId}:${nextProjectEventSequence(db, brandString<ProjectId>(item.project_id))}`,
    )
    const expiresAtMs = nowMs + config.ttlMs
    const envelope = appendProjectEvent(
      db,
      // The project id crossed the durable work_items row boundary.
      brandString<ProjectId>(item.project_id),
      'work/claimed',
      {
        workItemId,
        leaseId,
        workerIdentity,
        fromStatus: item.status,
        toStatus: 'IN_PROGRESS',
        acquiredAtMs: nowMs,
        expiresAtMs,
      },
      { entityType: 'work_item', entityId: workItemId, actorRef, nowMs },
    )
    db.prepare('UPDATE work_items SET status = ?, updated_at_ms = ? WHERE id = ?')
      .run('IN_PROGRESS', nowMs, workItemId)
    const leaseToken = randomBytes(32).toString('hex')
    db.prepare(
      'INSERT INTO work_leases '
      + '(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(leaseId, workItemId, workerIdentity, hashLeaseToken(leaseToken), 'ACTIVE', nowMs, nowMs, expiresAtMs)
    db.exec('COMMIT')
    return {
      leaseId,
      workItemId,
      workerIdentity,
      status: 'ACTIVE',
      acquiredAtMs: nowMs,
      heartbeatAtMs: nowMs,
      expiresAtMs,
      releasedAtMs: undefined,
      leaseToken,
      sequenceNo: envelope.sequenceNo,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Extend one lease the caller still holds (F10): only the bearer token of the
 * lease itself may push its expiry out by the resolved `ttlMs`. A call at or
 * past expiry is refused — the reaper owns recovery.
 * @param db - open ledger database.
 * @param leaseId - the lease to extend.
 * @param leaseToken - the bearer token returned by the claim.
 * @param options - lease policy, actor, and clock overrides.
 * @returns the extended lease.
 * @throws {LeaseError} on `unknown-lease`, `lease-token-mismatch`,
 * `lease-not-active`, and `invalid-lease-config`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function heartbeatWorkLease(
  db: DatabaseSync,
  leaseId: WorkLeaseId,
  leaseToken: string,
  options: HeartbeatWorkLeaseOptions = {},
): WorkLease {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_LEASE_ACTOR_REF
  const config = resolveLeaseConfig(options.leaseConfig)
  db.exec('BEGIN IMMEDIATE')
  try {
    const lease = selectLease(db, leaseId)
    requireTokenMatch(lease, leaseToken)
    requireActive(lease, 'heartbeated')
    requireUnexpired(lease, nowMs)
    const workItemId = brandString<WorkItemId>(lease.work_item_id)
    const expiresAtMs = nowMs + config.ttlMs
    appendProjectEvent(
      db,
      // The project id crossed the durable work_leases join boundary.
      brandString<ProjectId>(lease.project_id),
      'work/lease-heartbeat',
      { workItemId, leaseId, workerIdentity: lease.worker_identity, expiresAtMs },
      { entityType: 'work_lease', entityId: leaseId, actorRef, nowMs },
    )
    db.prepare('UPDATE work_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ?')
      .run(nowMs, expiresAtMs, leaseId)
    db.exec('COMMIT')
    return {
      leaseId,
      workItemId,
      workerIdentity: lease.worker_identity,
      status: 'ACTIVE',
      acquiredAtMs: lease.acquired_at_ms,
      heartbeatAtMs: nowMs,
      expiresAtMs,
      releasedAtMs: undefined,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Give one lease back before expiry: the row moves to `RELEASED` and the
 * item's status is recomputed to `READY` or `BLOCKED` under the
 * `work/lease-released` event (§13). A call at or past expiry is refused —
 * the reaper owns recovery.
 * @param db - open ledger database.
 * @param leaseId - the lease to release.
 * @param leaseToken - the bearer token returned by the claim.
 * @param options - actor and clock overrides.
 * @returns the released lease.
 * @throws {LeaseError} on `unknown-lease`, `lease-token-mismatch`,
 * `lease-not-active`, and `invalid-lease-config`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function releaseWorkLease(
  db: DatabaseSync,
  leaseId: WorkLeaseId,
  leaseToken: string,
  options: ReleaseWorkLeaseOptions = {},
): WorkLease {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_LEASE_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const lease = selectLease(db, leaseId)
    requireTokenMatch(lease, leaseToken)
    requireActive(lease, 'released')
    requireUnexpired(lease, nowMs)
    const workItemId = brandString<WorkItemId>(lease.work_item_id)
    const toStatus = projectedStatusAfterGiveUp(db, workItemId, lease.item_status, nowMs, leaseId)
    appendProjectEvent(
      db,
      // The project id crossed the durable work_leases join boundary.
      brandString<ProjectId>(lease.project_id),
      'work/lease-released',
      { workItemId, leaseId, workerIdentity: lease.worker_identity, toStatus },
      { entityType: 'work_item', entityId: lease.work_item_id, actorRef, nowMs },
    )
    db.prepare("UPDATE work_leases SET status = 'RELEASED', released_at_ms = ? WHERE id = ?")
      .run(nowMs, leaseId)
    db.prepare('UPDATE work_items SET status = ?, updated_at_ms = ? WHERE id = ?').run(toStatus, nowMs, workItemId)
    db.exec('COMMIT')
    return {
      leaseId,
      workItemId,
      workerIdentity: lease.worker_identity,
      status: 'RELEASED',
      acquiredAtMs: lease.acquired_at_ms,
      heartbeatAtMs: lease.heartbeat_at_ms,
      expiresAtMs: lease.expires_at_ms,
      releasedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Reap every lease whose expiry has passed, in one bounded batch inside a
 * single transaction (F11): each gets a `work/lease-expired` event and its
 * item's status recomputed to `READY` or `BLOCKED`. The reaper never declares
 * a task `FAILED` (§13); a failed verdict stays an explicit decision.
 * @param db - open ledger database.
 * @param options - batch limit, actor, and clock overrides.
 * @returns one summary per reaped lease; empty when nothing has expired.
 * @throws {LeaseError} on `invalid-argument`.
 * @throws the underlying SQLite error when a write fails; the whole batch
 * rolls back.
 */
export function reapExpiredLeases(
  db: DatabaseSync,
  options: ReapExpiredLeasesOptions = {},
): ReapedLease[] {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_LEASE_ACTOR_REF
  const limit = options.limit ?? 64
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new LeaseError('invalid-argument', `reap limit must be a positive integer, got ${limit}`)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const stale = db.prepare(
      "SELECT id, work_item_id, worker_identity FROM work_leases WHERE status = 'ACTIVE' AND expires_at_ms <= ? "
      + 'ORDER BY id LIMIT ?',
    ).all(nowMs, limit) as { id: string; work_item_id: string; worker_identity: string }[]
    const reaped: ReapedLease[] = []
    for (const lease of stale) {
      const fromItemStatus = (db.prepare('SELECT status FROM work_items WHERE id = ?')
        .get(lease.work_item_id) as { status: PlanWorkItemStatus }).status
      const outcome = expireLease(db, lease, actorRef, nowMs)
      reaped.push({
        leaseId: brandString<WorkLeaseId>(lease.id),
        workItemId: brandString<WorkItemId>(lease.work_item_id),
        workerIdentity: lease.worker_identity,
        fromItemStatus,
        toItemStatus: outcome.toItemStatus,
        sequenceNo: outcome.sequenceNo,
      })
    }
    db.exec('COMMIT')
    return reaped
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** The validated inputs of one readiness projection writer, inside its transaction. */
interface ReadinessProjectionInputs {
  readonly readiness: WorkReadiness
  readonly projectId: ProjectId
  readonly itemStatus: PlanWorkItemStatus
}

/**
 * Recompute the projection writer's inputs: the readiness and the item row it
 * materializes onto. Callers hold `BEGIN IMMEDIATE`.
 */
function openReadinessProjection(
  db: DatabaseSync,
  workItemId: WorkItemId,
  nowMs: number,
): ReadinessProjectionInputs {
  const readiness = computeWorkReadiness(db, workItemId, { nowMs })
  const item = db.prepare('SELECT project_id, status FROM work_items WHERE id = ?')
    .get(workItemId) as { project_id: string; status: PlanWorkItemStatus }
  return { readiness, projectId: brandString<ProjectId>(item.project_id), itemStatus: item.status }
}

/**
 * One direction of the readiness projection pair (§12/§13): the vocabulary
 * event, the status pair it moves, and the gate that decides whether the
 * recomputed inputs allow the move.
 */
interface ReadinessProjectionSpec {
  readonly event: 'work/blocked' | 'work/unblocked'
  readonly fromStatus: 'READY' | 'BLOCKED'
  readonly toStatus: 'BLOCKED' | 'READY'
  /** Return the rejection to throw, or `undefined` when the move may land. */
  readonly reject: (inputs: ReadinessProjectionInputs) => LeaseError | undefined
  /** The event payload; the move itself has already been validated. */
  readonly payload: (workItemId: WorkItemId, inputs: ReadinessProjectionInputs) => Record<string, unknown>
}

/**
 * The one writer behind {@link blockWorkItem} and {@link unblockWorkItem}:
 * recompute the inputs inside `BEGIN IMMEDIATE`, ask the direction's gate,
 * then record the event and the status move atomically (§15).
 * @param db - open ledger database.
 * @param workItemId - the item whose readiness materializes.
 * @param options - actor and clock overrides.
 * @param spec - the direction's event, status pair, gate, and payload.
 * @returns the recorded move with the readiness behind it.
 * @throws {WorkReadinessError} on `unknown-work-item`.
 * @throws {LeaseError} the direction gate's rejection.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
function projectReadinessMove(
  db: DatabaseSync,
  workItemId: WorkItemId,
  options: ReadinessProjectionOptions,
  spec: ReadinessProjectionSpec,
): WorkReadinessProjectionChange {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_READINESS_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const inputs = openReadinessProjection(db, workItemId, nowMs)
    const rejection = spec.reject(inputs)
    if (rejection !== undefined) {
      throw rejection
    }
    const envelope = appendProjectEvent(
      db,
      inputs.projectId,
      spec.event,
      spec.payload(workItemId, inputs),
      { entityType: 'work_item', entityId: workItemId, actorRef, nowMs },
    )
    db.prepare('UPDATE work_items SET status = ?, updated_at_ms = ? WHERE id = ?')
      .run(spec.toStatus, nowMs, workItemId)
    db.exec('COMMIT')
    return {
      workItemId,
      fromStatus: spec.fromStatus,
      toStatus: spec.toStatus,
      readiness: inputs.readiness,
      sequenceNo: envelope.sequenceNo,
      createdAtMs: envelope.createdAtMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Materialize a blocked readiness onto a `READY` item through the
 * `work/blocked` event, carrying the recomputed blockers. The projection only
 * moves the `READY`/`BLOCKED` pair: an in-flight or terminal item is refused,
 * and a recomputation that comes back clean has nothing to materialize.
 * @param db - open ledger database.
 * @param workItemId - the item whose readiness materializes.
 * @param options - actor and clock overrides.
 * @returns the recorded move with the readiness behind it.
 * @throws {WorkReadinessError} on `unknown-work-item`.
 * @throws {LeaseError} on `nothing-to-block` and `status-not-projectable`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function blockWorkItem(
  db: DatabaseSync,
  workItemId: WorkItemId,
  options: ReadinessProjectionOptions = {},
): WorkReadinessProjectionChange {
  return projectReadinessMove(db, workItemId, options, {
    event: 'work/blocked',
    fromStatus: 'READY',
    toStatus: 'BLOCKED',
    reject: ({ readiness, itemStatus }) => {
      if (readiness.ready || itemStatus === 'BLOCKED') {
        return new LeaseError(
          'nothing-to-block',
          readiness.ready
            ? `work item "${workItemId}" recomputes ready; there is nothing to materialize as BLOCKED`
            : `work item "${workItemId}" is already materialized as BLOCKED`,
        )
      }
      if (itemStatus !== 'READY') {
        return new LeaseError(
          'status-not-projectable',
          `work item "${workItemId}" has status ${itemStatus}; the readiness projection only moves READY and BLOCKED items`,
        )
      }
      return undefined
    },
    payload: (id, inputs) => ({
      workItemId: id,
      fromStatus: 'READY',
      toStatus: 'BLOCKED',
      reasons: inputs.readiness.reasons,
    }),
  })
}

/**
 * Materialize a clean readiness onto a `BLOCKED` item through the
 * `work/unblocked` event. The mirror of {@link blockWorkItem}: the projection
 * only moves the `READY`/`BLOCKED` pair, and a recomputation that still finds
 * blockers has nothing to materialize.
 * @param db - open ledger database.
 * @param workItemId - the item whose readiness materializes.
 * @param options - actor and clock overrides.
 * @returns the recorded move with the readiness behind it.
 * @throws {WorkReadinessError} on `unknown-work-item`.
 * @throws {LeaseError} on `nothing-to-unblock` and `status-not-projectable`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function unblockWorkItem(
  db: DatabaseSync,
  workItemId: WorkItemId,
  options: ReadinessProjectionOptions = {},
): WorkReadinessProjectionChange {
  return projectReadinessMove(db, workItemId, options, {
    event: 'work/unblocked',
    fromStatus: 'BLOCKED',
    toStatus: 'READY',
    reject: ({ readiness, itemStatus }) => {
      if (!readiness.ready || itemStatus === 'READY') {
        return new LeaseError(
          'nothing-to-unblock',
          !readiness.ready
            ? `work item "${workItemId}" recomputes blocked: `
              + readiness.reasons.map(reason => reason.message).join('; ')
            : `work item "${workItemId}" is already materialized as READY`,
          readiness.reasons,
        )
      }
      if (itemStatus !== 'BLOCKED') {
        return new LeaseError(
          'status-not-projectable',
          `work item "${workItemId}" has status ${itemStatus}; the readiness projection only moves READY and BLOCKED items`,
        )
      }
      return undefined
    },
    payload: id => ({ workItemId: id, fromStatus: 'BLOCKED', toStatus: 'READY' }),
  })
}
