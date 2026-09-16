import { z as zod } from 'zod'
import { type PlanDocumentV1, PLAN_SCHEMA_VERSION } from './plan-document.js'
import { type PlanIssue, PlanDocumentError } from './plan-issues.js'

export { PLAN_SCHEMA_VERSION }

/** Controlled phase statuses; kept in one place for the constitution parity test. */
export const PLAN_PHASE_STATUSES = ['PLANNED', 'READY', 'ACTIVE', 'BLOCKED', 'DONE', 'CANCELLED', 'SUPERSEDED'] as const

/** Controlled work item types; kept in one place for the constitution parity test. */
export const PLAN_WORK_ITEM_TYPES = [
  'IMPLEMENTATION',
  'BUG',
  'RESEARCH',
  'DESIGN',
  'TEST',
  'BENCHMARK',
  'DOCUMENTATION',
  'REVIEW',
  'OWNER_ACTION',
  'ENVIRONMENT_SETUP',
  'MAINTENANCE',
] as const

/** Controlled executor kinds; kept in one place for the constitution parity test. */
export const PLAN_EXECUTOR_KINDS = ['AGENT', 'OWNER', 'SYSTEM', 'EXTERNAL'] as const

/** Controlled work item statuses; kept in one place for the constitution parity test. */
export const PLAN_WORK_ITEM_STATUSES = [
  'PROPOSED',
  'READY',
  'BLOCKED',
  'IN_PROGRESS',
  'VERIFYING',
  'DONE',
  'FAILED',
  'CANCELLED',
  'SUPERSEDED',
] as const

/** Controlled relation kinds; kept in one place for the constitution parity test. */
export const PLAN_RELATION_KINDS = ['BLOCKS', 'PRECEDES', 'RELATES_TO', 'DUPLICATES', 'SUPERSEDES'] as const

/** Controlled acceptance kinds; kept in one place for the constitution parity test. */
export const PLAN_ACCEPTANCE_KINDS = [
  'COMMAND',
  'TEST',
  'SQL_ASSERTION',
  'GRAPH_ASSERTION',
  'OWNER_CONFIRMATION',
] as const

export const planProjectSchema = zod.strictObject({
  id: zod.string().min(1),
  name: zod.string().min(1),
})

export const planBaselineSchema = zod
  .strictObject({
    repoHead: zod.string().min(1).optional(),
    worktreeHash: zod.string().min(1).optional(),
  })
  .superRefine((baseline, context) => {
    if (!('repoHead' in baseline || 'worktreeHash' in baseline)) {
      context.addIssue({
        code: 'custom',
        message: 'baseline requires at least one of repoHead or worktreeHash',
      })
    }
  })

export const planPlanSchema = zod.strictObject({
  id: zod.string().min(1),
  name: zod.string().min(1),
  version: zod.number().int().min(1),
  baseline: planBaselineSchema.optional(),
})

export const planPhaseSchema = zod.strictObject({
  id: zod.string().min(1),
  title: zod.string().min(1),
  ordinal: zod.number().int().min(0),
  status: zod.enum(PLAN_PHASE_STATUSES),
  description: zod.string().optional(),
})

export const commandVerifierSchema = zod.strictObject({
  kind: zod.enum(['COMMAND', 'TEST']),
  command: zod.string().min(1),
  expectedExitCode: zod.number().int(),
  sandboxRequired: zod.boolean(),
  approvalRequired: zod.boolean(),
})

export const assertionVerifierSchema = zod.strictObject({
  kind: zod.enum(['SQL_ASSERTION', 'GRAPH_ASSERTION']),
  query: zod.string().min(1),
  // Accepts any value but not its absence: from YAML, an absent key never
  // reaches validation, while `expected:` with no value parses as null.
  expected: zod.custom<unknown>(value => value !== undefined, 'expected is required'),
})

export const ownerConfirmationVerifierSchema = zod.strictObject({
  kind: zod.literal('OWNER_CONFIRMATION'),
  instruction: zod.string().min(1),
})

export const planVerifierSchema = zod.discriminatedUnion('kind', [
  commandVerifierSchema,
  assertionVerifierSchema,
  ownerConfirmationVerifierSchema,
])

export const planAcceptanceSchema = zod.strictObject({
  id: zod.string().min(1),
  kind: zod.enum(PLAN_ACCEPTANCE_KINDS),
  description: zod.string().min(1),
  required: zod.boolean(),
  verifier: planVerifierSchema,
})

export const planWorkItemSchema = zod.strictObject({
  id: zod.string().min(1),
  phaseId: zod.string().min(1).optional(),
  parentId: zod.string().min(1).optional(),
  type: zod.enum(PLAN_WORK_ITEM_TYPES),
  executorKind: zod.enum(PLAN_EXECUTOR_KINDS),
  title: zod.string().min(1),
  description: zod.string().optional(),
  priority: zod.number().int(),
  status: zod.enum(PLAN_WORK_ITEM_STATUSES),
  acceptance: zod.array(planAcceptanceSchema).min(1),
})

export const planRelationSchema = zod.strictObject({
  from: zod.string().min(1),
  to: zod.string().min(1),
  kind: zod.enum(PLAN_RELATION_KINDS),
})

/**
 * Zod mirror of `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`; a parity
 * test keeps this mirror aligned with the published schema file.
 */
export const planDocumentSchema = zod.strictObject({
  schemaVersion: zod.literal(PLAN_SCHEMA_VERSION),
  project: planProjectSchema,
  plan: planPlanSchema,
  phases: zod.array(planPhaseSchema).min(1),
  workItems: zod.array(planWorkItemSchema).min(1),
  relations: zod.array(planRelationSchema),
})

/**
 * Validate an already-parsed plan value against the strict v1.1 schema.
 * Unsupported `schemaVersion` values fail closed with one dedicated issue
 * instead of cascading through every other field. Never executes verifier
 * commands; validation is pure.
 * @param value - a value produced by `parsePlanDocument` (or any unknown).
 * @returns the validated, narrowed document.
 * @throws {PlanDocumentError} with every schema issue and its dotted path.
 */
export function validatePlanSchema(value: unknown): PlanDocumentV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlanDocumentError([
      { code: 'root-not-mapping', message: 'plan document root must be a mapping of schemaVersion, project, plan, phases, workItems, and relations', path: '$' },
    ])
  }
  const declared = (value as { schemaVersion?: unknown }).schemaVersion
  if (declared !== PLAN_SCHEMA_VERSION) {
    throw new PlanDocumentError([
      {
        code: 'schema-version-unsupported',
        message: `unsupported plan schemaVersion ${displayValue(declared)}; this parser supports only ${PLAN_SCHEMA_VERSION}`,
        path: 'schemaVersion',
      },
    ])
  }
  const parsed = planDocumentSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  const issues: PlanIssue[] = parsed.error.issues.map(issue => ({
    code: 'schema-invalid' as const,
    message: issue.message,
    path: formatZodPath(issue.path),
  }))
  throw new PlanDocumentError(issues)
}

function displayValue(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

/** Render a zod issue path as the dotted document path used by every plan issue. */
export function formatZodPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return '$'
  }
  let formatted = ''
  for (const segment of path) {
    formatted += typeof segment === 'number' ? `[${segment}]` : `${formatted === '' ? '' : '.'}${String(segment)}`
  }
  return formatted
}
