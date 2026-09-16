/**
 * Pure plan compiler (v1.6a F03): bind a validated plan document to
 * deterministic ledger row identities and materialize the canonical IR that
 * `importPlanVersion` writes. Compiling never touches a database, never
 * executes a verifier command, and never activates a plan.
 *
 * Row identities are derived from ledger-stable keys (`wi:<project>:<work id>`,
 * `plv:<plan>:v<n>`, …), so the same document compiles to the same primary
 * keys in every ledger database; a derivation collision can only arise from
 * document ids containing the `:` separator and fails loud on the primary key
 * at import. The canonical IR hash is the SHA-256 of the sorted-key JSON of
 * everything the compiler emits except the two hash fields themselves.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/plan-compile
 */

import { createHash } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type {
  PlanAcceptanceKind,
  PlanDocumentV1,
  PlanExecutorKind,
  PlanPhaseStatus,
  PlanRelationKind,
  PlanVerifier,
  PlanWorkItemStatus,
  PlanWorkItemType,
} from './plan-document.js'
import { type PlanIssue, PlanDocumentError } from './plan-issues.js'

/**
 * Generation of this compile pass, recorded in `plan_imports.compiler_version`.
 * Bump when the identity derivation or the IR shape changes, so an imported
 * version always names the compiler that produced its rows.
 */
export const PLAN_COMPILER_VERSION = '1'

/** Identity of one project row (`plans.project_id`, `work_items.project_id`). */
export type ProjectId = Branded<'ProjectId'>
/** Identity of one plan row (`plans.id`). */
export type PlanId = Branded<'PlanId'>
/** Identity of one immutable plan version row (`plan_versions.id`). */
export type PlanVersionId = Branded<'PlanVersionId'>
/** Identity of one phase row of a plan version. */
export type PhaseId = Branded<'PhaseId'>
/** Identity of one work item row, project-scoped and stable across versions. */
export type WorkItemId = Branded<'WorkItemId'>
/** Identity of one relation edge row. */
export type WorkItemRelationId = Branded<'WorkItemRelationId'>
/** Identity of one acceptance criterion row of a work item. */
export type AcceptanceCriterionId = Branded<'AcceptanceCriterionId'>
/** Identity of the verifier spec row bound one-to-one to a criterion. */
export type VerifierSpecId = Branded<'VerifierSpecId'>
/** SHA-256 hex digest of the exact plan source text a document was parsed from. */
export type SourceDocumentHash = Branded<'SourceDocumentHash'>
/** SHA-256 hex digest of the canonical JSON of the compiled IR. */
export type CompiledIrHash = Branded<'CompiledIrHash'>

/** One phase of the compiled plan version; rows insert in array order. */
export interface CompiledPhase {
  readonly id: PhaseId
  /** The document phase id; unique per plan version. */
  readonly stableKey: string
  readonly title: string
  readonly ordinal: number
  readonly status: PlanPhaseStatus
  readonly description: string | undefined
}

/** One acceptance criterion bound to its verifier data. */
export interface CompiledCriterion {
  readonly id: AcceptanceCriterionId
  /** Zero-based position within the work item's `acceptance` array. */
  readonly ordinal: number
  readonly criterionKind: PlanAcceptanceKind
  readonly description: string
  readonly required: boolean
  readonly verifier: PlanVerifier
}

/**
 * One work item of the compiled plan version with phase, parent, and
 * acceptance references resolved to row identities. Rows are ordered
 * parents-first (hierarchy depth, then document order), so a single forward
 * insert pass satisfies the self-referencing parent foreign key.
 */
export interface CompiledWorkItem {
  readonly id: WorkItemId
  /** The document work item id; unique per project. */
  readonly stableKey: string
  readonly phaseId: PhaseId | undefined
  readonly parentWorkItemId: WorkItemId | undefined
  readonly workType: PlanWorkItemType
  readonly executorKind: PlanExecutorKind
  readonly title: string
  readonly description: string | undefined
  readonly priority: number
  readonly status: PlanWorkItemStatus
  readonly acceptance: readonly CompiledCriterion[]
}

