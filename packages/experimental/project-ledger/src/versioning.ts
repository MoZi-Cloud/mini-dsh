/**
 * Immutable plan-version supersede and baseline drift (v1.6a §21/§22,
 * BOOT-08): the writers that retire a plan version and the writer that
 * records a repository drifting off a version's pinned baseline. Both are
 * additive-history writers — supersede moves only the version's lifecycle
 * columns (`status`, `superseded_at_ms`) and the `plans.current_version_id`
 * pointer when it named the retired version; the version's plan facts, its
 * work items' origins, and every recorded evaluation stay byte-identical.
 * Drift never rewrites the baseline columns: the pinned baseline is the
 * version's immutable record, and moving it silently to a new HEAD is
 * forbidden (§21) — the owner answers a drift with a superseding version or
 * an explicit rebind, not a pointer edit.
 *
 * §22's default policy is `freeze-new-claims-and-review-active`: once a
 * version is `SUPERSEDED`, readiness recomputation denies every new claim on
 * its items (`plan-version-not-active`), live attempts keep their leases but
 * land `BLOCKED` — never resurrected — when they give the lease up, and the
 * supersede event records the attempts that require review. A drift blocks
 * its work item's next claim through an open `BASELINE_DRIFT` external
 * blocker row.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/versioning
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { WorkLeaseId } from './lease.js'
import type { PlanId, PlanVersionId, ProjectId, WorkItemId } from './plan-compile.js'
import { SUPERSEDE_POLICY, appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one work external blocker row (`work_external_blockers.id`). */
export type WorkExternalBlockerId = Branded<'WorkExternalBlockerId'>

/** The controlled lifecycle status of one `plan_versions` row. */
export const PLAN_VERSION_STATUSES = ['DRAFT', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'REJECTED'] as const

/** The controlled lifecycle status of one `plan_versions` row. */
export type PlanVersionStatus = (typeof PLAN_VERSION_STATUSES)[number]

/** Writer identity recorded on supersede events by default. */
export const DEFAULT_SUPERSEDE_ACTOR_REF = 'dsh-experimental-project-ledger/supersede'

/** Writer identity recorded on drift events by default. */
export const DEFAULT_DRIFT_ACTOR_REF = 'dsh-experimental-project-ledger/baseline-drift'

/** Closed set of supersede rejection reasons. */
export type PlanSupersedeErrorCode =
  | 'unknown-plan-version'
  | 'version-not-active'
  | 'unknown-successor'
  | 'successor-not-same-plan'

/** Thrown by {@link supersedePlanVersion}; the rejection writes nothing. */
export class PlanSupersedeError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: PlanSupersedeErrorCode

  /** @param code - why the supersede was rejected. @param message - the concrete reason. */
  constructor(code: PlanSupersedeErrorCode, message: string) {
    super(message)
    this.name = 'PlanSupersedeError'
    this.code = code
  }
}

/** Closed set of baseline-drift rejection reasons. */
export type BaselineDriftErrorCode =
  | 'unknown-work-item'
  | 'work-item-unplanned'
  | 'baseline-unpinned'
  | 'baseline-unchanged'

/** Thrown by {@link recordBaselineDrift}; the rejection writes nothing. */
export class BaselineDriftError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: BaselineDriftErrorCode

  /** @param code - why the drift report was rejected. @param message - the concrete reason. */
  constructor(code: BaselineDriftErrorCode, message: string) {
    super(message)
    this.name = 'BaselineDriftError'
    this.code = code
  }
}

/** One live attempt the supersede policy hands to review. */
export interface SupersededAttempt {
  readonly workItemId: WorkItemId
  readonly leaseId: WorkLeaseId
  readonly workerIdentity: string
  readonly expiresAtMs: number
}

