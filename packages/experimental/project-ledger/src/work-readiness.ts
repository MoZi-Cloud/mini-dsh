/**
 * Work readiness and ledger-side work-graph checks (v1.6a §10/§12/§17).
 * {@link computeWorkReadiness} recomputes claimability from the causal inputs
 * the constitution lists — plan-version status, phase status, ordering
 * relations, external blockers, required acceptance criteria, active leases,
 * and the work item's own status — instead of trusting the materialized
 * `READY`/`BLOCKED` status, which is only a projection of these inputs (§17).
 * Hierarchy is composition, not dependency (§10): `parent_work_item_id` never
 * enters the readiness decision. {@link detectWorkGraphCycles} runs the
 * compile-time cycle semantics over the materialized rows, so relations or
 * parent chains written outside the compiler are caught against the same
 * graph rules.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/work-readiness
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import { ORDERING_RELATION_KINDS, findChainCycles, findOrderingCycles } from './relation-graph.js'

/**
 * Work item statuses open for a claim. Every other status is closed: a
 * mid-flight item is already claimed, and a terminal or failed item needs an
 * explicit decision before it can be claimed again. Enumerating the open set
 * keeps unknown statuses closed.
 */
const OPEN_FOR_CLAIM_STATUSES: ReadonlySet<string> = new Set(['PROPOSED', 'READY', 'BLOCKED'])

/** The closed set of readiness blocker kinds. */
export const WORK_READINESS_BLOCKER_KINDS = [
  'plan-version-not-active',
  'phase-not-active',
  'blocking-relation-open',
  'external-blocker-open',
  'acceptance-criterion-blocked',
  'lease-active',
  'work-status-closed',
] as const

/** Closed set of readiness blocker kinds. */
export type WorkReadinessBlockerKind = (typeof WORK_READINESS_BLOCKER_KINDS)[number]

/** One reason a work item is not ready to be claimed. */
export interface WorkReadinessReason {
  /** The closed blocker kind. */
  readonly kind: WorkReadinessBlockerKind
  /** Ledger id of the row the blocker names, when there is one. */
  readonly refId?: string
  /** The concrete, caller-displayable blocker fact. */
  readonly message: string
}

/** The recomputed claimability of one work item. Agents must not claim `ready: false` items. */
export interface WorkReadiness {
  /** `true` only when no blocker applies right now. */
  readonly ready: boolean
  /** Every blocker, in a fixed check order; empty exactly when `ready`. */
  readonly reasons: readonly WorkReadinessReason[]
}

/** Closed set of readiness rejection reasons. */
export type WorkReadinessErrorCode = 'unknown-work-item'

/**
 * Thrown when readiness is asked about a work item the ledger does not
 * record. Nothing is written, so there is nothing to roll back.
 */
export class WorkReadinessError extends Error {
  readonly code: WorkReadinessErrorCode

  /** @param code - why the readiness query was rejected. @param message - the concrete reason. */
  constructor(code: WorkReadinessErrorCode, message: string) {
    super(message)
    this.name = 'WorkReadinessError'
    this.code = code
  }
}

/** Options for {@link computeWorkReadiness}. */
export interface ComputeWorkReadinessOptions {
  /** Now, for the lease-expiry comparison; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
  /**
   * Evaluate every input while treating the item's own status gate as open.
   * The lease lifecycle recomputes the projected status of an item it is
   * about to move out of `IN_PROGRESS`; the claim path keeps the gate.
   */
  readonly treatStatusAsOpen?: boolean | undefined
  /**
   * Exclude one lease id from the live-lease check. A release recomputes the
   * item's projected status before its own lease row moves, so that row must
   * not count as a live lease.
   */
  readonly ignoreLeaseId?: string | undefined
}

