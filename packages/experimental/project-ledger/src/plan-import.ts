/**
 * Transactional plan import (v1.6a F04): write one compiled plan version into
 * a ledger database as a single atomic unit — plan, version, phases, work
 * items, relations, acceptance criteria, verifier specs, the import record,
 * and the `plan/imported` + `work/created` project events of §15/§16, all in
 * one `BEGIN IMMEDIATE` transaction that either commits whole or rolls back
 * whole. Import never activates a version: `plans.current_version_id` stays
 * untouched and every imported version is `DRAFT` (activation is a later
 * work package's explicit event). Work items are project-scoped projection
 * rows, so a version that re-declares an item already recorded under another
 * version rejects (`work-item-conflict`) instead of re-pointing it — moving
 * items between versions belongs to the supersede flow.
 *
 * The module runs against any open database handle carrying the ledger
 * layout; the physical store lives in
 * `@deepseek-ai/dsh-experimental-project-ledger-sqlite`. The event envelope,
 * vocabulary, and codec live in `project-events.ts`.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/plan-import
 */

import { DatabaseSync } from 'node:sqlite'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CompiledCriterion, CompiledPlan, PlanVersionId } from './plan-compile.js'
import { planVersionRowId } from './plan-compile.js'
import type { PlanVerifier } from './plan-document.js'
import { PLAN_SCHEMA_VERSION } from './plan-document.js'
import { appendProjectEvent } from './project-events.js'

/**
 * Generation of the parsing passes whose output this importer accepts,
 * recorded in `plan_imports.parser_version`.
 */
export const PLAN_PARSER_VERSION = '1'

/** Actor recorded on import events when the caller does not name one. */
export const DEFAULT_IMPORT_ACTOR_REF = 'dsh-experimental-project-ledger/import'

/** Closed set of import rejection reasons. */
export type PlanImportErrorCode = 'version-conflict' | 'work-item-conflict'

/**
 * Thrown when an import is rejected on ledger state. The failing transaction
 * has already rolled back, so the rejection itself never writes.
 */
export class PlanImportError extends Error {
  readonly code: PlanImportErrorCode

  /** @param code - why the import was rejected. @param message - the concrete reason. */
  constructor(code: PlanImportErrorCode, message: string) {
    super(message)
    this.name = 'PlanImportError'
    this.code = code
  }
}

/** Options for {@link importPlanVersion}. */
export interface ImportPlanVersionOptions {
  /** Source location recorded in `plan_imports.source_path`; the import never reads it back. */
  readonly sourcePath?: string | undefined
  /** Actor recorded on the appended events; defaults to {@link DEFAULT_IMPORT_ACTOR_REF}. */
  readonly actorRef?: string | undefined
  /** Wall-clock stamp for every written row; defaults to `Date.now()`. */
  readonly nowMs?: number | undefined
}

/** Outcome of one {@link importPlanVersion} call. */
export interface PlanImportResult {
  /** The plan version the source content is recorded under. */
  readonly planVersionId: PlanVersionId
  /** `true` when the source hash was already imported and nothing was written. */
  readonly reused: boolean
  /** Work item rows written by this call (`0` when reused). */
  readonly importedWorkItemCount: number
}

/** One tagged `verification_specs` row, in insert-parameter order. */
type VerifierSpecRow = [
  id: string,
  criterionId: string,
  verifierKind: PlanVerifier['kind'],
  commandText: string | null,
  expectedExitCode: number | null,
  queryText: string | null,
  expectedJson: string | null,
  ownerInstruction: string | null,
  sandboxRequired: number,
  approvalRequired: number,
]

/**
 * Import one compiled plan version. Re-presenting the same plan with the same
 * source hash is a no-op that returns the recorded version; presenting a
 * version number that already exists with different content throws
 * `version-conflict` instead of overwriting the immutable version.
 * @param db - open ledger database whose layout is at least v1.
 * @param compiled - the canonical IR from {@link compilePlan}.
 * @param options - source path, actor, and clock overrides.
 * @returns the imported (or reused) plan version and how many rows were written.
 * @throws {PlanImportError} on `version-conflict`.
 * @throws the underlying SQLite error when a write fails; the transaction
 * rolls back, leaving no partial rows.
 */
