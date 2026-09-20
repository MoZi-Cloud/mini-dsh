/**
 * Owner and Agent todo views (v1.6a §11, BOOT-03): the two read-only work
 * lists the `/project todo --owner` and `/project todo --agent` surfaces
 * project, separated by `executor_kind` exactly as the constitution defines
 * them. A view entry carries the display facts plus the recomputed readiness
 * and the live lease, so a consumer sees why work is blocked and who holds
 * it without a second query surface. A view may also name a viewing worker
 * identity: per-actor claim visibility (v1.6d) drops the entries another
 * identity holds a live claim on, so a second agent sees the queue without
 * another agent's live claims. Queries never mutate: status moves,
 * claims, and evaluations stay with their owning writers, and completing a
 * project work item remains reachable only through the acceptance seam
 * (`todo completed != project work item done`, §5.3).
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/todo-views
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkLeaseId } from './lease.js'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import type { PlanExecutorKind, PlanWorkItemStatus } from './plan-document.js'
import { PLAN_EXECUTOR_KINDS } from './plan-schema.js'
import { computeWorkReadiness, type WorkReadiness } from './work-readiness.js'

/**
 * Statuses a todo view lists. Terminal and superseded statuses never appear:
 * a todo answers "what is outstanding", and finished or abandoned work is
 * history, not a task.
 */
export const TODO_VIEW_STATUSES = [
  'PROPOSED',
  'READY',
  'BLOCKED',
  'IN_PROGRESS',
  'VERIFYING',
] as const

/** The executor kinds the owner todo view lists (§11). */
export const OWNER_TODO_EXECUTOR_KINDS = ['OWNER'] as const satisfies readonly PlanExecutorKind[]

/** The executor kinds the agent todo view lists (§11). */
export const AGENT_TODO_EXECUTOR_KINDS = ['AGENT'] as const satisfies readonly PlanExecutorKind[]

/** Closed set of todo-view rejection reasons. */
export type WorkTodoErrorCode = 'empty-executor-kinds' | 'empty-viewer-identity'

/** Thrown by the todo-view resolve step; queries themselves only read. */
export class WorkTodoError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: WorkTodoErrorCode

  /** @param code - why the request was rejected. @param message - the concrete reason. */
  constructor(code: WorkTodoErrorCode, message: string) {
    super(message)
    this.name = 'WorkTodoError'
    this.code = code
  }
}

