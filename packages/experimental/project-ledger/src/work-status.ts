/**
 * Generic work-item status transitions (v1.6a §5/§15/§16): the one writer for
 * `work/status-changed` events, mutating `work_items.status` and appending the
 * event inside one `BEGIN IMMEDIATE` transaction per the §15 concept order.
 * Transitions owned by a dedicated vocabulary event are refused here: a claim
 * moves an item to `IN_PROGRESS` under a `work/claimed` event, and the
 * `BLOCKED`/`READY` pair is the readiness projection's to write through
 * `work/blocked`/`work/unblocked`. The allowed-transition table is closed, so
 * every other change either follows this table or belongs to an event that
 * does not exist yet.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/work-status
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectId, WorkItemId } from './plan-compile.js'
import type { PlanWorkItemStatus } from './plan-document.js'
import { appendProjectEvent, type AcceptanceCriterionStatus } from './project-events.js'

/**
 * The closed transition table for {@link changeWorkStatus}. Statuses a
 * dedicated vocabulary event owns (`IN_PROGRESS` via claim, `BLOCKED`/`READY`
 * via the blocker projection) are absent from every target list; terminal
 * statuses list no targets.
 */
export const WORK_STATUS_TRANSITIONS: Readonly<Record<PlanWorkItemStatus, readonly PlanWorkItemStatus[]>> = {
  PROPOSED: ['READY', 'CANCELLED'],
  READY: ['CANCELLED'],
  BLOCKED: ['CANCELLED'],
  IN_PROGRESS: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['DONE', 'FAILED'],
  FAILED: ['READY', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
  SUPERSEDED: [],
}

/** Actor recorded on status-change events when the caller does not name one. */
export const DEFAULT_STATUS_ACTOR_REF = 'dsh-experimental-project-ledger/work-status'

/** Closed set of status-transition rejection reasons. */
export type WorkStatusErrorCode = 'unknown-work-item' | 'transition-not-allowed' | 'acceptance-not-passed'

/**
 * Thrown when a status change is rejected on ledger state. The failing
 * transaction has already rolled back, so the rejection itself never writes.
 */
export class WorkStatusError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: WorkStatusErrorCode

  /** @param code - why the transition was rejected. @param message - the concrete reason. */
  constructor(code: WorkStatusErrorCode, message: string) {
    super(message)
    this.name = 'WorkStatusError'
    this.code = code
  }
}

/** Options for {@link changeWorkStatus}. */
export interface ChangeWorkStatusOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_STATUS_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the row and the event; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Outcome of one {@link changeWorkStatus} call. */
export interface WorkStatusChange {
  readonly workItemId: WorkItemId
  readonly fromStatus: PlanWorkItemStatus
  readonly toStatus: PlanWorkItemStatus
  /** The appended event's position in the project's timeline. */
  readonly sequenceNo: number
  /** Wall-clock stamp written to the row and the event. */
  readonly createdAtMs: number
}

/**
 * Move one work item to a new status and record the `work/status-changed`
 * event atomically. Re-presenting the current status is a rejection, not a
 * no-op: a no-op write would append an event without a transition. Completion
 * carries one extra gate beyond the table: every required acceptance
 * criterion must be `PASSING` or `WAIVED` (§5.3 — acceptance is the only
 * authority that completes project work).
 * @param db - open ledger database.
 * @param workItemId - the work item to transition.
 * @param toStatus - the target status, outside the dedicated-event transitions.
 * @param options - actor and clock overrides.
 * @returns the recorded transition with its event sequence.
 * @throws {WorkStatusError} on `unknown-work-item`, `transition-not-allowed`, and `acceptance-not-passed`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function changeWorkStatus(
  db: DatabaseSync,
  workItemId: WorkItemId,
  toStatus: PlanWorkItemStatus,
  options: ChangeWorkStatusOptions = {},
): WorkStatusChange {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_STATUS_ACTOR_REF
  db.exec('BEGIN IMMEDIATE')
  try {
    const item = db.prepare('SELECT project_id, status FROM work_items WHERE id = ?')
      .get(workItemId) as { project_id: string; status: PlanWorkItemStatus } | undefined
    if (item === undefined) {
      throw new WorkStatusError(
        'unknown-work-item',
        `work item "${workItemId}" is not recorded in this ledger`,
      )
    }
    if (item.status === toStatus) {
      throw new WorkStatusError(
        'transition-not-allowed',
        `work item "${workItemId}" already has status ${toStatus}`,
      )
    }
    const allowed = WORK_STATUS_TRANSITIONS[item.status]
    if (!allowed.includes(toStatus)) {
      const reachable = allowed.length === 0
        ? 'nothing; the status is terminal'
        : allowed.join(', ')
      throw new WorkStatusError(
        'transition-not-allowed',
        `work item "${workItemId}" cannot change status from ${item.status} to ${toStatus} `
          + `(allowed from ${item.status}: ${reachable})`,
      )
    }
    if (toStatus === 'DONE') {
      // Completion authority (§5.3): only passed or waived acceptance
      // completes a work item — an unevaluated or failing required criterion
      // holds it in VERIFYING no matter who calls.
      const outstanding = db.prepare(
        'SELECT id, status FROM acceptance_criteria '
        + "WHERE work_item_id = ? AND required = 1 AND status NOT IN ('PASSING', 'WAIVED') ORDER BY ordinal",
      ).all(workItemId) as { id: string; status: AcceptanceCriterionStatus }[]
      if (outstanding.length > 0) {
        throw new WorkStatusError(
          'acceptance-not-passed',
          `work item "${workItemId}" cannot complete while required acceptance is outstanding: `
            + outstanding.map(criterion => `"${criterion.id}" is ${criterion.status}`).join('; '),
        )
      }
    }
    db.prepare('UPDATE work_items SET status = ?, updated_at_ms = ? WHERE id = ?')
      .run(toStatus, nowMs, workItemId)
    const envelope = appendProjectEvent(
      db,
      // The project id crossed the durable work_items row boundary.
      brandString<ProjectId>(item.project_id),
      'work/status-changed',
      { workItemId, fromStatus: item.status, toStatus },
      { entityType: 'work_item', entityId: workItemId, actorRef, nowMs },
    )
    db.exec('COMMIT')
    return {
      workItemId,
      fromStatus: item.status,
      toStatus,
      sequenceNo: envelope.sequenceNo,
      createdAtMs: envelope.createdAtMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}
