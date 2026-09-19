/**
 * Plan-as-Data entry seam of the v1.6a Project Ledger: strict plan document
 * parsing, v1.1 schema validation, semantic compile checks, canonical IR
 * compilation, transactional immutable plan import, the versioned
 * project-event envelope with its fail-closed read/replay codec, work
 * readiness recomputation with ledger-side cycle detection, the generic
 * work-status transition writer, append-only acceptance evaluations, the
 * work lease lifecycle with the readiness projection writers, the bounded
 * deterministic WorkPacket builder that records its reconstruction recipe,
 * the executor-separated Owner/Agent todo views, the immutable plan-version
 * the immutable plan-version supersede and baseline-drift writers, the
 * read-only plan doctor, the plan directory listing, the work-item review
 * read, the work-item evaluation history, the project replay audit, the
 * owner evidence digest, and the v1.6b decision, approval, and resource domains.
 * Compiling, importing, replaying, reading readiness, recording evaluations,
 * claiming, reaping, building packets, listing todos, superseding, recording
 * drift, doctoring, listing plans, reading item reviews and histories,
 * auditing replay parity, digesting owner evidence, and recording decisions
 * never execute verifier commands.
 */
export { PLAN_SCHEMA_VERSION, type PlanAcceptanceCriterion, type PlanAcceptanceKind, type PlanBaseline, type PlanDocumentV1, type PlanExecutorKind, type PlanPhase, type PlanPhaseStatus, type PlanPlan, type PlanProject, type PlanRelation, type PlanRelationKind, type PlanVerifier, type PlanVerifierAssertion, type PlanVerifierCommand, type PlanVerifierOwnerConfirmation, type PlanWorkItem, type PlanWorkItemStatus, type PlanWorkItemType } from './plan-document.js'
export { PlanDocumentError, type PlanIssue, type PlanIssueCode, positionAtOffset, type PlanSourcePosition } from './plan-issues.js'
export { parsePlanDocument, type ParsedPlanSource } from './parse-plan.js'
export { planDocumentSchema, PLAN_ACCEPTANCE_KINDS, PLAN_EXECUTOR_KINDS, PLAN_PHASE_STATUSES, PLAN_RELATION_KINDS, PLAN_WORK_ITEM_STATUSES, PLAN_WORK_ITEM_TYPES, validatePlanSchema } from './plan-schema.js'
export { validatePlanSemantics } from './plan-semantics.js'
export { ORDERING_RELATION_KINDS, findChainCycles, findOrderingCycles } from './relation-graph.js'
export { PLAN_COMPILER_VERSION, planVersionRowId, compilePlan, type AcceptanceCriterionId, type CompiledCriterion, type CompiledIrHash, type CompiledPlan, type CompiledRelation, type CompiledWorkItem, type CompilePlanOptions, type PhaseId, type PlanId, type PlanVersionId, type ProjectId, type SourceDocumentHash, type VerifierSpecId, type WorkItemId, type WorkItemRelationId } from './plan-compile.js'
export { PLAN_PARSER_VERSION, DEFAULT_IMPORT_ACTOR_REF, PlanImportError, importPlanVersion, type ImportPlanVersionOptions, type PlanImportErrorCode, type PlanImportResult } from './plan-import.js'
export { ACCEPTANCE_CRITERION_STATUSES, ACCEPTANCE_EVALUATION_RESULTS, APPROVAL_OUTCOMES, APPROVAL_SUBJECT_TYPES, RESOURCE_VERIFICATION_RESULTS, RESOURCE_VERIFIER_KINDS, DECISION_BLOCKING_LEVELS, PROJECT_EVENT_FORMAT_VERSION, PROJECT_EVENT_TYPES, SUPERSEDE_POLICY, WORK_PACKET_REFERENCE_KINDS, ProjectEventError, appendProjectEvent, decodeWorkPacketPreparedPayload, nextProjectEventSequence, readProjectEvents, readWorkPacketEvent, replayProjectEvents, type AcceptanceCriterionStatus, type AcceptanceEvaluationResult, type AppendProjectEventOptions, type ApprovalDecisionOutcome, type ApprovalSubjectType, type ResourceVerificationResult, type ResourceVerifierKind, type DecisionBlockingLevel, type ProjectEventEnvelope, type ProjectEventErrorCode, type ProjectEventType, type ReplayedApproval, type ReplayedCriterion, type ReplayedDecision, type ReplayedDecisionRequest, type ReplayedLease, type ReplayedLeaseStatus, type ReplayedPlanVersion, type ReplayedProjectProjection, type ReplayedResourceInstance, type ReplayedResourceRequirement, type ReplayedResourceVerification, type ReplayedWorkItem, type ReplayedWorkPacket, type ReplayedWorkPacketReference, type WorkPacketReferenceKind } from './project-events.js'
export { WORK_READINESS_BLOCKER_KINDS, WorkReadinessError, computeWorkReadiness, detectWorkGraphCycles, type ComputeWorkReadinessOptions, type WorkGraphCycles, type WorkReadiness, type WorkReadinessBlockerKind, type WorkReadinessErrorCode, type WorkReadinessReason } from './work-readiness.js'
export { DEFAULT_STATUS_ACTOR_REF, WORK_STATUS_TRANSITIONS, WorkStatusError, changeWorkStatus, type ChangeWorkStatusOptions, type WorkStatusChange, type WorkStatusErrorCode } from './work-status.js'
export { DEFAULT_EVALUATION_ACTOR_REF, AcceptanceEvaluationError, evaluateAcceptanceCriterion, type AcceptanceEvaluation, type AcceptanceEvaluationErrorCode, type AcceptanceEvaluationId, type EvaluateAcceptanceCriterionOptions } from './acceptance.js'
export { DEFAULT_LEASE_ACTOR_REF, DEFAULT_LEASE_CONFIG, DEFAULT_READINESS_ACTOR_REF, LeaseError, blockWorkItem, claimWorkItem, heartbeatWorkLease, reapExpiredLeases, releaseWorkLease, resolveLeaseConfig, unblockWorkItem, type ClaimWorkItemOptions, type HeartbeatWorkLeaseOptions, type LeaseConfig, type LeaseErrorCode, type LeaseStatus, type ReadinessProjectionOptions, type ReapExpiredLeasesOptions, type ReapedLease, type ReleaseWorkLeaseOptions, type WorkLease, type WorkLeaseClaim, type WorkLeaseId, type WorkReadinessProjectionChange } from './lease.js'
export { DEFAULT_PACKET_ACTOR_REF, WORK_PACKET_BUILDER_VERSION, WORK_PACKET_FORMAT_VERSION, WORK_PACKET_MAX_SERIALIZED_BYTES, WorkPacketError, buildWorkPacket, rebuildWorkPacket, serializeWorkPacket, type BuildWorkPacketOptions, type WorkPacket, type WorkPacketCriterion, type WorkPacketDocument, type WorkPacketErrorCode, type WorkPacketId, type WorkPacketObjective, type WorkPacketPhaseSummary, type WorkPacketPlanIdentity, type WorkPacketReference, type WorkPacketRelationReceipt, type WorkPacketRebuild, type WorkPacketRepoSnapshot, type WorkPacketVerifierSpec } from './work-packet.js'
export { AGENT_TODO_EXECUTOR_KINDS, OWNER_TODO_EXECUTOR_KINDS, TODO_VIEW_STATUSES, WorkTodoError, listAgentTodo, listOwnerTodo, listWorkTodo, resolveWorkTodoSpec, type WorkTodoEntry, type WorkTodoErrorCode, type WorkTodoLeaseRef, type WorkTodoRequest, type WorkTodoSpec, type WorkTodoView } from './todo-views.js'
export { DEFAULT_DRIFT_ACTOR_REF, DEFAULT_SUPERSEDE_ACTOR_REF, PLAN_VERSION_STATUSES, BaselineDriftError, PlanSupersedeError, recordBaselineDrift, supersedePlanVersion, type BaselineDrift, type BaselineDriftErrorCode, type ObservedBaseline, type PlanSupersedeErrorCode, type PlanVersionStatus, type PlanVersionSupersede, type RecordBaselineDriftOptions, type SupersededAttempt, type SupersedePlanVersionOptions, type WorkExternalBlockerId } from './versioning.js'
export {
  PLAN_DOCTOR_ISSUE_CODES,
  PlanDoctorError,
  planDoctor,
  type PlanDoctorCounts,
  type PlanDoctorErrorCode,
  type PlanDoctorIssue,
  type PlanDoctorOptions,
  type PlanDoctorReport,
} from './doctor.js'
export { listPlans, type PlanDirectoryEntry } from './plan-directory.js'
export { readWorkItemReview, type LatestEvaluation, type ReviewedCriterion, type WorkItemReview } from './work-item-review.js'
export { readProjectReplay, type ProjectReplayCompared, type ProjectReplayDrift, type ProjectReplayEntityCounts, type ProjectReplayReport, type ProjectReplayUndecodable, type ReplayedEntityCounts } from './project-replay.js'
export { readProjectDigest, type DigestItem, type DigestPlan, type DigestPlanVersion, type ProjectDigest } from './project-digest.js'
export { readWorkItemHistory, type HistoryEvaluation, type WorkItemHistory } from './work-item-history.js'
export {
  DEFAULT_DECISION_ACTOR_REF,
  DecisionError,
  openDecisionRequest,
  readProjectDecisions,
  recordDecision,
  type DecisionErrorCode,
  type DecisionId,
  type DecisionOption,
  type DecisionOptionInput,
  type DecisionRequest,
  type DecisionRequestId,
  type DecisionRequestStatus,
  type DecisionWriteOptions,
  type OpenDecisionRequestInput,
  type RecordDecisionInput,
  type RecordedDecision,
} from './decisions.js'
export {
  DEFAULT_APPROVAL_ACTOR_REF,
  ApprovalError,
  decideApproval,
  readProjectApprovals,
  requestApproval,
  type Approval,
  type ApprovalDecision,
  type ApprovalErrorCode,
  type ApprovalId,
  type ApprovalStatus,
  type ApprovalWriteOptions,
  type DecideApprovalInput,
  type RequestApprovalInput,
} from './approvals.js'
export {
  DEFAULT_RESOURCE_ACTOR_REF,
  ResourceError,
  openResourceRequirement,
  provideResourceInstance,
  readProjectResources,
  verifyResourceInstance,
  type OpenResourceRequirementInput,
  type ProvideResourceInstanceInput,
  type ResourceErrorCode,
  type ResourceInstance,
  type ResourceInstanceId,
  type ResourceInstanceStatus,
  type ResourceRequirement,
  type ResourceRequirementId,
  type ResourceRequirementStatus,
  type ResourceVerification,
  type ResourceVerificationId,
  type ResourceWriteOptions,
  type VerifyResourceInstanceInput,
} from './resources.js'
