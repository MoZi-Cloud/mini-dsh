/**
 * The v1.6b decision domain (proposal "v1.6b — Owner / Decision / Resource
 * Domain"): owner decision requests with their enumerated options, and the
 * one decision that resolves each. {@link openDecisionRequest} records a
 * request and its options atomically under a `decision/requested` event;
 * {@link recordDecision} resolves one OPEN request exactly once under a
 * `decision/recorded` event, naming one of the request's own options when
 * the decision selected one. {@link readProjectDecisions} lists the project's
 * requests with their options and resolving decision newest-first. Every
 * write runs in one `BEGIN IMMEDIATE` transaction; ids derive from identity
 * (`dr:<projectId>:<decisionKey>`, `do:<requestId>:<optionKey>`) except the
 * decision id, which derives from its event's timeline sequence.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/decisions
 */

import { DatabaseSync } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { DECISION_BLOCKING_LEVELS, type DecisionBlockingLevel } from './project-events.js'
import type { PlanVersionId, ProjectId } from './plan-compile.js'
import { appendProjectEvent, nextProjectEventSequence } from './project-events.js'

/** Identity of one decision request row (`decision_requests.id`). */
export type DecisionRequestId = Branded<'DecisionRequestId'>

/** Identity of one decision row (`decisions.id`). */
export type DecisionId = Branded<'DecisionId'>

/** Actor recorded on decision events when the caller does not name one. */
export const DEFAULT_DECISION_ACTOR_REF = 'dsh-experimental-project-ledger/decisions'

/** The controlled status of one decision request row. */
export type DecisionRequestStatus = 'OPEN' | 'RESOLVED'

/** Closed set of decision-domain rejection reasons. */
export type DecisionErrorCode =
  | 'invalid-argument'
  | 'duplicate-decision-key'
  | 'unknown-plan-version'
  | 'unknown-decision-request'
  | 'decision-request-resolved'
  | 'unknown-decision-option'

/**
 * Thrown when a decision-domain write is rejected on ledger state or input.
 * The failing transaction has already rolled back, so the rejection itself
 * never writes.
 */
export class DecisionError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: DecisionErrorCode

  /** @param code - why the write was rejected. @param message - the concrete reason. */
  constructor(code: DecisionErrorCode, message: string) {
    super(message)
    this.name = 'DecisionError'
    this.code = code
  }
}

/** One option a decision request is opened with, as the caller supplies it. */
export interface DecisionOptionInput {
  readonly optionKey: string
  readonly label: string
  readonly description?: string | undefined
  readonly recommended?: boolean | undefined
}

/** One option as the ledger records it. */
export interface DecisionOption {
  readonly optionId: string
  readonly optionKey: string
  readonly label: string
  readonly description: string | undefined
  readonly recommended: boolean
  readonly ordinal: number
}

/** The request {@link openDecisionRequest} records. */
export interface OpenDecisionRequestInput {
  readonly decisionKey: string
  readonly title: string
  readonly question: string
  readonly context?: string | undefined
  readonly blockingLevel: DecisionBlockingLevel
  /** The plan version the decision is about, when it names one; must belong to the same project. */
  readonly planVersionId?: PlanVersionId | undefined
  readonly raisedBy?: string | undefined
  readonly options?: readonly DecisionOptionInput[] | undefined
}

/** The decision {@link recordDecision} records. */
export interface RecordDecisionInput {
  readonly decidedBy: string
  /** One of the request's own option keys, when the decision selected an option. */
  readonly selectedOptionKey?: string | undefined
  readonly decisionText: string
  readonly rationale?: string | undefined
}