/**
 * Recompute the readiness of one work item from the rows the constitution
 * lists as readiness inputs (§17): the item's own status (mid-flight and
 * terminal statuses are closed to claims), its plan version (`ACTIVE` or the
 * item is unplanned backlog with no version to check), its phase (`READY` or
 * `ACTIVE`), incoming `BLOCKS`/`PRECEDES` edges (satisfied when the source
 * item is `DONE`), open external blockers, required acceptance criteria in
 * `FAILING`/`BLOCKED`, and a live active lease. Incoming `SUPERSEDES` edges
 * are the supersede flow's projection (a later work package).
 * @param db - open ledger database.
 * @param workItemId - the work item to recompute.
 * @param options - clock override, status-gate, and lease-exclusion controls.
 * @returns the recomputed readiness with every blocker and its ledger id.
 * @throws {WorkReadinessError} on `unknown-work-item`.
 */
export function computeWorkReadiness(
  db: DatabaseSync,
  workItemId: WorkItemId,
  options: ComputeWorkReadinessOptions = {},
): WorkReadiness {
  const item = db
    .prepare('SELECT plan_version_id, phase_id, status FROM work_items WHERE id = ?')
    .get(workItemId) as { plan_version_id: string | null; phase_id: string | null; status: string } | undefined
  if (item === undefined) {
    throw new WorkReadinessError(
      'unknown-work-item',
      `work item "${workItemId}" is not recorded in this ledger`,
    )
  }
  const nowMs = options.nowMs ?? Date.now()
  const reasons: WorkReadinessReason[] = []

  if (options.treatStatusAsOpen !== true && !OPEN_FOR_CLAIM_STATUSES.has(item.status)) {
    reasons.push({
      kind: 'work-status-closed',
      message: `work item "${workItemId}" has status ${item.status} and is not open for a claim`,
    })
  }
  if (item.plan_version_id !== null) {
    const version = db.prepare('SELECT status FROM plan_versions WHERE id = ?')
      .get(item.plan_version_id) as { status: string }
    if (version.status !== 'ACTIVE') {
      reasons.push({
        kind: 'plan-version-not-active',
        refId: item.plan_version_id,
        message: `plan version "${item.plan_version_id}" is ${version.status}; work opens when the version is activated`,
      })
    }
  }
  if (item.phase_id !== null) {
    const phase = db.prepare('SELECT status FROM phases WHERE id = ?')
      .get(item.phase_id) as { status: string }
    if (phase.status !== 'READY' && phase.status !== 'ACTIVE') {
      reasons.push({
        kind: 'phase-not-active',
        refId: item.phase_id,
        message: `phase "${item.phase_id}" is ${phase.status}; work opens when the phase is READY or ACTIVE`,
      })
    }
  }
  const openEdges = db.prepare(
    'SELECT r.from_work_item_id AS from_id, r.relation_kind AS relation_kind, w.status AS from_status '
    + 'FROM work_item_relations r JOIN work_items w ON w.id = r.from_work_item_id '
    + 'WHERE r.to_work_item_id = ? AND r.relation_kind IN (?, ?) ORDER BY r.id',
  ).all(workItemId, 'BLOCKS', 'PRECEDES') as { from_id: string; relation_kind: string; from_status: string }[]
  for (const edge of openEdges) {
    if (edge.from_status !== 'DONE') {
      reasons.push({
        kind: 'blocking-relation-open',
        refId: edge.from_id,
        message: `${edge.relation_kind} from "${edge.from_id}" (status ${edge.from_status}) is not satisfied; `
          + 'the edge closes when the source item is DONE',
      })
    }
  }
  const openBlockers = db.prepare(
    'SELECT id, title FROM work_external_blockers WHERE work_item_id = ? AND status = ? ORDER BY id',
  ).all(workItemId, 'OPEN') as { id: string; title: string }[]
  for (const blocker of openBlockers) {
    reasons.push({
      kind: 'external-blocker-open',
      refId: blocker.id,
      message: `external blocker "${blocker.id}" (${blocker.title}) is OPEN`,
    })
  }
  const blockedCriteria = db.prepare(
    'SELECT id, status FROM acceptance_criteria '
    + "WHERE work_item_id = ? AND required = 1 AND status IN ('FAILING', 'BLOCKED') ORDER BY ordinal",
  ).all(workItemId) as { id: string; status: string }[]
  for (const criterion of blockedCriteria) {
    reasons.push({
      kind: 'acceptance-criterion-blocked',
      refId: criterion.id,
      message: `required acceptance criterion "${criterion.id}" is ${criterion.status}`,
    })
  }
  const liveLeases = db.prepare(
    'SELECT id, worker_identity, expires_at_ms FROM work_leases '
    + "WHERE work_item_id = ? AND status = 'ACTIVE' AND expires_at_ms > ? AND id != ? ORDER BY id",
  ).all(workItemId, nowMs, options.ignoreLeaseId ?? '') as { id: string; worker_identity: string; expires_at_ms: number }[]
  for (const lease of liveLeases) {
    reasons.push({
      kind: 'lease-active',
      refId: lease.id,
      message: `active lease "${lease.id}" held by ${lease.worker_identity} expires at ${lease.expires_at_ms}`,
    })
  }

  return { ready: reasons.length === 0, reasons }
}