export function importPlanVersion(
  db: DatabaseSync,
  compiled: CompiledPlan,
  options: ImportPlanVersionOptions = {},
): PlanImportResult {
  const nowMs = options.nowMs ?? Date.now()
  const actorRef = options.actorRef ?? DEFAULT_IMPORT_ACTOR_REF
  const versionId = planVersionRowId(compiled.planId, compiled.versionNo)

  // BEGIN IMMEDIATE serializes writers, so the idempotency and conflict
  // checks below read committed state that no competing import can change
  // before COMMIT.
  db.exec('BEGIN IMMEDIATE')
  try {
    const outcome = importWithinTransaction(db, compiled, versionId, nowMs, actorRef, options.sourcePath)
    db.exec('COMMIT')
    return outcome
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Every read, write, and event append of one import, inside the caller's transaction. */
function importWithinTransaction(
  db: DatabaseSync,
  compiled: CompiledPlan,
  versionId: PlanVersionId,
  nowMs: number,
  actorRef: string,
  sourcePath: string | undefined,
): PlanImportResult {
  const recorded = db
    .prepare('SELECT id FROM plan_versions WHERE plan_id = ? AND source_document_hash = ?')
    .get(compiled.planId, compiled.sourceDocumentHash) as { id: string } | undefined
  if (recorded !== undefined) {
    return { planVersionId: recorded.id as PlanVersionId, reused: true, importedWorkItemCount: 0 }
  }
  const conflicting = db
    .prepare('SELECT id FROM plan_versions WHERE plan_id = ? AND version_no = ?')
    .get(compiled.planId, compiled.versionNo) as { id: string } | undefined
  if (conflicting !== undefined) {
    throw new PlanImportError(
      'version-conflict',
      `plan "${compiled.planId}" already records version ${compiled.versionNo} from different source content `
        + `(${conflicting.id}); bump plan.version and re-import`,
    )
  }
  // Work items are project-scoped current-projection rows: a work item lives
  // in exactly one plan version (or the backlog). Re-declaring one under a
  // new version is the supersede flow's decision (a later work package), so
  // import rejects instead of silently re-pointing the projection.
  const recordedItem = db.prepare(
    'SELECT plan_version_id FROM work_items WHERE project_id = ? AND stable_key = ?',
  )
  for (const workItem of compiled.workItems) {
    const existing = recordedItem.get(compiled.projectId, workItem.stableKey) as
      | { plan_version_id: string | null }
      | undefined
    if (existing !== undefined) {
      throw new PlanImportError(
        'work-item-conflict',
        `work item "${workItem.stableKey}" of project "${compiled.projectId}" is already recorded under `
          + `${existing.plan_version_id ?? 'the backlog'}; re-declaring it in version ${compiled.versionNo} `
          + 'belongs to the supersede flow',
      )
    }
  }

  const planRow = db.prepare('SELECT id FROM plans WHERE id = ?').get(compiled.planId)
  if (planRow === undefined) {
    db.prepare('INSERT INTO plans (id, project_id, name, current_version_id, created_at_ms) VALUES (?, ?, ?, NULL, ?)')
      .run(compiled.planId, compiled.projectId, compiled.planName, nowMs)
  }
  db.prepare(
    'INSERT INTO plan_versions '
    + '(id, plan_id, version_no, status, baseline_repo_head, baseline_worktree_hash, source_document_hash, '
    + 'compiled_ir_hash, created_at_ms, activated_at_ms, superseded_at_ms) '
    + "VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, NULL, NULL)",
  ).run(
    versionId,
    compiled.planId,
    compiled.versionNo,
    compiled.baselineRepoHead ?? null,
    compiled.baselineWorktreeHash ?? null,
    compiled.sourceDocumentHash,
    compiled.compiledIrHash,
    nowMs,
  )

  const insertPhase = db.prepare(
    'INSERT INTO phases (id, plan_version_id, stable_key, title, ordinal, status, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const phase of compiled.phases) {
    insertPhase.run(phase.id, versionId, phase.stableKey, phase.title, phase.ordinal, phase.status, phase.description ?? null)
  }

  // Compiled work items are ordered parents-first, so one forward pass
  // satisfies the self-referencing parent foreign key.
  const insertWorkItem = db.prepare(
    'INSERT INTO work_items '
    + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, title, '
    + 'description, priority, status, lock_version, created_at_ms, updated_at_ms) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
  )
  for (const workItem of compiled.workItems) {
    insertWorkItem.run(
      workItem.id,
      compiled.projectId,
      versionId,
      workItem.phaseId ?? null,
      workItem.parentWorkItemId ?? null,
      workItem.stableKey,
      workItem.workType,
      workItem.executorKind,
      workItem.title,
      workItem.description ?? null,
      workItem.priority,
      workItem.status,
      nowMs,
      nowMs,
    )
  }

  const insertRelation = db.prepare(
    'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
    + 'VALUES (?, ?, ?, ?, ?)',
  )
  for (const relation of compiled.relations) {
    insertRelation.run(relation.id, relation.fromWorkItemId, relation.toWorkItemId, relation.relationKind, nowMs)
  }

  const insertCriterion = db.prepare(
    'INSERT INTO acceptance_criteria (id, work_item_id, ordinal, criterion_kind, description, required, status) '
    + "VALUES (?, ?, ?, ?, ?, ?, 'PENDING')",
  )
  const insertVerifierSpec = db.prepare(
    'INSERT INTO verification_specs '
    + '(id, criterion_id, verifier_kind, command_text, expected_exit_code, query_text, expected_json, owner_instruction, '
    + 'sandbox_required, approval_required) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const workItem of compiled.workItems) {
    for (const criterion of workItem.acceptance) {
      insertCriterion.run(
        criterion.id,
        workItem.id,
        criterion.ordinal,
        criterion.criterionKind,
        criterion.description,
        criterion.required ? 1 : 0,
      )
      insertVerifierSpec.run(...verifierSpecRow(criterion))
    }
  }

  db.prepare(
    'INSERT INTO plan_imports '
    + '(id, project_id, source_path, source_hash, schema_version, parser_version, compiler_version, status, '
    + 'plan_version_id, imported_at_ms) '
    + "VALUES (?, ?, ?, ?, ?, ?, ?, 'IMPORTED', ?, ?)",
  ).run(
    `imp:${versionId}`,
    compiled.projectId,
    sourcePath ?? null,
    compiled.sourceDocumentHash,
    PLAN_SCHEMA_VERSION,
    PLAN_PARSER_VERSION,
    compiled.compilerVersion,
    versionId,
    nowMs,
  )

  appendProjectEvent(db, compiled.projectId, 'plan/imported', {
    planId: compiled.planId,
    planVersionId: versionId,
    versionNo: compiled.versionNo,
    sourceDocumentHash: compiled.sourceDocumentHash,
  }, { entityType: 'plan_version', entityId: versionId, actorRef, nowMs })
  for (const workItem of compiled.workItems) {
    appendProjectEvent(db, compiled.projectId, 'work/created', {
      workItemId: workItem.id,
      stableKey: workItem.stableKey,
      title: workItem.title,
      planVersionId: versionId,
    }, { entityType: 'work_item', entityId: workItem.id, actorRef, nowMs })
  }

  return { planVersionId: versionId, reused: false, importedWorkItemCount: compiled.workItems.length }
}

/**
 * Bind one criterion's verifier to the tagged `verification_specs` row: the
 * discriminated union decides which columns carry the payload and which stay
 * `NULL` (the table CHECK mirrors the same shape).
 */
function verifierSpecRow(criterion: CompiledCriterion): VerifierSpecRow {
  const verifier: PlanVerifier = criterion.verifier
  const id = `vs:${criterion.id}`
  switch (verifier.kind) {
    case 'COMMAND':
    case 'TEST':
      return [
        id,
        criterion.id,
        verifier.kind,
        verifier.command,
        verifier.expectedExitCode,
        null,
        null,
        null,
        verifier.sandboxRequired ? 1 : 0,
        verifier.approvalRequired ? 1 : 0,
      ]
    case 'SQL_ASSERTION':
    case 'GRAPH_ASSERTION':
      // Validated documents carry an `expected` value parsed from YAML, whose
      // data tree is always JSON-serializable.
      return [
        id,
        criterion.id,
        verifier.kind,
        null,
        null,
        verifier.query,
        JSON.stringify(verifier.expected),
        null,
        1,
        0,
      ]
    case 'OWNER_CONFIRMATION':
      return [id, criterion.id, verifier.kind, null, null, null, null, verifier.instruction, 1, 0]
    default:
      assertNever(verifier, 'plan verifier kind')
  }
}
