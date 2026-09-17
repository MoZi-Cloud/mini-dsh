/**
 * Acceptance evaluation storage (v1.6a F06, attachment §8-§10): append one
 * caller-reported evaluation to `acceptance_evaluations`, move the criterion's
 * projection status, and record the `acceptance/evaluated` event inside one
 * `BEGIN IMMEDIATE` transaction per the §15 concept order. Evaluations are
 * append-only history; the criterion row's status is the projection. This
 * module never executes a verifier: `command_text` and its siblings are stored
 * data, and the result is whatever the caller reports.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/acceptance
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AcceptanceCriterionId, ProjectId, WorkItemId } from './plan-compile.js'
import {
  type AcceptanceCriterionStatus,
  type AcceptanceEvaluationResult,
  appendProjectEvent,
} from './project-events.js'

/** Identity of one append-only evaluation row (`acceptance_evaluations.id`). */
export type AcceptanceEvaluationId = Branded<'AcceptanceEvaluationId'>

/** Actor recorded on evaluations when the caller does not name one. */
export const DEFAULT_EVALUATION_ACTOR_REF = 'dsh-experimental-project-ledger/acceptance'

/**
 * The projection status each evaluation result produces. `ERROR` records
 * history without moving the projection: the verifier could not produce a
 * verdict, so the criterion keeps its current status.
 */
const RESULT_TO_STATUS: Readonly<Record<AcceptanceEvaluationResult, AcceptanceCriterionStatus | undefined>> = {
  PASS: 'PASSING',
  FAIL: 'FAILING',
  BLOCKED: 'BLOCKED',
  ERROR: undefined,
  WAIVED: 'WAIVED',
}

/** Closed set of evaluation rejection reasons. */
export type AcceptanceEvaluationErrorCode = 'unknown-criterion'

/**
 * Thrown when an evaluation is rejected on ledger state. The failing
 * transaction has already rolled back, so the rejection itself never writes.
 */
export class AcceptanceEvaluationError extends Error {
  readonly code: AcceptanceEvaluationErrorCode

  /** @param code - why the evaluation was rejected. @param message - the concrete reason. */
  constructor(code: AcceptanceEvaluationErrorCode, message: string) {
    super(message)
    this.name = 'AcceptanceEvaluationError'
    this.code = code
  }
}

/** Options for {@link evaluateAcceptanceCriterion}. */
export interface EvaluateAcceptanceCriterionOptions {
  /** Attempt the evaluation belongs to, when one exists. */
  readonly attemptRef?: string | undefined
  /** Repository head the evaluation observed. */
  readonly repoHead?: string | undefined
  /** Worktree hash the evaluation observed. */
  readonly worktreeHash?: string | undefined
  /** Structured observation recorded in `observed_json`; JSON-serializable. */
  readonly observed?: unknown
  /** Caller-local reference to the verification run, when one exists. */
  readonly verificationRef?: string | undefined
  /** Evaluator identity recorded in `evaluated_by`; defaults to {@link DEFAULT_EVALUATION_ACTOR_REF}. */
  readonly evaluatedBy?: string | undefined
  /** Wall-clock stamp for the rows and the event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Outcome of one {@link evaluateAcceptanceCriterion} call. */
export interface AcceptanceEvaluation {
  readonly evaluationId: AcceptanceEvaluationId
  readonly criterionId: AcceptanceCriterionId
  readonly workItemId: WorkItemId
  /** The criterion's status before this evaluation. */
  readonly fromStatus: AcceptanceCriterionStatus
  /** The criterion's status after this evaluation. */
  readonly status: AcceptanceCriterionStatus
  readonly result: AcceptanceEvaluationResult
  /** The appended event's position in the project's timeline. */
  readonly sequenceNo: number
  readonly evaluatedAtMs: number
}

/**
 * Record one evaluation of an acceptance criterion: the append-only history
 * row, the criterion's projection status, and the `acceptance/evaluated`
 * event, atomically. The result is caller-reported — nothing here runs a
 * verifier command, query, or confirmation (§9). An `ERROR` result keeps the
 * criterion's current status: history without a projection move.
 * @param db - open ledger database.
 * @param criterionId - the criterion being evaluated.
 * @param result - the outcome the caller reports.
 * @param options - observation facts, evaluator identity, and clock overrides.
 * @returns the recorded evaluation with its event sequence.
 * @throws {AcceptanceEvaluationError} on `unknown-criterion`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function evaluateAcceptanceCriterion(
  db: DatabaseSync,
  criterionId: AcceptanceCriterionId,
  result: AcceptanceEvaluationResult,
  options: EvaluateAcceptanceCriterionOptions = {},
): AcceptanceEvaluation {
  const nowMs = options.nowMs ?? Date.now()
  const evaluatedBy = options.evaluatedBy ?? DEFAULT_EVALUATION_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const criterion = db.prepare(
      'SELECT c.work_item_id AS work_item_id, c.status AS status, w.project_id AS project_id '
      + 'FROM acceptance_criteria c JOIN work_items w ON w.id = c.work_item_id WHERE c.id = ?',
    ).get(criterionId) as
      | { work_item_id: string; status: AcceptanceCriterionStatus; project_id: string }
      | undefined
    if (criterion === undefined) {
      throw new AcceptanceEvaluationError(
        'unknown-criterion',
        `acceptance criterion "${criterionId}" is not recorded in this ledger`,
      )
    }
    const status = RESULT_TO_STATUS[result] ?? criterion.status
    const envelope = appendProjectEvent(
      db,
      // The project id crossed the durable acceptance_criteria join boundary.
      brandString<ProjectId>(criterion.project_id),
      'acceptance/evaluated',
      { workItemId: criterion.work_item_id, criterionId, result, status },
      { entityType: 'acceptance_criterion', entityId: criterionId, actorRef: evaluatedBy, nowMs },
    )
    const evaluationId = brandString<AcceptanceEvaluationId>(`ev:${criterionId}:${envelope.sequenceNo}`)
    db.prepare(
      'INSERT INTO acceptance_evaluations '
      + '(id, criterion_id, work_item_id, attempt_ref, repo_head, worktree_hash, result, observed_json, '
      + 'verification_ref, evaluated_by, evaluated_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      evaluationId,
      criterionId,
      criterion.work_item_id,
      options.attemptRef ?? null,
      options.repoHead ?? null,
      options.worktreeHash ?? null,
      result,
      options.observed === undefined ? null : JSON.stringify(options.observed),
      options.verificationRef ?? null,
      evaluatedBy,
      nowMs,
    )
    db.prepare('UPDATE acceptance_criteria SET status = ? WHERE id = ?').run(status, criterionId)
    db.exec('COMMIT')
    return {
      evaluationId,
      criterionId,
      workItemId: brandString<WorkItemId>(criterion.work_item_id),
      fromStatus: criterion.status,
      status,
      result,
      sequenceNo: envelope.sequenceNo,
      evaluatedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}