/** The materialized parent chains and ordering relations checked for cycles. */
export interface WorkGraphCycles {
  /** Parent-composition cycles, each as the closed loop of ledger ids. */
  readonly hierarchyCycles: readonly (readonly WorkItemId[])[]
  /** Ordering-relation cycles (`BLOCKS`/`PRECEDES`/`SUPERSEDES`), each as the closed loop of ledger ids. */
  readonly orderingCycles: readonly (readonly WorkItemId[])[]
}

/**
 * Detect hierarchy and ordering-relation cycles among one project's
 * materialized work items, using the same walks as compile-time validation.
 * Compile rejects cycles it sees; this check covers rows written outside the
 * compiler (a later version's supersede flow, out-of-band writes), so a
 * claim-time or doctor pass can refuse a deadlocked graph on the same
 * semantics.
 * @param db - open ledger database.
 * @param projectId - project whose work graph is checked.
 * @returns every cycle found; empty when the project's graph is acyclic. A
 * project id with no work items is indistinguishable from an acyclic one.
 */
export function detectWorkGraphCycles(db: DatabaseSync, projectId: ProjectId): WorkGraphCycles {
  const itemRows = db.prepare(
    'SELECT id, parent_work_item_id FROM work_items WHERE project_id = ? ORDER BY id',
  ).all(projectId) as { id: string; parent_work_item_id: string | null }[]
  const projectItemIds = new Set(itemRows.map(row => row.id))
  const parentOf = new Map<string, string>()
  for (const row of itemRows) {
    if (row.parent_work_item_id !== null) {
      parentOf.set(row.id, row.parent_work_item_id)
    }
  }

  const relationRows = db.prepare(
    'SELECT from_work_item_id, to_work_item_id, relation_kind FROM work_item_relations ORDER BY id',
  ).all() as { from_work_item_id: string; to_work_item_id: string; relation_kind: string }[]
  const outgoing = new Map<string, string[]>()
  for (const row of relationRows) {
    if (!projectItemIds.has(row.from_work_item_id) || !projectItemIds.has(row.to_work_item_id)) {
      continue
    }
    if (!ORDERING_RELATION_KINDS.has(row.relation_kind)) {
      continue
    }
    const targets = outgoing.get(row.from_work_item_id) ?? []
    targets.push(row.to_work_item_id)
    outgoing.set(row.from_work_item_id, targets)
  }

  return {
    hierarchyCycles: findChainCycles(projectItemIds, parentOf)
      .map(cycle => cycle.map(id => brandString<WorkItemId>(id))),
    orderingCycles: findOrderingCycles(projectItemIds, from => outgoing.get(from) ?? [])
      .map(cycle => cycle.map(id => brandString<WorkItemId>(id))),
  }
}
