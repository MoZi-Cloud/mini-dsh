/**
 * The v1.6b approval domain (proposal "v1.6b — Owner / Decision / Resource
 * Domain", blueprint §24): approvals hang beside a typed subject reference —
 * a plan version, a work item, or a decision — in their own table, never
 * shared with decisions. {@link requestApproval} records one PENDING
 * approval atomically under an `approval/requested` event; {@link
 * decideApproval} answers one PENDING approval exactly once under an
 * `approval/decided` event, APPROVED or REJECTED, with the deciding actor's
 * note. {@link readProjectApprovals} lists the project's approvals
 * newest-first. Every write runs in one `BEGIN IMMEDIATE` transaction; the
 * approval id derives from its requesting event's timeline sequence.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/approvals
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { APPROVAL_OUTCOMES, type ApprovalDecisionOutcome, type ApprovalSubjectType } from './project-events.js'
import type { ProjectId } from './plan-compile.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one approval row (`approvals.id`). */
export type ApprovalId = Branded<'ApprovalId'>

/** Actor recorded on approval events when the caller does not name one. */
export const DEFAULT_APPROVAL_ACTOR_REF = 'dsh-experimental-project-ledger/approvals'

/** The controlled status of one approval row. */
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

/** Closed set of approval-domain rejection reasons. */
export type ApprovalErrorCode =
  | 'invalid-argument'
  | 'unknown-approval'
  | 'unknown-approval-subject'
  | 'approval-decided'

/**
 * Thrown when an approval-domain write is rejected on ledger state or input.
 * The failing transaction has already rolled back, so the rejection itself
 * never writes.
 */
export class ApprovalError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ApprovalErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: ApprovalErrorCode, message: string) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
  }
}

/** The approval {@link requestApproval} records. */
export interface RequestApprovalInput {
  /** The kind of subject the approval hangs beside. */
  readonly subjectType: ApprovalSubjectType
  /** Ledger id of the subject; it must belong to the same project. */
  readonly subjectId: string
  /** Role whose holder the decision wants deciding, when one is named. */
  readonly requiredRole?: string | undefined
  readonly requestedBy?: string | undefined
}

/** The decision {@link decideApproval} records. */
export interface DecideApprovalInput {
  readonly outcome: ApprovalDecisionOutcome
  readonly decidedBy: string
  readonly decisionText: string
}

/**
 * The deciding facts one approval carries once decided. The schema's CHECKs
 * keep them all-or-nothing with the non-PENDING status, so the read seam
 * exposes them as one group.
 */
export interface ApprovalDecision {
  readonly decidedBy: string
  readonly decisionText: string
  readonly decidedAtMs: number
}

/** Options every approval write shares. */
export interface ApprovalWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_APPROVAL_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One approval as the ledger records and {@link readProjectApprovals} lists it. */
export interface Approval {
  readonly approvalId: ApprovalId
  readonly projectId: ProjectId
  readonly subjectType: ApprovalSubjectType
  readonly subjectId: string
  readonly requiredRole: string | undefined
  readonly requestedBy: string | undefined
  readonly status: ApprovalStatus
  readonly decision: ApprovalDecision | undefined
  readonly requestedAtMs: number
}

/**
 * Read the project a subject id belongs to, by subject kind; `undefined`
 * covers both a subject this ledger does not record and one of another
 * project, which the caller rejects together.
 */
const SUBJECT_PROJECT_SQL: Record<ApprovalSubjectType, string> = {
  'plan-version': 'SELECT p.project_id AS project_id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?',
  'work-item': 'SELECT project_id FROM work_items WHERE id = ?',
  'decision': 'SELECT r.project_id AS project_id FROM decisions d '
    + 'JOIN decision_requests r ON r.id = d.decision_request_id WHERE d.id = ?',
}

/** Reject an input string that must carry content when present. */
function requireNonEmptyWhenSet(field: string, value: string | undefined): void {
  if (value !== undefined && value.length === 0) {
    throw new ApprovalError('invalid-argument', `${field} must not be empty`)
  }
}

/**
 * Request one approval: validate the inputs, then record the PENDING row and
 * one `approval/requested` event in a single `BEGIN IMMEDIATE` transaction.
 * The subject must be a plan version, work item, or decision this project
 * records.
 * @param db - open ledger database.
 * @param projectId - project the approval belongs to.
 * @param input - the typed subject reference and the requesting actor.
 * @param options - actor and clock overrides.
 * @returns the recorded approval, still PENDING.
 * @throws {ApprovalError} on `invalid-argument` and `unknown-approval-subject`.
 */