/** Options every decision write shares. */
export interface DecisionWriteOptions {
  /** Actor recorded on the event; defaults to {@link DEFAULT_DECISION_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for the rows and events; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** One recorded decision, with the selected option resolved to its key. */
export interface RecordedDecision {
  readonly decisionId: DecisionId
  readonly requestId: DecisionRequestId
  readonly decidedBy: string
  readonly selectedOptionId: string | undefined
  readonly selectedOptionKey: string | undefined
  readonly decisionText: string
  readonly rationale: string | undefined
  readonly decidedAtMs: number
}

/** One decision request as {@link readProjectDecisions} lists it. */
export interface DecisionRequest {
  readonly requestId: DecisionRequestId
  readonly projectId: ProjectId
  readonly planVersionId: PlanVersionId | undefined
  readonly decisionKey: string
  readonly title: string
  readonly question: string
  readonly context: string | undefined
  readonly blockingLevel: DecisionBlockingLevel
  readonly status: DecisionRequestStatus
  readonly raisedBy: string | undefined
  readonly createdAtMs: number
  readonly resolvedAtMs: number | undefined
  readonly options: readonly DecisionOption[]
  readonly decision: RecordedDecision | undefined
}

/** One flat read row joining a request with its options and resolving decision. */
interface DecisionJoinRow {
  readonly id: string
  readonly plan_version_id: string | null
  readonly decision_key: string
  readonly title: string
  readonly question: string
  readonly context: string | null
  readonly blocking_level: DecisionBlockingLevel
  readonly status: DecisionRequestStatus
  readonly raised_by: string | null
  readonly created_at_ms: number
  readonly resolved_at_ms: number | null
  readonly option_id: string | null
  readonly option_key: string | null
  readonly option_label: string | null
  readonly option_description: string | null
  readonly option_recommended: number | null
  readonly option_ordinal: number | null
  readonly decision_id: string | null
  readonly decided_by: string | null
  readonly selected_option_id: string | null
  readonly decision_text: string | null
  readonly rationale: string | null
  readonly decided_at_ms: number | null
}

/** Reject an input string that must carry content. */
function requireNonEmpty(field: string, value: string): void {
  if (value.length === 0) {
    throw new DecisionError('invalid-argument', `${field} must not be empty`)
  }
}

/** Resolve the minted id of one request option. */
function optionIdOf(requestId: DecisionRequestId, optionKey: string): string {
  return `do:${requestId}:${optionKey}`
}

/**
 * Open one decision request: validate the inputs, then record the request,
 * its options, and one `decision/requested` event in a single `BEGIN
 * IMMEDIATE` transaction. Option ordinals follow input order; at most one
 * option may carry `recommended`.
 * @param db - open ledger database.
 * @param projectId - project the decision belongs to.
 * @param input - the request's identity, question, and options.
 * @param options - actor and clock overrides.
 * @returns the recorded request with its options; no decision resolves it yet.
 * @throws {DecisionError} on `invalid-argument`, `duplicate-decision-key`, and
 * `unknown-plan-version`.
 */
export function openDecisionRequest(
  db: DatabaseSync,
  projectId: ProjectId,
  input: OpenDecisionRequestInput,
  options: DecisionWriteOptions = {},
): DecisionRequest {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_DECISION_ACTOR_REF
  requireNonEmpty('decisionKey', input.decisionKey)
  requireNonEmpty('title', input.title)
  requireNonEmpty('question', input.question)
  if (!DECISION_BLOCKING_LEVELS.includes(input.blockingLevel)) {
    throw new DecisionError(
      'invalid-argument',
      `blockingLevel must be one of ${DECISION_BLOCKING_LEVELS.join(', ')}, got ${JSON.stringify(input.blockingLevel)}`,
    )
  }
  const optionInputs = input.options ?? []
  const seenOptionKeys = new Set<string>()
  let recommendedCount = 0
  for (const option of optionInputs) {
    requireNonEmpty(`option ${input.decisionKey} optionKey`, option.optionKey)
    requireNonEmpty(`option ${option.optionKey} label`, option.label)
    if (seenOptionKeys.has(option.optionKey)) {
      throw new DecisionError(
        'invalid-argument',
        `option keys must be unique within one decision request; "${option.optionKey}" repeats`,
      )
    }
    seenOptionKeys.add(option.optionKey)
    if (option.recommended === true) recommendedCount += 1
  }
  if (recommendedCount > 1) {
    throw new DecisionError('invalid-argument', 'at most one option may be recommended')
  }
  const requestId = brandString<DecisionRequestId>(`dr:${projectId}:${input.decisionKey}`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const duplicate = db.prepare('SELECT id FROM decision_requests WHERE project_id = ? AND decision_key = ?')
      .get(projectId, input.decisionKey) as { id: string } | undefined
    if (duplicate !== undefined) {
      throw new DecisionError(
        'duplicate-decision-key',
        `decision key "${input.decisionKey}" is already recorded in project "${projectId}" (${duplicate.id})`,
      )
    }
    if (input.planVersionId !== undefined) {
      const versionProject = db.prepare(
        'SELECT p.project_id AS project_id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?',
      ).get(input.planVersionId) as { project_id: string } | undefined
      if (versionProject === undefined || versionProject.project_id !== projectId) {
        throw new DecisionError(
          'unknown-plan-version',
          `plan version "${input.planVersionId}" is not recorded for project "${projectId}"`,
        )
      }
    }
    const optionRows: DecisionOption[] = optionInputs.map((option, ordinal) => ({
      optionId: optionIdOf(requestId, option.optionKey),
      optionKey: option.optionKey,
      label: option.label,
      description: option.description,
      recommended: option.recommended === true,
      ordinal,
    }))
    appendProjectEvent(
      db,
      projectId,
      'decision/requested',
      {
        requestId,
        decisionKey: input.decisionKey,
        title: input.title,
        question: input.question,
        ...(input.context === undefined ? {} : { context: input.context }),
        blockingLevel: input.blockingLevel,
        ...(input.raisedBy === undefined ? {} : { raisedBy: input.raisedBy }),
        ...(input.planVersionId === undefined ? {} : { planVersionId: input.planVersionId }),
        options: optionRows.map(option => ({
          optionKey: option.optionKey,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
          recommended: option.recommended,
          ordinal: option.ordinal,
        })),
      },
      { entityType: 'decision_request', entityId: requestId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO decision_requests '
      + '(id, project_id, plan_version_id, decision_key, title, question, context, blocking_level, status, '
      + 'raised_by, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      requestId,
      projectId,
      input.planVersionId ?? null,
      input.decisionKey,
      input.title,
      input.question,
      input.context ?? null,
      input.blockingLevel,
      'OPEN',
      input.raisedBy ?? null,
      nowMs,
    )
    for (const option of optionRows) {
      db.prepare(
        'INSERT INTO decision_options '
          + '(id, decision_request_id, option_key, label, description, recommended, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        option.optionId,
        requestId,
        option.optionKey,
        option.label,
        option.description ?? null,
        option.recommended ? 1 : 0,
        option.ordinal,
      )
    }
    db.exec('COMMIT')
    return {
      requestId,
      projectId,
      planVersionId: input.planVersionId,
      decisionKey: input.decisionKey,
      title: input.title,
      question: input.question,
      context: input.context,
      blockingLevel: input.blockingLevel,
      status: 'OPEN',
      raisedBy: input.raisedBy,
      createdAtMs: nowMs,
      resolvedAtMs: undefined,
      options: optionRows,
      decision: undefined,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Record the decision that resolves one OPEN request: validate the inputs,
 * then write the `decisions` row, flip the request to `RESOLVED`, and append
 * one `decision/recorded` event in a single `BEGIN IMMEDIATE` transaction.
 * Each request resolves exactly once; a named option must be one of the
 * request's own.
 * @param db - open ledger database.
 * @param requestId - the request the decision resolves.
 * @param input - the decision's author, text, and optional selected option.
 * @param options - actor and clock overrides.
 * @returns the recorded decision.
 * @throws {DecisionError} on `invalid-argument`, `unknown-decision-request`,
 * `decision-request-resolved`, and `unknown-decision-option`.
 */
export function recordDecision(
  db: DatabaseSync,
  requestId: DecisionRequestId,
  input: RecordDecisionInput,
  options: DecisionWriteOptions = {},
): RecordedDecision {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_DECISION_ACTOR_REF
  requireNonEmpty('decidedBy', input.decidedBy)
  requireNonEmpty('decisionText', input.decisionText)
  db.exec('BEGIN IMMEDIATE')
  try {
    const request = db.prepare(
      'SELECT id, project_id, status FROM decision_requests WHERE id = ?',
    ).get(requestId) as { id: string; project_id: string; status: DecisionRequestStatus } | undefined
    if (request === undefined) {
      throw new DecisionError('unknown-decision-request', `decision request "${requestId}" is not recorded in this ledger`)
    }
    if (request.status !== 'OPEN') {
      throw new DecisionError(
        'decision-request-resolved',
        `decision request "${requestId}" is already ${request.status}; a request resolves exactly once`,
      )
    }
    let selectedOptionId: string | undefined
    if (input.selectedOptionKey !== undefined) {
      const optionRow = db.prepare('SELECT id FROM decision_options WHERE decision_request_id = ? AND option_key = ?')
        .get(requestId, input.selectedOptionKey) as { id: string } | undefined
      if (optionRow === undefined) {
        throw new DecisionError(
          'unknown-decision-option',
          `option "${input.selectedOptionKey}" is not recorded for decision request "${requestId}"`,
        )
      }
      selectedOptionId = optionRow.id
    }
    const projectId = brandString<ProjectId>(request.project_id)
    // The caller holds BEGIN IMMEDIATE, so this pre-read allocation equals
    // the appended event's sequence: the decision id is its event's.
    const decisionId = brandString<DecisionId>(`dc:${requestId}:${nextProjectEventSequence(db, projectId)}`)
    appendProjectEvent(
      db,
      projectId,
      'decision/recorded',
      {
        requestId,
        decisionId,
        decidedBy: input.decidedBy,
        ...(input.selectedOptionKey === undefined ? {} : { selectedOptionKey: input.selectedOptionKey }),
        decisionText: input.decisionText,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        resolvedAtMs: nowMs,
      },
      { entityType: 'decision_request', entityId: requestId, actorRef, nowMs },
    )
    db.prepare(
      'INSERT INTO decisions '
      + '(id, decision_request_id, decided_by, selected_option_id, decision_text, rationale, decided_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(decisionId, requestId, input.decidedBy, selectedOptionId ?? null, input.decisionText, input.rationale ?? null, nowMs)
    db.prepare("UPDATE decision_requests SET status = 'RESOLVED', resolved_at_ms = ? WHERE id = ?").run(nowMs, requestId)
    db.exec('COMMIT')
    return {
      decisionId,
      requestId,
      decidedBy: input.decidedBy,
      selectedOptionId,
      selectedOptionKey: input.selectedOptionKey,
      decisionText: input.decisionText,
      rationale: input.rationale,
      decidedAtMs: nowMs,
    }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Fold one read row into the request half of its group, decision included when one resolved it. */
function buildRequestRow(projectId: ProjectId, row: DecisionJoinRow): DecisionRequest {
  return {
    requestId: brandString<DecisionRequestId>(row.id),
    projectId,
    planVersionId: row.plan_version_id === null ? undefined : brandString<PlanVersionId>(row.plan_version_id),
    decisionKey: row.decision_key,
    title: row.title,
    question: row.question,
    context: row.context ?? undefined,
    blockingLevel: row.blocking_level,
    status: row.status,
    raisedBy: row.raised_by ?? undefined,
    createdAtMs: row.created_at_ms,
    resolvedAtMs: row.resolved_at_ms ?? undefined,
    options: [],
    decision: row.decision_id === null ? undefined : {
      decisionId: brandString<DecisionId>(row.decision_id),
      requestId: brandString<DecisionRequestId>(row.id),
      decidedBy: row.decided_by as string,
      selectedOptionId: row.selected_option_id ?? undefined,
      selectedOptionKey: undefined,
      decisionText: row.decision_text as string,
      rationale: row.rationale ?? undefined,
      decidedAtMs: row.decided_at_ms as number,
    },
  }
}

/**
 * List one project's decision requests newest-first, each with its options
 * in ordinal order and the decision that resolved it, when one did.
 * @param db - open ledger database.
 * @param projectId - project whose decision requests are listed.
 * @returns the requests in `created_at_ms` descending order; a project the
 * ledger records no request for reads as empty.
 */
export function readProjectDecisions(db: DatabaseSync, projectId: ProjectId): readonly DecisionRequest[] {
  const rows = db.prepare(
    'SELECT r.id, r.plan_version_id, r.decision_key, r.title, r.question, r.context, r.blocking_level, r.status, '
    + 'r.raised_by, r.created_at_ms, r.resolved_at_ms, '
    + 'o.id AS option_id, o.option_key, o.label AS option_label, o.description AS option_description, '
    + 'o.recommended AS option_recommended, o.ordinal AS option_ordinal, '
    + 'd.id AS decision_id, d.decided_by, d.selected_option_id, d.decision_text, d.rationale, d.decided_at_ms '
    + 'FROM decision_requests r '
    + 'LEFT JOIN decisions d ON d.decision_request_id = r.id '
    + 'LEFT JOIN decision_options o ON o.decision_request_id = r.id '
    + 'WHERE r.project_id = ? ORDER BY r.created_at_ms DESC, r.id, o.ordinal',
  ).all(projectId) as unknown as DecisionJoinRow[]
  const byId = new Map<string, { request: DecisionRequest; options: DecisionOption[] }>()
  for (const row of rows) {
    let entry = byId.get(row.id)
    if (entry === undefined) {
      entry = { request: buildRequestRow(projectId, row), options: [] }
      byId.set(row.id, entry)
    }
    if (row.option_id !== null) {
      entry.options.push({
        optionId: row.option_id,
        optionKey: row.option_key as string,
        label: row.option_label as string,
        description: row.option_description ?? undefined,
        recommended: row.option_recommended === 1,
        ordinal: row.option_ordinal as number,
      })
    }
  }
  const requests: DecisionRequest[] = []
  for (const entry of byId.values()) {
    const selectedOptionId = entry.request.decision?.selectedOptionId
    const selectedOption = selectedOptionId === undefined
      ? undefined
      : entry.options.find(option => option.optionId === selectedOptionId)
    requests.push({
      ...entry.request,
      options: entry.options,
      decision: entry.request.decision === undefined ? undefined : {
        ...entry.request.decision,
        selectedOptionKey: selectedOption?.optionKey,
      },
    })
  }
  return requests
}