/** Options for {@link supersedePlanVersion}. */
export interface SupersedePlanVersionOptions {
  /** The version that continues the plan, when one already exists; it must belong to the same plan. */
  readonly succeededBy?: PlanVersionId | undefined
  /** Actor recorded on the event; defaults to {@link DEFAULT_SUPERSEDE_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the row and event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** The recorded outcome of one plan-version supersede. */
export interface PlanVersionSupersede {
  readonly planVersionId: PlanVersionId
  readonly planId: PlanId
  /** The named successor version, when the supersede recorded one. */
  readonly succeededBy: PlanVersionId | undefined
  readonly policy: typeof SUPERSEDE_POLICY
  readonly supersededAtMs: number
  /** Live attempts at supersede time; the review queue the policy creates. */
  readonly reviewAttempts: readonly SupersededAttempt[]
  readonly sequenceNo: number
}

/**
 * Retire one `ACTIVE` plan version (§22, BOOT-08) inside a single
 * `BEGIN IMMEDIATE` transaction: append the required
 * `plan/version-superseded` event (carrying the freeze policy and the live
 * attempts that now require review), move the version to `SUPERSEDED` with
 * its `superseded_at_ms` stamp, and repoint `plans.current_version_id` when
 * it named this version. New claims on the version's items stop through the
 * readiness recompute (`plan-version-not-active`); live attempts keep their
 * leases and are never migrated. Completed work, the version's plan facts,
 * and every recorded evaluation are untouched — a superseded version and its
 * history remain queryable.
 * @param db - open ledger database.
 * @param planVersionId - the `ACTIVE` version to retire.
 * @param options - successor, actor, and clock overrides.
 * @returns the recorded supersede with its review queue.
 * @throws {PlanSupersedeError} on `unknown-plan-version`, `version-not-active`,
 * `unknown-successor`, and `successor-not-same-plan`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function supersedePlanVersion(
  db: DatabaseSync,
  planVersionId: PlanVersionId,
  options: SupersedePlanVersionOptions = {},
): PlanVersionSupersede {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_SUPERSEDE_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = db.prepare('SELECT plan_id, status FROM plan_versions WHERE id = ?')
      .get(planVersionId) as { plan_id: string; status: PlanVersionStatus } | undefined
    if (version === undefined) {
      throw new PlanSupersedeError(
        'unknown-plan-version',
        `plan version "${planVersionId}" is not recorded in this ledger`,
      )
    }
    if (version.status !== 'ACTIVE') {
      throw new PlanSupersedeError(
        'version-not-active',
        `plan version "${planVersionId}" is ${version.status}; only an ACTIVE version can be superseded`,
      )
    }
    if (options.succeededBy !== undefined) {
      const successor = db.prepare('SELECT plan_id FROM plan_versions WHERE id = ?')
        .get(options.succeededBy) as { plan_id: string } | undefined
      if (successor === undefined) {
        throw new PlanSupersedeError(
          'unknown-successor',
          `plan version "${options.succeededBy}" named as the successor is not recorded in this ledger`,
        )
      }
      if (successor.plan_id !== version.plan_id) {
        throw new PlanSupersedeError(
          'successor-not-same-plan',
          `plan version "${options.succeededBy}" belongs to plan "${successor.plan_id}"; a successor must `
            + `continue plan "${version.plan_id}"`,
        )
      }
    }
    const reviewAttempts: SupersededAttempt[] = (db.prepare(
      'SELECT w.id AS work_item_id, l.id AS lease_id, l.worker_identity AS worker_identity, '
      + 'l.expires_at_ms AS expires_at_ms '
      + 'FROM work_items w JOIN work_leases l ON l.work_item_id = w.id '
      + "WHERE w.plan_version_id = ? AND w.status = 'IN_PROGRESS' AND l.status = 'ACTIVE' AND l.expires_at_ms > ? "
      + 'ORDER BY w.id',
    ).all(planVersionId, nowMs) as {
      work_item_id: string
      lease_id: string
      worker_identity: string
      expires_at_ms: number
    }[]).map(row => ({
      workItemId: brandString<WorkItemId>(row.work_item_id),
      leaseId: brandString<WorkLeaseId>(row.lease_id),
      workerIdentity: row.worker_identity,
      expiresAtMs: row.expires_at_ms,
    }))
    const projectId = brandString<ProjectId>(
      (db.prepare('SELECT project_id FROM plans WHERE id = ?').get(version.plan_id) as { project_id: string }).project_id,
    )
    const sequenceNo = nextProjectEventSequence(db, projectId)
    const succeededBy = options.succeededBy
    appendProjectEvent(
      db,
      projectId,
      'plan/version-superseded',
      {
        planId: version.plan_id,
        planVersionId,
        ...(succeededBy === undefined ? {} : { succeededBy }),
        policy: SUPERSEDE_POLICY,
        supersededAtMs: nowMs,
        reviewAttempts,
      },
      { entityType: 'plan_version', entityId: planVersionId, actorRef, nowMs },
    )
    db.prepare("UPDATE plan_versions SET status = 'SUPERSEDED', superseded_at_ms = ? WHERE id = ?")
      .run(nowMs, planVersionId)
    db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ? AND current_version_id = ?')
      .run(succeededBy ?? null, version.plan_id, planVersionId)
    db.exec('COMMIT')
    return {
      planVersionId,
      planId: brandString<PlanId>(version.plan_id),
      succeededBy,
      policy: SUPERSEDE_POLICY,
      supersededAtMs: nowMs,
      reviewAttempts,
      sequenceNo,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** The repository facts a caller observed, to compare with a version's pinned baseline. */
export interface ObservedBaseline {
  readonly repoHead: string | null
  readonly worktreeHash: string | null
}

/** Options for {@link recordBaselineDrift}. */
export interface RecordBaselineDriftOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_DRIFT_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the row and event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** The recorded outcome of one baseline drift. */
export interface BaselineDrift {
  readonly driftId: WorkExternalBlockerId
  readonly workItemId: WorkItemId
  readonly planVersionId: PlanVersionId
  readonly baselineRepoHead: string | null
  readonly baselineWorktreeHash: string | null
  readonly observedRepoHead: string | null
  readonly observedWorktreeHash: string | null
  readonly detectedAtMs: number
  readonly sequenceNo: number
}

/**
 * Record one work item's repository drifting off its plan version's pinned
 * baseline (§21), inside a single `BEGIN IMMEDIATE` transaction: append the
 * required `baseline/drift-detected` event and insert an open
 * `BASELINE_DRIFT` external blocker on the work item, so the item's next
 * claim is denied until the owner resolves the blocker, waives it, or
 * supersedes the plan version. The baseline columns are never rewritten —
 * the version keeps its original pin, and the observed facts live only in
 * the event and the blocker row. An unpinned version (both baseline columns
 * null) cannot drift, and facts equal to the pin are not drift.
 * @param db - open ledger database.
 * @param workItemId - the work item whose bound sources drifted.
 * @param observed - the repository facts the caller observed.
 * @param options - actor and clock overrides.
 * @returns the recorded drift with its blocker id.
 * @throws {BaselineDriftError} on `unknown-work-item`, `work-item-unplanned`,
 * `baseline-unpinned`, and `baseline-unchanged`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function recordBaselineDrift(
  db: DatabaseSync,
  workItemId: WorkItemId,
  observed: ObservedBaseline,
  options: RecordBaselineDriftOptions = {},
): BaselineDrift {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_DRIFT_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const item = db.prepare('SELECT project_id, plan_version_id FROM work_items WHERE id = ?')
      .get(workItemId) as { project_id: string; plan_version_id: string | null } | undefined
    if (item === undefined) {
      throw new BaselineDriftError(
        'unknown-work-item',
        `work item "${workItemId}" is not recorded in this ledger`,
      )
    }
    if (item.plan_version_id === null) {
      throw new BaselineDriftError(
        'work-item-unplanned',
        `work item "${workItemId}" records no plan version; baseline drift is a plan version's pinned fact`,
      )
    }
    const baseline = db.prepare('SELECT baseline_repo_head, baseline_worktree_hash FROM plan_versions WHERE id = ?')
      .get(item.plan_version_id) as { baseline_repo_head: string | null; baseline_worktree_hash: string | null }
    if (baseline.baseline_repo_head === null && baseline.baseline_worktree_hash === null) {
      throw new BaselineDriftError(
        'baseline-unpinned',
        `plan version "${item.plan_version_id}" pins no baseline; an unpinned version cannot drift`,
      )
    }
    if (
      baseline.baseline_repo_head === observed.repoHead
      && baseline.baseline_worktree_hash === observed.worktreeHash
    ) {
      throw new BaselineDriftError(
        'baseline-unchanged',
        `the observed repository facts equal the baseline pinned by plan version "${item.plan_version_id}"`,
      )
    }
    const projectId = brandString<ProjectId>(item.project_id)
    // The writer holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the blocker id is the drift event's.
    const sequenceNo = nextProjectEventSequence(db, projectId)
    const driftId = brandString<WorkExternalBlockerId>(`dr:${workItemId}:${sequenceNo}`)
    appendProjectEvent(
      db,
      projectId,
      'baseline/drift-detected',
      {
        workItemId,
        planVersionId: item.plan_version_id,
        blockerId: driftId,
        baselineRepoHead: baseline.baseline_repo_head,
        baselineWorktreeHash: baseline.baseline_worktree_hash,
        observedRepoHead: observed.repoHead,
        observedWorktreeHash: observed.worktreeHash,
      },
      { entityType: 'work_external_blocker', entityId: driftId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO work_external_blockers '
      + '(id, work_item_id, blocker_kind, title, detail, status, external_ref, created_at_ms) '
      + "VALUES (?, ?, 'BASELINE_DRIFT', ?, ?, 'OPEN', ?, ?)",
    ).run(
      driftId,
      workItemId,
      `baseline drift on plan version ${item.plan_version_id}`,
      `pinned head ${baseline.baseline_repo_head ?? 'none'} / worktree ${baseline.baseline_worktree_hash ?? 'none'} `
        + `observed head ${observed.repoHead ?? 'none'} / worktree ${observed.worktreeHash ?? 'none'}`,
      observed.repoHead,
      nowMs,
    )
    db.exec('COMMIT')
    return {
      driftId,
      workItemId,
      planVersionId: brandString<PlanVersionId>(item.plan_version_id),
      baselineRepoHead: baseline.baseline_repo_head,
      baselineWorktreeHash: baseline.baseline_worktree_hash,
      observedRepoHead: observed.repoHead,
      observedWorktreeHash: observed.worktreeHash,
      detectedAtMs: nowMs,
      sequenceNo,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}