export function requestApproval(
  db: DatabaseSync,
  projectId: ProjectId,
  input: RequestApprovalInput,
  options: ApprovalWriteOptions = {},
): Approval {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_APPROVAL_ACTOR_REF
  requireNonEmptyWhenSet('subjectId', input.subjectId)
  requireNonEmptyWhenSet('requiredRole', input.requiredRole)
  requireNonEmptyWhenSet('requestedBy', input.requestedBy)
  db.exec('BEGIN IMMEDIATE')
  try {
    const subject = db.prepare(SUBJECT_PROJECT_SQL[input.subjectType])
      .get(input.subjectId) as { project_id: string } | undefined
    if (subject === undefined || subject.project_id !== projectId) {
      throw new ApprovalError(
        'unknown-approval-subject',
        `${input.subjectType} "${input.subjectId}" is not recorded for project "${projectId}"`,
      )
    }
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the approval id is its requesting event's.
    const approvalId = brandString<ApprovalId>(`ap:${projectId}:${nextProjectEventSequence(db, projectId)}`)
    appendProjectEvent(
      db,
      projectId,
      'approval/requested',
      {
        approvalId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ...(input.requiredRole === undefined ? {} : { requiredRole: input.requiredRole }),
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      },
      { entityType: 'approval', entityId: approvalId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO approvals '
      + '(id, project_id, subject_type, subject_id, required_role, requested_by, status, requested_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      approvalId,
      projectId,
      input.subjectType,
      input.subjectId,
      input.requiredRole ?? null,
      input.requestedBy ?? null,
      'PENDING',
      nowMs,
    )
    db.exec('COMMIT')
    return {
      approvalId,
      projectId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      requiredRole: input.requiredRole,
      requestedBy: input.requestedBy,
      status: 'PENDING',
      decision: undefined,
      requestedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Decide one PENDING approval: validate the inputs, then record the outcome,
 * the deciding actor's note, and one `approval/decided` event in a single
 * `BEGIN IMMEDIATE` transaction. Each approval decides exactly once.
 * @param db - open ledger database.
 * @param approvalId - the approval being decided.
 * @param input - the outcome, its author, and the deciding note.
 * @param options - actor and clock overrides.
 * @returns the decided approval.
 * @throws {ApprovalError} on `invalid-argument`, `unknown-approval`, and
 * `approval-decided`.
 */
export function decideApproval(
  db: DatabaseSync,
  approvalId: ApprovalId,
  input: DecideApprovalInput,
  options: ApprovalWriteOptions = {},
): Approval {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_APPROVAL_ACTOR_REF
  if (!APPROVAL_OUTCOMES.includes(input.outcome)) {
    throw new ApprovalError(
      'invalid-argument',
      `outcome must be one of ${APPROVAL_OUTCOMES.join(', ')}, got ${JSON.stringify(input.outcome)}`,
    )
  }
  if (input.decidedBy.length === 0) throw new ApprovalError('invalid-argument', 'decidedBy must not be empty')
  if (input.decisionText.length === 0) throw new ApprovalError('invalid-argument', 'decisionText must not be empty')
  db.exec('BEGIN IMMEDIATE')
  try {
    const approval = db.prepare(
      'SELECT id, project_id, subject_type, subject_id, required_role, requested_by, status, requested_at_ms '
      + 'FROM approvals WHERE id = ?',
    ).get(approvalId) as {
      id: string
      project_id: string
      subject_type: ApprovalSubjectType
      subject_id: string
      required_role: string | null
      requested_by: string | null
      status: ApprovalStatus
      requested_at_ms: number
    } | undefined
    if (approval === undefined) {
      throw new ApprovalError('unknown-approval', `approval "${approvalId}" is not recorded in this ledger`)
    }
    if (approval.status !== 'PENDING') {
      throw new ApprovalError(
        'approval-decided',
        `approval "${approvalId}" is already ${approval.status}; an approval decides exactly once`,
      )
    }
    const projectId = brandString<ProjectId>(approval.project_id)
    appendProjectEvent(
      db,
      projectId,
      'approval/decided',
      {
        approvalId,
        outcome: input.outcome,
        decidedBy: input.decidedBy,
        decisionText: input.decisionText,
        decidedAtMs: nowMs,
      },
      { entityType: 'approval', entityId: approvalId, actorRef, nowMs },
    )
    db.prepare(
      'UPDATE approvals SET status = ?, decision_text = ?, decided_by = ?, decided_at_ms = ? WHERE id = ?',
    ).run(input.outcome, input.decisionText, input.decidedBy, nowMs, approvalId)
    db.exec('COMMIT')
    return {
      approvalId,
      projectId,
      subjectType: approval.subject_type,
      subjectId: approval.subject_id,
      requiredRole: approval.required_role ?? undefined,
      requestedBy: approval.requested_by ?? undefined,
      status: input.outcome,
      decision: {
        decidedBy: input.decidedBy,
        decisionText: input.decisionText,
        decidedAtMs: nowMs,
      },
      requestedAtMs: approval.requested_at_ms,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One `approvals` row the read joins, in select order. */
interface ApprovalRow {
  readonly id: string
  readonly subject_type: ApprovalSubjectType
  readonly subject_id: string
  readonly required_role: string | null
  readonly requested_by: string | null
  readonly status: ApprovalStatus
  readonly decision_text: string | null
  readonly decided_by: string | null
  readonly requested_at_ms: number
  readonly decided_at_ms: number | null
}

/** Brand one read row into the public approval shape. */
function buildApprovalRow(projectId: ProjectId, row: ApprovalRow): Approval {
  return {
    approvalId: brandString<ApprovalId>(row.id),
    projectId,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    requiredRole: row.required_role ?? undefined,
    requestedBy: row.requested_by ?? undefined,
    status: row.status,
    // The schema's CHECKs keep every deciding column non-null exactly when
    // decided_by is, so the group rides on that one nullable column.
    decision: row.decided_by === null ? undefined : {
      decidedBy: row.decided_by,
      decisionText: row.decision_text as string,
      decidedAtMs: row.decided_at_ms as number,
    },
    requestedAtMs: row.requested_at_ms,
  }
}

/**
 * List one project's approvals newest-first.
 * @param db - open ledger database.
 * @param projectId - project whose approvals are listed.
 * @returns the approvals in `requested_at_ms` descending order; a project the
 * ledger records no approval for reads as empty.
 */
export function readProjectApprovals(db: DatabaseSync, projectId: ProjectId): readonly Approval[] {
  const rows = db.prepare(
    'SELECT id, subject_type, subject_id, required_role, requested_by, status, decision_text, decided_by, '
    + 'requested_at_ms, decided_at_ms FROM approvals WHERE project_id = ? ORDER BY requested_at_ms DESC, id',
  ).all(projectId) as unknown as ApprovalRow[]
  return rows.map(row => buildApprovalRow(projectId, row))
}