/** A todo-view request as the caller states it. */
export interface WorkTodoRequest {
  /** Executor kinds the view lists; defaults to every kind. */
  readonly executorKinds?: readonly PlanExecutorKind[] | undefined
  /**
   * Worker identity whose live claims stay listed: entries another identity
   * holds drop out of the view; unclaimed entries and the viewer's own stay.
   * Absent lists every entry.
   */
  readonly viewerIdentity?: string | undefined
  /** Now, for the lease-expiry comparison; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** A todo-view request resolved into its executable form. */
export interface WorkTodoSpec {
  /** Executor kinds the view lists, de-duplicated and sorted for a stable query order. */
  readonly executorKinds: readonly PlanExecutorKind[]
  /** The viewing worker identity, when the caller named one. */
  readonly viewerIdentity: string | undefined
  readonly nowMs: number
}

/**
 * Resolve a todo-view request into its spec: default the kind list to every
 * executor kind, de-duplicate and sort what the caller named (the sort fixes
 * the row order and the echoed `executorKinds`), default the clock, and carry
 * the viewer identity. An explicitly empty filter fails loud instead of
 * silently listing nothing; so does an empty viewer identity, which is a
 * caller mistake, not a request for the unfiltered view.
 * @param request - the caller's kind filter, viewer identity, and clock override.
 * @returns the resolved spec.
 * @throws {WorkTodoError} on `empty-executor-kinds` and `empty-viewer-identity`.
 */
export function resolveWorkTodoSpec(request: WorkTodoRequest = {}): WorkTodoSpec {
  const requested = request.executorKinds === undefined ? PLAN_EXECUTOR_KINDS : request.executorKinds
  const executorKinds = [...new Set(requested)].sort()
  if (executorKinds.length === 0) {
    throw new WorkTodoError(
      'empty-executor-kinds',
      'executorKinds must name at least one executor kind; an empty filter would list nothing',
    )
  }
  if (request.viewerIdentity !== undefined && request.viewerIdentity.length === 0) {
    throw new WorkTodoError(
      'empty-viewer-identity',
      'viewerIdentity must name the viewing worker; an empty string is not a worker identity',
    )
  }
  return { executorKinds, viewerIdentity: request.viewerIdentity, nowMs: request.nowMs ?? Date.now() }
}

/** The live lease holding one listed work item, when one exists. */
export interface WorkTodoLeaseRef {
  readonly leaseId: WorkLeaseId
  readonly workerIdentity: string
  readonly expiresAtMs: number
}

/** One work item as a todo view lists it. */
export interface WorkTodoEntry {
  readonly workItemId: WorkItemId
  readonly stableKey: string
  readonly title: string
  readonly executorKind: PlanExecutorKind
  readonly status: PlanWorkItemStatus
  readonly priority: number
  /** Stable key of the parent phase; an unphased item records `null`. */
  readonly phaseStableKey: string | null
  /** The recomputed claimability with every blocker — never the materialized status alone. */
  readonly readiness: WorkReadiness
  readonly activeLease: WorkTodoLeaseRef | null
}

/** A todo view: the resolved filter echoed with the entries it selected. */
export interface WorkTodoView {
  readonly projectId: ProjectId
  readonly executorKinds: readonly PlanExecutorKind[]
  /** The viewing worker identity, when the caller named one. */
  readonly viewerIdentity: string | undefined
  readonly entries: readonly WorkTodoEntry[]
}

/**
 * List one project's outstanding work for the requested executor kinds.
 * Entries cover the non-terminal statuses, ordered by executor kind,
 * descending priority, then age and id for a stable display; each carries
 * its recomputed readiness and live lease. With a viewer identity, the
 * entries another identity holds a live claim on drop out — per-actor claim
 * visibility — while unclaimed entries and the viewer's own stay listed.
 * The query only reads — no view path moves a status or records an event.
 * @param db - open ledger database.
 * @param projectId - project whose work is listed.
 * @param request - kind filter, viewer identity, and clock override.
 * @returns the resolved view.
 * @throws {WorkTodoError} the {@link resolveWorkTodoSpec} rejections.
 */
export function listWorkTodo(
  db: DatabaseSync,
  projectId: ProjectId,
  request: WorkTodoRequest = {},
): WorkTodoView {
  const spec = resolveWorkTodoSpec(request)
  // The mark strings carry only `?` placeholders derived from array lengths.
  const kindMarks = spec.executorKinds.map(() => '?').join(', ')
  const statusMarks = TODO_VIEW_STATUSES.map(() => '?').join(', ')
  const rows = db.prepare(
    'SELECT w.id AS id, w.stable_key AS stable_key, w.title AS title, w.executor_kind AS executor_kind, '
    + 'w.status AS status, w.priority AS priority, p.stable_key AS phase_stable_key '
    + 'FROM work_items w LEFT JOIN phases p ON p.id = w.phase_id '
    + `WHERE w.project_id = ? AND w.executor_kind IN (${kindMarks}) AND w.status IN (${statusMarks}) `
    + 'ORDER BY w.executor_kind, w.priority DESC, w.created_at_ms, w.id',
  ).all(projectId, ...spec.executorKinds, ...TODO_VIEW_STATUSES) as {
    id: string
    stable_key: string
    title: string
    executor_kind: PlanExecutorKind
    status: PlanWorkItemStatus
    priority: number
    phase_stable_key: string | null
  }[]
  const entries: WorkTodoEntry[] = []
  for (const row of rows) {
    const workItemId = brandString<WorkItemId>(row.id)
    const lease = db.prepare(
      'SELECT id, worker_identity, expires_at_ms FROM work_leases '
      + "WHERE work_item_id = ? AND status = 'ACTIVE' AND expires_at_ms > ? ORDER BY id LIMIT 1",
    ).get(workItemId, spec.nowMs) as
      | { id: string; worker_identity: string; expires_at_ms: number }
      | undefined
    // Per-actor claim visibility: a named viewer sees another holder's live
    // claim neither as available nor as an entry, so no second agent plans
    // around work another agent already holds.
    if (
      spec.viewerIdentity !== undefined
      && lease !== undefined
      && lease.worker_identity !== spec.viewerIdentity
    ) {
      continue
    }
    entries.push({
      workItemId,
      stableKey: row.stable_key,
      title: row.title,
      executorKind: row.executor_kind,
      status: row.status,
      priority: row.priority,
      phaseStableKey: row.phase_stable_key,
      readiness: computeWorkReadiness(db, workItemId, { nowMs: spec.nowMs }),
      activeLease: lease === undefined ? null : {
        leaseId: brandString<WorkLeaseId>(lease.id),
        workerIdentity: lease.worker_identity,
        expiresAtMs: lease.expires_at_ms,
      },
    })
  }
  return { projectId, executorKinds: spec.executorKinds, viewerIdentity: spec.viewerIdentity, entries }
}

/**
 * The owner todo view (§11): one project's outstanding `OWNER` work, the
 * query `/project todo --owner` projects.
 * @param db - open ledger database.
 * @param projectId - project whose owner work is listed.
 * @param request - clock override; the kind filter is fixed to {@link OWNER_TODO_EXECUTOR_KINDS}.
 * @returns the resolved owner view.
 */
export function listOwnerTodo(
  db: DatabaseSync,
  projectId: ProjectId,
  request: Omit<WorkTodoRequest, 'executorKinds'> = {},
): WorkTodoView {
  return listWorkTodo(db, projectId, { ...request, executorKinds: OWNER_TODO_EXECUTOR_KINDS })
}

/**
 * The agent todo view (§11): one project's outstanding `AGENT` work, the
 * query `/project todo --agent` projects. With a viewer identity the view is
 * the calling agent's per-actor queue: entries another agent holds a live
 * claim on drop out (v1.6d).
 * @param db - open ledger database.
 * @param projectId - project whose agent work is listed.
 * @param request - clock and viewer overrides; the kind filter is fixed to {@link AGENT_TODO_EXECUTOR_KINDS}.
 * @returns the resolved agent view.
 */
export function listAgentTodo(
  db: DatabaseSync,
  projectId: ProjectId,
  request: Omit<WorkTodoRequest, 'executorKinds'> = {},
): WorkTodoView {
  return listWorkTodo(db, projectId, { ...request, executorKinds: AGENT_TODO_EXECUTOR_KINDS })
}
