/**
 * Plan-as-Data entry seam of the v1.6a Project Ledger: strict plan document
 * parsing, v1.1 schema validation, and semantic compile checks. Import only
 * compiles; it never executes verifier commands and never activates a plan.
 */
export { PLAN_SCHEMA_VERSION, type PlanAcceptanceCriterion, type PlanAcceptanceKind, type PlanBaseline, type PlanDocumentV1, type PlanExecutorKind, type PlanPhase, type PlanPhaseStatus, type PlanPlan, type PlanProject, type PlanRelation, type PlanRelationKind, type PlanVerifier, type PlanVerifierAssertion, type PlanVerifierCommand, type PlanVerifierOwnerConfirmation, type PlanWorkItem, type PlanWorkItemStatus, type PlanWorkItemType } from './plan-document.js'
export { PlanDocumentError, type PlanIssue, type PlanIssueCode, positionAtOffset, type PlanSourcePosition } from './plan-issues.js'
export { parsePlanDocument, type ParsedPlanSource } from './parse-plan.js'
export { planDocumentSchema, PLAN_ACCEPTANCE_KINDS, PLAN_EXECUTOR_KINDS, PLAN_PHASE_STATUSES, PLAN_RELATION_KINDS, PLAN_WORK_ITEM_STATUSES, PLAN_WORK_ITEM_TYPES, validatePlanSchema } from './plan-schema.js'
export { validatePlanSemantics } from './plan-semantics.js'
