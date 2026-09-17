/**
 * Plan-as-Data entry seam of the v1.6a Project Ledger: strict plan document
 * parsing, v1.1 schema validation, semantic compile checks, canonical IR
 * compilation, transactional immutable plan import, the versioned
 * project-event envelope with its fail-closed read/replay codec, work
 * readiness recomputation with ledger-side cycle detection, the generic
 * work-status transition writer, and append-only acceptance evaluations.
 * Compiling, importing, replaying, reading readiness, and recording
 * evaluations never execute verifier commands and never activate a plan.
 */
export { PLAN_SCHEMA_VERSION, type PlanAcceptanceCriterion, type PlanAcceptanceKind, type PlanBaseline, type PlanDocumentV1, type PlanExecutorKind, type PlanPhase, type PlanPhaseStatus, type PlanPlan, type PlanProject, type PlanRelation, type PlanRelationKind, type PlanVerifier, type PlanVerifierAssertion, type PlanVerifierCommand, type PlanVerifierOwnerConfirmation, type PlanWorkItem, type PlanWorkItemStatus, type PlanWorkItemType } from './plan-document.js'
export { PlanDocumentError, type PlanIssue, type PlanIssueCode, positionAtOffset, type PlanSourcePosition } from './plan-issues.js'
export { parsePlanDocument, type ParsedPlanSource } from './parse-plan.js'
export { planDocumentSchema, PLAN_ACCEPTANCE_KINDS, PLAN_EXECUTOR_KINDS, PLAN_PHASE_STATUSES, PLAN_RELATION_KINDS, PLAN_WORK_ITEM_STATUSES, PLAN_WORK_ITEM_TYPES, validatePlanSchema } from './plan-schema.js'
export { validatePlanSemantics } from './plan-semantics.js'
export { ORDERING_RELATION_KINDS, findChainCycles, findOrderingCycles } from './relation-graph.js'
export { PLAN_COMPILER_VERSION, planVersionRowId, compilePlan, type AcceptanceCriterionId, type CompiledCriterion, type CompiledIrHash, type CompiledPlan, type CompiledRelation, type CompiledWorkItem, type CompilePlanOptions, type PhaseId, type PlanId, type PlanVersionId, type ProjectId, type SourceDocumentHash, type VerifierSpecId, type WorkItemId, type WorkItemRelationId } from './plan-compile.js'
export { PLAN_PARSER_VERSION, DEFAULT_IMPORT_ACTOR_REF, PlanImportError, importPlanVersion, type ImportPlanVersionOptions, type PlanImportErrorCode, type PlanImportResult } from './plan-import.js'
export { ACCEPTANCE_CRITERION_STATUSES, ACCEPTANCE_EVALUATION_RESULTS, PROJECT_EVENT_FORMAT_VERSION, PROJECT_EVENT_TYPES, ProjectEventError, appendProjectEvent, readProjectEvents, replayProjectEvents, type AcceptanceCriterionStatus, type AcceptanceEvaluationResult, type AppendProjectEventOptions, type ProjectEventEnvelope, type ProjectEventErrorCode, type ProjectEventType, type ReplayedCriterion, type ReplayedPlanVersion, type ReplayedProjectProjection, type ReplayedWorkItem } from './project-events.js'
export { WorkReadinessError, computeWorkReadiness, detectWorkGraphCycles, type ComputeWorkReadinessOptions, type WorkGraphCycles, type WorkReadiness, type WorkReadinessBlockerKind, type WorkReadinessErrorCode, type WorkReadinessReason } from './work-readiness.js'
export { DEFAULT_STATUS_ACTOR_REF, WORK_STATUS_TRANSITIONS, WorkStatusError, changeWorkStatus, type ChangeWorkStatusOptions, type WorkStatusChange, type WorkStatusErrorCode } from './work-status.js'
export { DEFAULT_EVALUATION_ACTOR_REF, AcceptanceEvaluationError, evaluateAcceptanceCriterion, type AcceptanceEvaluation, type AcceptanceEvaluationErrorCode, type AcceptanceEvaluationId, type EvaluateAcceptanceCriterionOptions } from './acceptance.js'
