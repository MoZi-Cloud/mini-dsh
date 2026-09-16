/**
 * Plan-as-Data entry seam of the v1.6a Project Ledger: strict plan document
 * parsing, v1.1 schema validation, semantic compile checks, canonical IR
 * compilation, transactional immutable plan import, and the versioned
 * project-event envelope with its fail-closed read/replay codec. Compiling,
 * importing, and replaying never execute verifier commands and never activate
 * a plan.
 */
export { PLAN_SCHEMA_VERSION, type PlanAcceptanceCriterion, type PlanAcceptanceKind, type PlanBaseline, type PlanDocumentV1, type PlanExecutorKind, type PlanPhase, type PlanPhaseStatus, type PlanPlan, type PlanProject, type PlanRelation, type PlanRelationKind, type PlanVerifier, type PlanVerifierAssertion, type PlanVerifierCommand, type PlanVerifierOwnerConfirmation, type PlanWorkItem, type PlanWorkItemStatus, type PlanWorkItemType } from './plan-document.js'
export { PlanDocumentError, type PlanIssue, type PlanIssueCode, positionAtOffset, type PlanSourcePosition } from './plan-issues.js'
export { parsePlanDocument, type ParsedPlanSource } from './parse-plan.js'
export { planDocumentSchema, PLAN_ACCEPTANCE_KINDS, PLAN_EXECUTOR_KINDS, PLAN_PHASE_STATUSES, PLAN_RELATION_KINDS, PLAN_WORK_ITEM_STATUSES, PLAN_WORK_ITEM_TYPES, validatePlanSchema } from './plan-schema.js'
export { validatePlanSemantics } from './plan-semantics.js'
export { PLAN_COMPILER_VERSION, planVersionRowId, compilePlan, type AcceptanceCriterionId, type CompiledCriterion, type CompiledIrHash, type CompiledPlan, type CompiledRelation, type CompiledWorkItem, type CompilePlanOptions, type PhaseId, type PlanId, type PlanVersionId, type ProjectId, type SourceDocumentHash, type VerifierSpecId, type WorkItemId, type WorkItemRelationId } from './plan-compile.js'
export { PLAN_PARSER_VERSION, DEFAULT_IMPORT_ACTOR_REF, PlanImportError, importPlanVersion, type ImportPlanVersionOptions, type PlanImportErrorCode, type PlanImportResult } from './plan-import.js'
export { PROJECT_EVENT_FORMAT_VERSION, PROJECT_EVENT_TYPES, ProjectEventError, appendProjectEvent, readProjectEvents, replayProjectEvents, type AppendProjectEventOptions, type ProjectEventEnvelope, type ProjectEventErrorCode, type ProjectEventType, type ReplayedPlanVersion, type ReplayedProjectProjection, type ReplayedWorkItem } from './project-events.js'
