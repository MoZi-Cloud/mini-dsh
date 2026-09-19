/**
 * The ledger-side plan doctor (v1.6a F05, BOOT-01): one fail-closed read
 * pass over an imported plan version that re-verifies the rows against the
 * invariants import promised — every work item carries acceptance, every
 * criterion carries its verifier, the work graph is acyclic, relations stay
 * inside one project, no lease row still records ACTIVE past its own expiry,
 * the event timeline is readable by this codec, and the replayed projection
 * agrees with the materialized tables (work items, criteria, leases, the
 * decision domain, and the approval domain). The doctor never
 * mutates and never executes a verifier command; it reports every
 * independent issue it finds, so a caller sees the whole picture in one
 * pass. The database and event format versions ride along as report facts
 * (the open seam owns rejecting version mismatches, and the event reader
 * owns rejecting foreign formats).
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/doctor
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ApprovalId } from './approvals.js'
import type { DecisionId, DecisionRequestId } from './decisions.js'
import type { WorkLeaseId } from './lease.js'
import type { AcceptanceCriterionId, PlanVersionId, ProjectId, WorkItemId } from './plan-compile.js'
import { PROJECT_EVENT_FORMAT_VERSION, replayProjectEvents, type ReplayedProjectProjection } from './project-events.js'
import { detectWorkGraphCycles } from './work-readiness.js'

/** Closed set of plan-doctor issue codes. */
export const PLAN_DOCTOR_ISSUE_CODES = [
  'work-item-without-acceptance',
  'criterion-without-verifier',
  'hierarchy-cycle',
  'ordering-cycle',
  'relation-crosses-projects',
  'stale-active-lease',
  'event-timeline-unreadable',
  'projection-drift',
] as const

/** One independent finding of the doctor pass. */
export interface PlanDoctorIssue {
  readonly code: (typeof PLAN_DOCTOR_ISSUE_CODES)[number]
  /** Ledger id of the row the finding names, when there is one. */
  readonly refId?: string
  /** The concrete, caller-displayable finding. */
  readonly message: string
}

/** The row counts the doctor reports, so a caller sees what was checked. */
export interface PlanDoctorCounts {
  readonly phases: number
  readonly workItems: number
  readonly relations: number
  readonly criteria: number
  readonly events: number
}

/** The outcome of one doctor pass. */
export interface PlanDoctorReport {
  readonly planVersionId: PlanVersionId
  readonly planId: string
  readonly versionNo: number
  readonly status: string
  readonly projectId: ProjectId
  /** The database's stamped layout version, surfaced as a fact; the open seam owns rejecting mismatches. */
  readonly databaseUserVersion: number
  /** The event format this build reads, which the timeline check decoded the rows with. */
  readonly eventFormatVersion: number
  readonly baselineRepoHead: string | null
  readonly baselineWorktreeHash: string | null
  readonly counts: PlanDoctorCounts
  /** Every independent finding; empty exactly when the version passes the pass. */
  readonly issues: readonly PlanDoctorIssue[]
}

/** Closed set of doctor rejection reasons. */
export type PlanDoctorErrorCode = 'unknown-plan-version'

/** Options for {@link planDoctor}. */
export interface PlanDoctorOptions {
  /**
   * Wall clock the lease-staleness check reads; defaults to `Date.now()`.
   * Every other check is clock-free.
   */
  readonly nowMs?: number | undefined
}

/** Thrown when the doctor is asked about a version the ledger does not record. */
export class PlanDoctorError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: PlanDoctorErrorCode

  /** @param code - why the doctor pass was rejected. @param message - the concrete reason. */
  constructor(code: PlanDoctorErrorCode, message: string) {
    super(message)
    this.name = 'PlanDoctorError'
    this.code = code
  }
}

/** One `work_items` row the parity check reads, in select order. */
interface ItemStatusRow {
  readonly id: string
  readonly status: string
}

