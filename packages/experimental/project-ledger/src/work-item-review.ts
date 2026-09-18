/**
 * The ledger's work-item review read seam: one work item with each acceptance
 * criterion's projection status and latest recorded evaluation, so a caller
 * reports why an item passed or failed without re-running a verifier. The
 * review only reads — evaluations are written by the acceptance seam and the
 * statuses by the projection.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/work-item-review
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AcceptanceCriterionStatus, AcceptanceEvaluationResult } from './project-events.js'
import type { AcceptanceCriterionId, PlanVersionId, ProjectId, WorkItemId } from './plan-compile.js'
import type { PlanWorkItemStatus } from './plan-document.js'

/** The latest recorded evaluation of one criterion, as the review reads it. */
export interface LatestEvaluation {
  /** Recorded verdict. */
  readonly result: AcceptanceEvaluationResult
  /** Worker identity that recorded the evaluation. */
  readonly evaluatedBy: string
  /** Wall-clock stamp of the evaluation row. */
  readonly evaluatedAtMs: number
  /** Parsed `observed_json` payload of the evaluation, or `null` when none was stored. */
  readonly observed: unknown
}

/** One acceptance criterion with its projection status and latest evaluation. */
export interface ReviewedCriterion {
  /** Ledger id of the criterion. */
  readonly criterionId: AcceptanceCriterionId
  /** Verifier-facing criterion kind (`TEST`, `OWNER_CONFIRMATION`, ...). */
  readonly kind: string
  /** Human-readable criterion text. */
  readonly description: string
  /** Whether the acceptance gate requires this criterion. */
  readonly required: boolean
  /** Projection status of the criterion. */
  readonly status: AcceptanceCriterionStatus
  /** Latest recorded evaluation, or `null` while none was recorded. */
  readonly latest: LatestEvaluation | null
}

/** One work item as the review reads it: identity and state over its criteria. */
export interface WorkItemReview {
  /** Ledger id of the work item. */
  readonly workItemId: WorkItemId
  /** Plan version the item belongs to, or `null` for a backlog item. */
  readonly planVersionId: PlanVersionId | null
  /** Stable key of the item within its project. */
  readonly stableKey: string
  /** Human-readable title. */
  readonly title: string
  /** Projection status of the item. */
  readonly status: PlanWorkItemStatus
  /** Executor separation label (`AGENT`, `OWNER`, ...). */
  readonly executorKind: string
  /** Priority ordering value. */
  readonly priority: number
  /** The item's acceptance criteria in ordinal order. */
  readonly criteria: readonly ReviewedCriterion[]
}

/**
 * Read one work item's review: the item's identity and status over every
 * acceptance criterion with its latest evaluation. The ref matches the item's
 * full ledger id or its stable key within the project.
 * @param db - open ledger database.
 * @param projectId - the project the item belongs to.
 * @param itemRef - full work item id or stable key.
 * @returns the review, or `undefined` when the project records no such item.
 * @throws when the ref matches more than one item of the project.
 */
export function readWorkItemReview(
  db: DatabaseSync,
  projectId: ProjectId,
  itemRef: string,
): WorkItemReview | undefined {
  const itemRows = db.prepare(
    'SELECT id, plan_version_id, stable_key, title, status, executor_kind, priority FROM work_items '
      + 'WHERE project_id = ? AND (id = ? OR stable_key = ?) ORDER BY id',
  ).all(projectId, itemRef, itemRef) as {
    id: string
    plan_version_id: string | null
    stable_key: string
    title: string
    status: PlanWorkItemStatus
    executor_kind: string
    priority: number
  }[]
  if (itemRows.length === 0) return undefined
  const [item] = itemRows
  if (item === undefined) return undefined
  if (itemRows.length > 1) {
    throw new Error(
      `work item ref "${itemRef}" matches ${String(itemRows.length)} items of project ${projectId}; name the full id`,
    )
  }
  const criteria = db.prepare(
    'SELECT id, criterion_kind, description, required, status FROM acceptance_criteria '
      + 'WHERE work_item_id = ? ORDER BY ordinal',
  ).all(item.id) as {
    id: string
    criterion_kind: string
    description: string
    required: number
    status: AcceptanceCriterionStatus
  }[]
  // Evaluations arrive newest-first; the first row per criterion is its latest,
  // later rows for the same criterion are earlier attempts. `rowid` breaks
  // same-millisecond ties exactly (the table is append-only, so rowid order is
  // write order); the id string cannot, because its sequence number does not
  // sort numerically across digit boundaries.
  const evaluations = db.prepare(
    'SELECT criterion_id, result, observed_json, evaluated_by, evaluated_at_ms FROM acceptance_evaluations '
      + 'WHERE work_item_id = ? ORDER BY evaluated_at_ms DESC, rowid DESC',
  ).all(item.id) as {
    criterion_id: string
    result: AcceptanceEvaluationResult
    observed_json: string | null
    evaluated_by: string
    evaluated_at_ms: number
  }[]
  const latestByCriterion = new Map<string, {
    result: AcceptanceEvaluationResult
    observed_json: string | null
    evaluated_by: string
    evaluated_at_ms: number
  }>()
  for (const evaluation of evaluations) {
    if (!latestByCriterion.has(evaluation.criterion_id)) {
      latestByCriterion.set(evaluation.criterion_id, evaluation)
    }
  }
  return {
    workItemId: brandString<WorkItemId>(item.id),
    planVersionId: item.plan_version_id === null
      ? null
      : brandString<PlanVersionId>(item.plan_version_id),
    stableKey: item.stable_key,
    title: item.title,
    status: item.status,
    executorKind: item.executor_kind,
    priority: item.priority,
    criteria: criteria.map((criterion) => {
      const latest = latestByCriterion.get(criterion.id)
      return {
        criterionId: brandString<AcceptanceCriterionId>(criterion.id),
        kind: criterion.criterion_kind,
        description: criterion.description,
        required: criterion.required === 1,
        status: criterion.status,
        latest: latest === undefined ? null : {
          result: latest.result,
          evaluatedBy: latest.evaluated_by,
          evaluatedAtMs: latest.evaluated_at_ms,
          observed: latest.observed_json === null ? null : JSON.parse(latest.observed_json) as unknown,
        },
      }
    }),
  }
}