/** One typed relation edge between two compiled work items. */
export interface CompiledRelation {
  readonly id: WorkItemRelationId
  readonly fromWorkItemId: WorkItemId
  readonly toWorkItemId: WorkItemId
  readonly relationKind: PlanRelationKind
}

/**
 * The canonical IR of one plan version: every ledger row the import writes,
 * with identities bound and references resolved. `compiledIrHash` covers all
 * other members, so two compilations agree iff the emitted rows agree.
 */
export interface CompiledPlan {
  readonly compilerVersion: typeof PLAN_COMPILER_VERSION
  readonly projectId: ProjectId
  readonly projectName: string
  readonly planId: PlanId
  readonly planName: string
  readonly versionNo: number
  readonly baselineRepoHead: string | undefined
  readonly baselineWorktreeHash: string | undefined
  readonly sourceDocumentHash: SourceDocumentHash
  readonly compiledIrHash: CompiledIrHash
  readonly phases: readonly CompiledPhase[]
  readonly workItems: readonly CompiledWorkItem[]
  readonly relations: readonly CompiledRelation[]
}

/** Options for {@link compilePlan}. */
export interface CompilePlanOptions {
  /**
   * Exact decoded source text the document was parsed from; its SHA-256
   * digest becomes `sourceDocumentHash`, the re-import idempotency key.
   */
  readonly sourceText: string
}

/**
 * Derive the plan-version row identity from the plan and version it carries.
 * The one identity derivation shared by compile (phase ids embed it) and
 * import (the version row insert uses it).
 * @param planId - the plan row identity.
 * @param versionNo - the immutable version number within the plan.
 * @returns the branded plan-version row identity.
 */
export function planVersionRowId(planId: PlanId, versionNo: number): PlanVersionId {
  return brandString<PlanVersionId>(`plv:${planId}:v${versionNo}`)
}

/**
 * Compile a validated plan document into the canonical IR. Assumes the
 * document passed `validatePlanSchema` and `validatePlanSemantics`
 * (references resolve, hierarchy and ordering relations are acyclic, verifier
 * kinds agree); compile adds the checks only the row identity derivation
 * needs, so an invalid document fails loud at compile instead of colliding at
 * import.
 * @param document - a validated plan document.
 * @param options - the source text the document was parsed from.
 * @returns the compiled IR with deterministic row identities and hashes.
 * @throws {PlanDocumentError} when acceptance criterion ids collide within one
 * work item (`duplicate-criterion-id`).
 */
