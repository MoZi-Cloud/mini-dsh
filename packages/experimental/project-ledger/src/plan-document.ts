/**
 * Parsed and validated shapes of a mini-DSH plan document, mirroring the
 * published constitution `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`.
 * The zod schemas in `plan-schema.ts` are pinned to these interfaces and a
 * unit test keeps the mirror aligned with the published schema file.
 *
 * Identifiers are the plain strings of the document interchange format; the
 * ledger store brands them when they cross into persistence (v1.6a W02+).
 */

/** The only plan document schema version this parser accepts. */
export const PLAN_SCHEMA_VERSION = 1

/** Lifecycle of a phase inside one plan version. */
export type PlanPhaseStatus = 'PLANNED' | 'READY' | 'ACTIVE' | 'BLOCKED' | 'DONE' | 'CANCELLED' | 'SUPERSEDED'

/** Controlled vocabulary of plan work item types. */
export type PlanWorkItemType =
  | 'IMPLEMENTATION'
  | 'BUG'
  | 'RESEARCH'
  | 'DESIGN'
  | 'TEST'
  | 'BENCHMARK'
  | 'DOCUMENTATION'
  | 'REVIEW'
  | 'OWNER_ACTION'
  | 'ENVIRONMENT_SETUP'
  | 'MAINTENANCE'

/** Who executes a work item; separates Owner todo from Agent todo (v1.6a §11). */
export type PlanExecutorKind = 'AGENT' | 'OWNER' | 'SYSTEM' | 'EXTERNAL'

/** Lifecycle of a work item. */
export type PlanWorkItemStatus =
  | 'PROPOSED'
  | 'READY'
  | 'BLOCKED'
  | 'IN_PROGRESS'
  | 'VERIFYING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'SUPERSEDED'

/** Typed edges between work items; ordering edges participate in cycle detection. */
export type PlanRelationKind = 'BLOCKS' | 'PRECEDES' | 'RELATES_TO' | 'DUPLICATES' | 'SUPERSEDES'

/** How an acceptance criterion is verified. */
export type PlanAcceptanceKind = 'COMMAND' | 'TEST' | 'SQL_ASSERTION' | 'GRAPH_ASSERTION' | 'OWNER_CONFIRMATION'

/** Identity of the project a plan belongs to. */
export interface PlanProject {
  id: string
  name: string
}

/** Optional pin of the repository state a plan version was authored against. */
export interface PlanBaseline {
  repoHead?: string | undefined
  worktreeHash?: string | undefined
}

/** The plan identity block; `version` starts at 1 and grows per superseding version. */
export interface PlanPlan {
  id: string
  name: string
  version: number
  baseline?: PlanBaseline | undefined
}

/** One ordered phase of a plan version. */
export interface PlanPhase {
  id: string
  title: string
  ordinal: number
  status: PlanPhaseStatus
  description?: string | undefined
}

/**
 * Verifier that runs a command (or a test-suite command). `COMMAND` and `TEST`
 * are structurally identical by constitution; they differ only in the declared
 * verification intent.
 */
export interface PlanVerifierCommand {
  kind: 'COMMAND' | 'TEST'
  command: string
  expectedExitCode: number
  sandboxRequired: boolean
  approvalRequired: boolean
}

/** Verifier that asserts on ledger SQL or on the project symbol graph. */
export interface PlanVerifierAssertion {
  kind: 'SQL_ASSERTION' | 'GRAPH_ASSERTION'
  query: string
  /** Any JSON/YAML value; the key must be present. */
  expected: unknown
}

/** Verifier satisfied only by an explicit Owner action. */
export interface PlanVerifierOwnerConfirmation {
  kind: 'OWNER_CONFIRMATION'
  instruction: string
}

/** Discriminated union over the five verifier kinds. */
export type PlanVerifier = PlanVerifierCommand | PlanVerifierAssertion | PlanVerifierOwnerConfirmation

/** One acceptance criterion attached to a work item. */
export interface PlanAcceptanceCriterion {
  id: string
  kind: PlanAcceptanceKind
  description: string
  required: boolean
  verifier: PlanVerifier
}

/** One unit of plannable work; `phaseId`/`parentId` are optional references. */
export interface PlanWorkItem {
  id: string
  phaseId?: string | undefined
  parentId?: string | undefined
  type: PlanWorkItemType
  executorKind: PlanExecutorKind
  title: string
  description?: string | undefined
  priority: number
  status: PlanWorkItemStatus
  acceptance: PlanAcceptanceCriterion[]
}

/** A typed edge between two work items of the same document. */
export interface PlanRelation {
  from: string
  to: string
  kind: PlanRelationKind
}

/** A complete plan document under schema v1.1. */
export interface PlanDocumentV1 {
  schemaVersion: typeof PLAN_SCHEMA_VERSION
  project: PlanProject
  plan: PlanPlan
  phases: PlanPhase[]
  workItems: PlanWorkItem[]
  relations: PlanRelation[]
}