/** One `acceptance_criteria` row the parity check reads, in select order. */
interface CriterionStatusRow {
  readonly id: string
  readonly work_item_id: string
  readonly status: string
}

/** One `work_leases` row the parity check reads, in select order. */
interface LeaseStatusRow {
  readonly id: string
  readonly status: string
}

/** One `work_leases` row the staleness check reads, in select order. */
interface LeaseExpiryRow {
  readonly id: string
  readonly expires_at_ms: number
}

/**
 * Run one doctor pass over an imported plan version (F05): reference,
 * cycle, acceptance, relation-scope, lease-staleness, event-readability,
 * and replay-parity checks in one read-only sweep, plus the version's
 * identity, baseline, and row counts as report facts.
 * @param db - open ledger database.
 * @param planVersionId - the imported version to check.
 * @param options - the wall clock the lease-staleness check reads.
 * @returns the report with every independent issue; `issues` empty exactly
 * when the version passes.
 * @throws {PlanDoctorError} on `unknown-plan-version`.
 */
export function planDoctor(
  db: DatabaseSync,
  planVersionId: PlanVersionId,
  options: PlanDoctorOptions = {},
): PlanDoctorReport {
  const version = db.prepare(
    'SELECT v.plan_id AS plan_id, v.version_no AS version_no, v.status AS status, '
    + 'v.baseline_repo_head AS baseline_repo_head, v.baseline_worktree_hash AS baseline_worktree_hash, '
    + 'p.project_id AS project_id '
    + 'FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?',
  ).get(planVersionId) as {
    plan_id: string
    version_no: number
    status: string
    baseline_repo_head: string | null
    baseline_worktree_hash: string | null
    project_id: string
  } | undefined
  if (version === undefined) {
    throw new PlanDoctorError(
      'unknown-plan-version',
      `plan version "${planVersionId}" is not recorded in this ledger`,
    )
  }
  const projectId = version.project_id as ProjectId
  const issues: PlanDoctorIssue[] = []

  for (const row of db.prepare(
    'SELECT w.id AS id FROM work_items w '
    + 'LEFT JOIN acceptance_criteria c ON c.work_item_id = w.id '
    + 'WHERE w.plan_version_id = ? GROUP BY w.id HAVING COUNT(c.id) = 0 ORDER BY w.id',
  ).all(planVersionId) as { id: string }[]) {
    issues.push({
      code: 'work-item-without-acceptance',
      refId: row.id,
      message: `work item "${row.id}" records no acceptance criterion; a completable item owes at least one`,
    })
  }

  for (const row of db.prepare(
    'SELECT c.id AS id FROM acceptance_criteria c '
    + 'JOIN work_items w ON w.id = c.work_item_id '
    + 'LEFT JOIN verification_specs s ON s.criterion_id = c.id '
    + 'WHERE w.plan_version_id = ? AND s.id IS NULL ORDER BY c.id',
  ).all(planVersionId) as { id: string }[]) {
    issues.push({
      code: 'criterion-without-verifier',
      refId: row.id,
      message: `acceptance criterion "${row.id}" records no verification spec; its outcome would be unverifiable`,
    })
  }

  const cycles = detectWorkGraphCycles(db, projectId)
  // A cycle names several rows, so its issue carries the whole loop instead
  // of one refId.
  for (const cycle of cycles.hierarchyCycles) {
    issues.push({
      code: 'hierarchy-cycle',
      message: `parent composition forms a cycle: ${cycle.join(' -> ')}`,
    })
  }
  for (const cycle of cycles.orderingCycles) {
    issues.push({
      code: 'ordering-cycle',
      message: `ordering relations form a cycle: ${cycle.join(' -> ')}`,
    })
  }

  for (const row of db.prepare(
    'SELECT r.id AS id, wf.project_id AS from_project, wt.project_id AS to_project '
    + 'FROM work_item_relations r '
    + 'JOIN work_items wf ON wf.id = r.from_work_item_id '
    + 'JOIN work_items wt ON wt.id = r.to_work_item_id '
    + 'WHERE wf.project_id <> wt.project_id ORDER BY r.id',
  ).all() as { id: string; from_project: string; to_project: string }[]) {
    issues.push({
      code: 'relation-crosses-projects',
      refId: row.id,
      message: `relation "${row.id}" crosses projects (${row.from_project} -> ${row.to_project}); the work graph is per project`,
    })
  }

  // The staleness predicate equals reapExpiredLeases': a row the reaper would
  // reap is a row the doctor reports. The reaper is caller-driven and batched,
  // so a behind or unmounted reaper leaves these rows; replay parity cannot
  // see them, because the fold projects the same ACTIVE status.
  for (const row of db.prepare(
    'SELECT l.id AS id, l.expires_at_ms AS expires_at_ms FROM work_leases l '
    + 'JOIN work_items w ON w.id = l.work_item_id '
    + "WHERE w.project_id = ? AND l.status = 'ACTIVE' AND l.expires_at_ms <= ? ORDER BY l.id",
  ).all(projectId, options.nowMs ?? Date.now()) as unknown as LeaseExpiryRow[]) {
    issues.push({
      code: 'stale-active-lease',
      refId: row.id,
      message: `work lease "${row.id}" is still ACTIVE past its expiry at ${row.expires_at_ms}; the reaper owns its recovery`,
    })
  }

  const databaseUserVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const eventCount = (db.prepare('SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?')
    .get(projectId) as { n: number }).n
  let projection: ReplayedProjectProjection | undefined
  try {
    projection = replayProjectEvents(db, projectId)
  } catch (error: unknown) {
    // The doctor reports, it does not diagnose: whatever blocked the decode,
    // the timeline is unreadable by this build's event format.
    issues.push({
      code: 'event-timeline-unreadable',
      message: `the project event timeline cannot be decoded by event format ${PROJECT_EVENT_FORMAT_VERSION}: ${(error as Error).message}`,
    })
  }
  if (projection !== undefined) {
    collectProjectionDrift(db, projectId, projection, issues)
  }

  return {
    planVersionId,
    planId: version.plan_id,
    versionNo: version.version_no,
    status: version.status,
    projectId,
    databaseUserVersion,
    eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION,
    baselineRepoHead: version.baseline_repo_head,
    baselineWorktreeHash: version.baseline_worktree_hash,
    counts: {
      phases: (db.prepare('SELECT COUNT(*) AS n FROM phases WHERE plan_version_id = ?')
        .get(planVersionId) as { n: number }).n,
      workItems: (db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE plan_version_id = ?')
        .get(planVersionId) as { n: number }).n,
      relations: (db.prepare(
        'SELECT COUNT(*) AS n FROM work_item_relations r '
        + 'JOIN work_items w ON w.id = r.from_work_item_id WHERE w.project_id = ?',
      ).get(projectId) as { n: number }).n,
      criteria: (db.prepare(
        'SELECT COUNT(*) AS n FROM acceptance_criteria c '
        + 'JOIN work_items w ON w.id = c.work_item_id WHERE w.plan_version_id = ?',
      ).get(planVersionId) as { n: number }).n,
      events: eventCount,
    },
    issues,
  }
}

