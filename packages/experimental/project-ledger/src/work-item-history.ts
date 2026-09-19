/**
 * The ledger's work-item history read seam: one work item's every recorded
 * evaluation, newest first, so a caller reads the full attempt timeline — the
 * earlier attempts the review's latest-only view collapses away. The history
 * only reads — evaluations are written by the acceptance seam, and no verdict
 * here is a gate.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/work-item-history
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AcceptanceEvaluationId } from './acceptance.js'
import type { AcceptanceCriterionId, ProjectId } from './plan-compile.js'
import type { AcceptanceEvaluationResult } from './project-events.js'
import { resolveWorkItemRow, workItemIdentityOf, type WorkItemIdentity } from './work-item-review.js'

/** One recorded evaluation attempt, as the history reads it. */
export interface HistoryEvaluation {
  /** Ledger id of the evaluation row. */
  readonly evaluationId: AcceptanceEvaluationId
  /** Ledger id of the criterion the attempt evaluated. */
  readonly criterionId: AcceptanceCriterionId
  /** Verifier-facing criterion kind (`TEST`, `OWNER_CONFIRMATION`, ...). */
  readonly kind: string
  /** Recorded verdict. */
  readonly result: AcceptanceEvaluationResult
  /** Worker identity that recorded the evaluation. */
  readonly evaluatedBy: string
  /** Wall-clock stamp of the evaluation row. */
  readonly evaluatedAtMs: number
  /** Parsed `observed_json` payload of the evaluation, or `null` when none was stored. */
  readonly observed: unknown
}

/** One work item as the history reads it: identity over its evaluation timeline. */
export interface WorkItemHistory extends WorkItemIdentity {
  /** Every recorded evaluation of the item, newest first. */
  readonly evaluations: readonly HistoryEvaluation[]
}

/**
 * Read one work item's evaluation history: the item's identity and every
 * recorded evaluation, newest first. The ref matches the item's full ledger id
 * or its stable key within the project.
 * @param db - open ledger database.
 * @param projectId - the project the item belongs to.
 * @param itemRef - full work item id or stable key.
 * @returns the history, or `undefined` when the project records no such item.
 * @throws when the ref matches more than one item of the project.
 */
export function readWorkItemHistory(
  db: DatabaseSync,
  projectId: ProjectId,
  itemRef: string,
): WorkItemHistory | undefined {
  const item = resolveWorkItemRow(db, projectId, itemRef)
  if (item === undefined) return undefined
  const evaluations = db.prepare(
    'SELECT e.id, e.criterion_id, c.criterion_kind, e.result, e.observed_json, e.evaluated_by, e.evaluated_at_ms '
      + 'FROM acceptance_evaluations e JOIN acceptance_criteria c ON c.id = e.criterion_id '
      + 'WHERE e.work_item_id = ? ORDER BY e.evaluated_at_ms DESC, e.rowid DESC',
  ).all(item.id) as unknown as {
    id: string
    criterion_id: string
    criterion_kind: string
    result: AcceptanceEvaluationResult
    observed_json: string | null
    evaluated_by: string
    evaluated_at_ms: number
  }[]
  return {
    ...workItemIdentityOf(item),
    evaluations: evaluations.map(evaluation => ({
      evaluationId: brandString<AcceptanceEvaluationId>(evaluation.id),
      criterionId: brandString<AcceptanceCriterionId>(evaluation.criterion_id),
      kind: evaluation.criterion_kind,
      result: evaluation.result,
      evaluatedBy: evaluation.evaluated_by,
      evaluatedAtMs: evaluation.evaluated_at_ms,
      observed: evaluation.observed_json === null ? null : JSON.parse(evaluation.observed_json) as unknown,
    })),
  }
}