export function compilePlan(document: PlanDocumentV1, options: CompilePlanOptions): CompiledPlan {
  const issues: PlanIssue[] = []
  const parentOf = new Map<string, string>()
  for (const workItem of document.workItems) {
    if (workItem.parentId !== undefined) {
      parentOf.set(workItem.id, workItem.parentId)
    }
  }
  const workItemIdOf = (documentId: string): WorkItemId =>
    brandString<WorkItemId>(`wi:${document.project.id}:${documentId}`)
  const phaseIdOf = (documentPhaseId: string): PhaseId =>
    brandString<PhaseId>(`ph:${planVersionRowId(brandString<PlanId>(document.plan.id), document.plan.version)}:${documentPhaseId}`)

  const phases = document.phases.map((phase): CompiledPhase => ({
    id: phaseIdOf(phase.id),
    stableKey: phase.id,
    title: phase.title,
    ordinal: phase.ordinal,
    status: phase.status,
    description: phase.description,
  }))

  const depthOf = new Map<string, number>()
  const workItems = document.workItems
    .map((workItem, documentIndex) => ({ workItem, documentIndex }))
    .sort((left, right) =>
      (depthOf.get(left.workItem.id) ?? hierarchyDepth(left.workItem, parentOf, depthOf))
        - (depthOf.get(right.workItem.id) ?? hierarchyDepth(right.workItem, parentOf, depthOf))
        || left.documentIndex - right.documentIndex)
    .map(({ workItem, documentIndex }): CompiledWorkItem => ({
      id: workItemIdOf(workItem.id),
      stableKey: workItem.id,
      phaseId: workItem.phaseId === undefined ? undefined : phaseIdOf(workItem.phaseId),
      parentWorkItemId: workItem.parentId === undefined ? undefined : workItemIdOf(workItem.parentId),
      workType: workItem.type,
      executorKind: workItem.executorKind,
      title: workItem.title,
      description: workItem.description,
      priority: workItem.priority,
      status: workItem.status,
      acceptance: workItem.acceptance.map((criterion, ordinal): CompiledCriterion => {
        const firstOrdinal = workItem.acceptance.findIndex(other => other.id === criterion.id)
        if (firstOrdinal !== ordinal) {
          issues.push({
            code: 'duplicate-criterion-id',
            message: `acceptance criterion id '${criterion.id}' is already used by acceptance[${firstOrdinal}]`,
            path: `workItems[${documentIndex}].acceptance[${ordinal}].id`,
          })
        }
        return {
          id: brandString<AcceptanceCriterionId>(`ac:${workItemIdOf(workItem.id)}:${criterion.id}`),
          ordinal,
          criterionKind: criterion.kind,
          description: criterion.description,
          required: criterion.required,
          verifier: criterion.verifier,
        }
      }),
    }))

  if (issues.length > 0) {
    throw new PlanDocumentError(issues)
  }

  const relations = document.relations.map((relation): CompiledRelation => ({
    id: brandString<WorkItemRelationId>(`rel:${workItemIdOf(relation.from)}:${workItemIdOf(relation.to)}:${relation.kind}`),
    fromWorkItemId: workItemIdOf(relation.from),
    toWorkItemId: workItemIdOf(relation.to),
    relationKind: relation.kind,
  }))

  const sourceDocumentHash = brandString<SourceDocumentHash>(sha256Hex(options.sourceText))
  const compiledIrHash = brandString<CompiledIrHash>(sha256Hex(canonicalJson({
    compilerVersion: PLAN_COMPILER_VERSION,
    projectId: document.project.id,
    projectName: document.project.name,
    planId: document.plan.id,
    planName: document.plan.name,
    versionNo: document.plan.version,
    baselineRepoHead: document.plan.baseline?.repoHead,
    baselineWorktreeHash: document.plan.baseline?.worktreeHash,
    phases,
    workItems,
    relations,
  })))
  return {
    compilerVersion: PLAN_COMPILER_VERSION,
    projectId: brandString<ProjectId>(document.project.id),
    projectName: document.project.name,
    planId: brandString<PlanId>(document.plan.id),
    planName: document.plan.name,
    versionNo: document.plan.version,
    baselineRepoHead: document.plan.baseline?.repoHead,
    baselineWorktreeHash: document.plan.baseline?.worktreeHash,
    sourceDocumentHash,
    compiledIrHash,
    phases,
    workItems,
    relations,
  }
}

/**
 * Memoized parent-chain depth used to order work item rows parents-first.
 * The walk terminates on every chain: validated documents have acyclic
 * parent references, and a missing entry exits the loop like a root.
 */
function hierarchyDepth(
  workItem: { id: string; parentId?: string | undefined },
  parentOf: Map<string, string>,
  depthOf: Map<string, number>,
): number {
  let depth = 0
  let ancestor: string | undefined = workItem.parentId
  while (ancestor !== undefined) {
    depth += 1
    ancestor = parentOf.get(ancestor)
  }
  depthOf.set(workItem.id, depth)
  return depth
}

/** SHA-256 of UTF-8 text as lowercase hex. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * JSON with every object's members sorted by key, so semantically equal IR
 * values hash identically regardless of member order. Array order is
 * preserved (row order is significant); members whose value is `undefined`
 * are omitted, matching JSON semantics.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(element => canonicalJson(element)).join(',')}]`
  }
  // Branch-free three-way compare, so member order never affects the hash.
  const members = Object.entries(value)
    .filter(entry => entry[1] !== undefined)
    .sort(([left], [right]) => Number(left > right) - Number(left < right))
  return `{${members.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
}