/** Compare the replayed projection with the materialized rows it should equal (BOOT-04). */
function collectProjectionDrift(
  db: DatabaseSync,
  projectId: ProjectId,
  projection: ReplayedProjectProjection,
  issues: PlanDoctorIssue[],
): void {
  const itemRows = db.prepare('SELECT id, status FROM work_items WHERE project_id = ? ORDER BY id')
    .all(projectId) as unknown as ItemStatusRow[]
  for (const row of itemRows) {
    const replayed = projection.workItems.get(brandString<WorkItemId>(row.id))
    if (replayed === undefined) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `work item "${row.id}" has materialized status ${row.status} but no replayed work/created event`,
      })
      continue
    }
    if (replayed.status !== row.status) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `work item "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  const criterionRows = db.prepare(
    'SELECT c.id, c.work_item_id, c.status FROM acceptance_criteria c '
    + 'JOIN work_items w ON w.id = c.work_item_id WHERE w.project_id = ? ORDER BY c.id',
  ).all(projectId) as unknown as CriterionStatusRow[]
  for (const row of criterionRows) {
    const replayed = projection.workItems.get(brandString<WorkItemId>(row.work_item_id))
      ?.criteria.get(brandString<AcceptanceCriterionId>(row.id))
    if (replayed === undefined) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `acceptance criterion "${row.id}" has materialized status ${row.status} but no replayed status`,
      })
      continue
    }
    if (replayed.status !== row.status) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `acceptance criterion "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  const leaseRows = db.prepare(
    'SELECT l.id, l.status FROM work_leases l JOIN work_items w ON w.id = l.work_item_id '
    + 'WHERE w.project_id = ? ORDER BY l.id',
  ).all(projectId) as unknown as LeaseStatusRow[]
  for (const row of leaseRows) {
    const replayed = projection.leases.get(brandString<WorkLeaseId>(row.id))
    if (replayed === undefined) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `work lease "${row.id}" has materialized status ${row.status} but no replayed claim event`,
      })
      continue
    }
    if (replayed.status !== row.status) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `work lease "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  const requestRows = db.prepare(
    'SELECT id, status FROM decision_requests WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as { id: string; status: string }[]
  for (const row of requestRows) {
    const replayed = projection.decisionRequests.get(brandString<DecisionRequestId>(row.id))
    if (replayed === undefined) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `decision request "${row.id}" has materialized status ${row.status} but no replayed decision/requested event`,
      })
      continue
    }
    if (replayed.status !== row.status) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `decision request "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
  }
  const decisionRows = db.prepare(
    'SELECT d.id, d.decision_request_id AS request_id, d.decided_by FROM decisions d '
    + 'JOIN decision_requests r ON r.id = d.decision_request_id WHERE r.project_id = ? ORDER BY d.id',
  ).all(projectId) as unknown as { id: string; request_id: string; decided_by: string }[]
  for (const row of decisionRows) {
    const replayed = projection.decisions.get(brandString<DecisionId>(row.id))
    if (replayed === undefined) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `decision "${row.id}" is materialized for "${row.request_id}" but no replayed decision/recorded event`,
      })
      continue
    }
    if (replayed.requestId !== row.request_id || replayed.decidedBy !== row.decided_by) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `decision "${row.id}" materializes for "${row.request_id}" by ${row.decided_by} `
          + `but replays for "${replayed.requestId}" by ${replayed.decidedBy}`,
      })
    }
  }
  const approvalRows = db.prepare(
    'SELECT id, subject_type, subject_id, status, decided_by FROM approvals WHERE project_id = ? ORDER BY id',
  ).all(projectId) as unknown as { id: string; subject_type: string; subject_id: string; status: string; decided_by: string | null }[]
  for (const row of approvalRows) {
    const replayed = projection.approvals.get(brandString<ApprovalId>(row.id))
    if (replayed === undefined) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `approval "${row.id}" has materialized status ${row.status} but no replayed approval/requested event`,
      })
      continue
    }
    if (replayed.subjectType !== row.subject_type || replayed.subjectId !== row.subject_id) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `approval "${row.id}" materializes over ${row.subject_type} "${row.subject_id}" `
          + `but replays over ${replayed.subjectType} "${replayed.subjectId}"`,
      })
    }
    if (replayed.status !== row.status) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `approval "${row.id}" has materialized status ${row.status} but replays to ${replayed.status}`,
      })
    }
    if (replayed.decidedBy !== (row.decided_by ?? undefined)) {
      issues.push({
        code: 'projection-drift',
        refId: row.id,
        message: `approval "${row.id}" materializes decided by ${row.decided_by ?? 'nobody'} `
          + `but replays decided by ${replayed.decidedBy ?? 'nobody'}`,
      })
    }
  }
}
