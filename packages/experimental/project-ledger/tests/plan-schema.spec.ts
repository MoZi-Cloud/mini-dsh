import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it, describe } from 'vitest'
import {
  parsePlanDocument,
  PlanDocumentError,
  validatePlanSchema,
  validatePlanSemantics,
} from '../src/index.js'
import {
  PLAN_ACCEPTANCE_KINDS,
  PLAN_EXECUTOR_KINDS,
  PLAN_PHASE_STATUSES,
  PLAN_RELATION_KINDS,
  PLAN_WORK_ITEM_STATUSES,
  PLAN_WORK_ITEM_TYPES,
  planBaselineSchema,
  planDocumentSchema,
  planPhaseSchema,
  planPlanSchema,
  planProjectSchema,
  planRelationSchema,
  planWorkItemSchema,
  planAcceptanceSchema,
} from '../src/plan-schema.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_BYTES = readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`)
const CONSTITUTION = JSON.parse(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`, 'utf8'),
) as ConstitutionSchema

/** The parts of the published schema file the parity tests read. */
interface ConstitutionSchema {
  additionalProperties: boolean
  required: string[]
  properties: Record<string, unknown>
  $defs: Record<string, ConstitutionDefinition>
}

/** One `$defs` entry of the published schema file. */
interface ConstitutionDefinition {
  additionalProperties?: boolean
  required?: string[]
  properties?: Record<string, ConstitutionProperty>
  oneOf?: ConstitutionDefinition[]
}

/** One published property. */
interface ConstitutionProperty {
  enum?: string[]
  const?: unknown
}

/** The only part of a zod schema the optionality probe needs. */
interface SchemaProbe {
  safeParse(value: unknown): { success: boolean }
}

/** Return the issues of the PlanDocumentError thrown by `fn`, failing the test when it passes. */
function issuesOf(fn: () => unknown): PlanDocumentError['issues'] {
  try {
    fn()
  } catch (error: unknown) {
    if (error instanceof PlanDocumentError) {
      return error.issues
    }
    throw error
  }
  throw new Error('expected the call to throw PlanDocumentError')
}

function validAcceptance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'AC-1',
    kind: 'COMMAND',
    description: 'The command exits zero',
    required: true,
    verifier: {
      kind: 'COMMAND',
      command: 'pnpm run test',
      expectedExitCode: 0,
      sandboxRequired: true,
      approvalRequired: false,
    },
    ...overrides,
  }
}

function validWorkItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'WI-1',
    type: 'IMPLEMENTATION',
    executorKind: 'AGENT',
    title: 'Do the thing',
    priority: 1,
    status: 'READY',
    acceptance: [validAcceptance()],
    ...overrides,
  }
}

function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: { id: 'demo', name: 'Demo' },
    plan: { id: 'demo-plan', name: 'Demo Plan', version: 1 },
    phases: [{ id: 'W0', title: 'Only phase', ordinal: 0, status: 'PLANNED' }],
    workItems: [validWorkItem()],
    relations: [],
    ...overrides,
  }
}

describe('parsePlanDocument', () => {
  it('accepts the golden plan of this repository as bytes', () => {
    const parsed = parsePlanDocument(GOLDEN_PLAN_BYTES)
    expect(parsed.value).toBeTypeOf('object')
  })

  it('rejects duplicate keys with the offending source position', () => {
    const issues = issuesOf(() => parsePlanDocument('schemaVersion: 1\nschemaVersion: 2\n'))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('duplicate-key')
    expect(issues[0]?.line).toBe(2)
    expect(issues[0]?.column).toBe(1)
  })

  it('rejects duplicate keys nested inside a mapping', () => {
    const issues = issuesOf(() => parsePlanDocument('a:\n  b: 1\n  b: 2\n'))
    expect(issues.map(issue => issue.code)).toEqual(['duplicate-key'])
    expect(issues[0]?.line).toBe(3)
  })

  it('rejects anchors and aliases per the parser policy, with positions', () => {
    const anchorIssues = issuesOf(() => parsePlanDocument('project: &shared\n  id: demo\n  name: Demo\n'))
    expect(anchorIssues.map(issue => issue.code)).toEqual(['anchor-not-allowed'])
    // The anchored block mapping starts at its first content character.
    expect(anchorIssues[0]?.line).toBe(2)
    expect(anchorIssues[0]?.column).toBe(3)

    const aliasIssues = issuesOf(() => parsePlanDocument('project: &shared\n  id: demo\n  name: Demo\nplan: *shared\n'))
    expect(aliasIssues.map(issue => issue.code)).toEqual(['anchor-not-allowed', 'alias-not-allowed'])
    expect(aliasIssues[1]?.line).toBe(4)
  })

  it('resolves folded block scalars deterministically', () => {
    const source = 'plan:\n  id: demo\n  name: Demo\n  version: 1\ndescription: >\n  one two\n  three\n'
    const first = JSON.stringify(parsePlanDocument(source).value)
    const second = JSON.stringify(parsePlanDocument(source).value)
    expect(first).toBe(second)
    expect((parsePlanDocument(source).value as { description: string }).description).toBe('one two three\n')
  })

  it('treats byte and string sources identically and strips a byte-order mark', () => {
    const text = 'schemaVersion: 1\n'
    expect(parsePlanDocument(new TextEncoder().encode(text)).value).toEqual(parsePlanDocument(text).value)
    const withMark = new TextEncoder().encode(`\uFEFF${text}`)
    expect(parsePlanDocument(withMark).value).toEqual({ schemaVersion: 1 })
  })

  it('reports YAML syntax errors with the offending source position', () => {
    const issues = issuesOf(() => parsePlanDocument('plan:\n  id: [oops\n'))
    expect(issues.map(issue => issue.code)).toEqual(['yaml-syntax'])
    // Unterminated flow sequences surface at end of input (line 3, column 1).
    expect(issues[0]?.line).toBe(3)
    expect(issues[0]?.column).toBe(1)
  })
})

describe('validatePlanSchema', () => {
  it('accepts a minimal valid document and returns the typed shape', () => {
    const document = validatePlanSchema(validDocument())
    expect(document.schemaVersion).toBe(1)
    expect(document.phases).toHaveLength(1)
    expect(document.workItems[0]?.acceptance[0]?.verifier.kind).toBe('COMMAND')
  })

  it('rejects unknown fields at every level with their dotted path', () => {
    const rootIssues = issuesOf(() => validatePlanSchema({ ...validDocument(), unexpected: true }))
    expect(rootIssues[0]?.path).toBe('$')
    expect(rootIssues[0]?.message).toContain('unexpected')

    const nested = validDocument({ workItems: [validWorkItem({ surprise: 1 })] })
    const nestedIssues = issuesOf(() => validatePlanSchema(nested))
    expect(nestedIssues[0]?.path).toBe('workItems[0]')
    expect(nestedIssues[0]?.message).toContain('surprise')
  })

  it('rejects unknown enum members', () => {
    const document = validDocument({ workItems: [validWorkItem({ status: 'NOPE' })] })
    const issues = issuesOf(() => validatePlanSchema(document))
    expect(issues[0]?.path).toBe('workItems[0].status')
  })

  it('fails closed on unsupported schemaVersion before cascading', () => {
    for (const declared of [2, '1', null]) {
      const issues = issuesOf(() => validatePlanSchema({ ...validDocument(), schemaVersion: declared, nonsense: true }))
      expect(issues).toHaveLength(1)
      expect(issues[0]?.code).toBe('schema-version-unsupported')
      expect(issues[0]?.path).toBe('schemaVersion')
    }
  })

  it('rejects verifiers missing required fields', () => {
    const verifier = { kind: 'COMMAND', command: 'pnpm run test', sandboxRequired: true, approvalRequired: false }
    const document = validDocument({ workItems: [validWorkItem({ acceptance: [validAcceptance({ verifier })] })] })
    const issues = issuesOf(() => validatePlanSchema(document))
    expect(issues[0]?.path).toBe('workItems[0].acceptance[0].verifier.expectedExitCode')
  })

  it('rejects verifier field combinations of the wrong variant', () => {
    const misplaced = validAcceptance({
      kind: 'OWNER_CONFIRMATION',
      verifier: { kind: 'OWNER_CONFIRMATION', instruction: 'Approve', command: 'rm -rf /' },
    })
    const combinationIssues = issuesOf(() =>
      validatePlanSchema(validDocument({ workItems: [validWorkItem({ acceptance: [misplaced] })] })),
    )
    expect(combinationIssues[0]?.path).toBe('workItems[0].acceptance[0].verifier')
    expect(combinationIssues[0]?.message).toContain('command')

    const missingExpected = validAcceptance({
      kind: 'SQL_ASSERTION',
      verifier: { kind: 'SQL_ASSERTION', query: 'SELECT 1' },
    })
    const expectedIssues = issuesOf(() =>
      validatePlanSchema(validDocument({ workItems: [validWorkItem({ acceptance: [missingExpected] })] })),
    )
    expect(expectedIssues[0]?.path).toBe('workItems[0].acceptance[0].verifier.expected')
  })

  it('rejects non-mapping roots', () => {
    for (const root of [[], 'text', null, 7]) {
      const issues = issuesOf(() => validatePlanSchema(root))
      expect(issues.map(issue => issue.code)).toEqual(['root-not-mapping'])
    }
  })

  it('rejects empty collections that the constitution requires to be non-empty', () => {
    for (const key of ['phases', 'workItems'] as const) {
      const issues = issuesOf(() => validatePlanSchema(validDocument({ [key]: [] })))
      expect(issues[0]?.path).toBe(key)
    }
    const noAcceptance = validDocument({ workItems: [validWorkItem({ acceptance: [] })] })
    expect(issuesOf(() => validatePlanSchema(noAcceptance))[0]?.path).toBe('workItems[0].acceptance')
  })

  it('rejects an empty baseline mapping', () => {
    const document = validDocument({ plan: { id: 'p', name: 'P', version: 1, baseline: {} } })
    const issues = issuesOf(() => validatePlanSchema(document))
    expect(issues.map(issue => issue.code)).toEqual(['schema-invalid'])
    expect(issues[0]?.message).toContain('baseline requires')
  })
})

describe('validatePlanSemantics', () => {
  it('accepts the golden plan of this repository end to end', () => {
    const document = validatePlanSchema(parsePlanDocument(GOLDEN_PLAN_BYTES).value)
    validatePlanSemantics(document)
    expect(document.phases).toHaveLength(13)
    expect(document.workItems).toHaveLength(15)
    expect(document.relations).toHaveLength(14)
  })

  it('rejects unknown phase and parent references', () => {
    const orphanPhase = validDocument({ workItems: [validWorkItem({ phaseId: 'W-MISSING' })] })
    expect(issuesOf(() => { validatePlanSemantics(validatePlanSchema(orphanPhase)) })).toEqual([
      expect.objectContaining({ code: 'unknown-phase-reference', path: 'workItems[0].phaseId' }),
    ])

    const orphanParent = validDocument({ workItems: [validWorkItem({ parentId: 'WI-NOPE' })] })
    expect(issuesOf(() => { validatePlanSemantics(validatePlanSchema(orphanParent)) })).toEqual([
      expect.objectContaining({ code: 'unknown-parent-reference', path: 'workItems[0].parentId' }),
    ])
  })

  it('rejects hierarchy cycles but keeps a shared parent tree acyclic', () => {
    const cycle = validDocument({
      workItems: [
        validWorkItem({ id: 'A', parentId: 'B' }),
        validWorkItem({ id: 'B', parentId: 'A' }),
        validWorkItem({ id: 'C', parentId: 'A' }),
      ],
    })
    const issues = issuesOf(() => { validatePlanSemantics(validatePlanSchema(cycle)) })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('hierarchy-cycle')
    expect(issues[0]?.message).toContain('A -> B -> A')

    const selfParent = validDocument({ workItems: [validWorkItem({ id: 'A', parentId: 'A' })] })
    expect(issuesOf(() => { validatePlanSemantics(validatePlanSchema(selfParent)) })[0]?.message).toContain('A -> A')
  })

  it('rejects unknown relation endpoints, self edges, and duplicate relations', () => {
    const unknown = validDocument({
      relations: [{ from: 'WI-1', to: 'GHOST', kind: 'BLOCKS' }],
    })
    expect(issuesOf(() => { validatePlanSemantics(validatePlanSchema(unknown)) })).toEqual([
      expect.objectContaining({ code: 'unknown-relation-reference', path: 'relations[0].to' }),
    ])

    const selfBlock = validDocument({
      relations: [{ from: 'WI-1', to: 'WI-1', kind: 'BLOCKS' }],
    })
    const selfIssues = issuesOf(() => { validatePlanSemantics(validatePlanSchema(selfBlock)) })
    expect(selfIssues.map(issue => issue.code)).toEqual(['self-relation'])

    const duplicated = validDocument({
      relations: [
        { from: 'WI-1', to: 'WI-2', kind: 'BLOCKS' },
        { from: 'WI-1', to: 'WI-2', kind: 'BLOCKS' },
      ],
      workItems: [validWorkItem({ id: 'WI-1' }), validWorkItem({ id: 'WI-2', acceptance: [validAcceptance({ id: 'AC-2' })] })],
    })
    const duplicateIssues = issuesOf(() => { validatePlanSemantics(validatePlanSchema(duplicated)) })
    expect(duplicateIssues.map(issue => issue.code)).toEqual(['duplicate-relation'])
  })

  it('rejects cycles in every ordering relation kind and ignores non-ordering kinds', () => {
    for (const kind of ['BLOCKS', 'PRECEDES', 'SUPERSEDES'] as const) {
      const cycle = validDocument({
        workItems: [validWorkItem({ id: 'A' }), validWorkItem({ id: 'B', acceptance: [validAcceptance({ id: 'AC-B' })] })],
        relations: [
          { from: 'A', to: 'B', kind },
          { from: 'B', to: 'A', kind },
        ],
      })
      const issues = issuesOf(() => { validatePlanSemantics(validatePlanSchema(cycle)) })
      expect(issues.map(issue => issue.code)).toEqual(['relation-cycle'])
      expect(issues[0]?.message).toContain('A -> B -> A')
    }

    const related = validDocument({
      workItems: [validWorkItem({ id: 'A' }), validWorkItem({ id: 'B', acceptance: [validAcceptance({ id: 'AC-B' })] })],
      relations: [
        { from: 'A', to: 'B', kind: 'RELATES_TO' },
        { from: 'B', to: 'A', kind: 'RELATES_TO' },
      ],
    })
    expect(() => { validatePlanSemantics(validatePlanSchema(related)) }).not.toThrow()
  })

  it('rejects acceptance kind disagreeing with its verifier kind', () => {
    const mismatched = validAcceptance({
      id: 'AC-MISMATCH',
      kind: 'COMMAND',
      verifier: { kind: 'OWNER_CONFIRMATION', instruction: 'Approve the scope' },
    })
    const consistent = validDocument({
      workItems: [validWorkItem({ acceptance: [validAcceptance(), mismatched] })],
    })
    const issues = issuesOf(() => { validatePlanSemantics(validatePlanSchema(consistent)) })
    expect(issues).toEqual([expect.objectContaining({ code: 'acceptance-verifier-kind-mismatch', path: 'workItems[0].acceptance[1].kind' })])
  })

  it('rejects duplicate identifiers and ordinals together in one pass', () => {
    const duplicated = validDocument({
      phases: [
        { id: 'W0', title: 'First', ordinal: 0, status: 'PLANNED' },
        { id: 'W0', title: 'Second', ordinal: 0, status: 'PLANNED' },
      ],
      workItems: [validWorkItem({ id: 'DUP' }), validWorkItem({ id: 'DUP', acceptance: [validAcceptance({ id: 'AC-2' })] })],
    })
    const issues = issuesOf(() => { validatePlanSemantics(validatePlanSchema(duplicated)) })
    expect(issues.map(issue => issue.code)).toEqual([
      'duplicate-phase-id',
      'duplicate-phase-ordinal',
      'duplicate-work-item-id',
    ])
  })
})

describe('constitution parity', () => {
  const objectDefinitionSchemas = {
    project: planProjectSchema,
    baseline: planBaselineSchema,
    plan: planPlanSchema,
    phase: planPhaseSchema,
    workItem: planWorkItemSchema,
    relation: planRelationSchema,
    acceptance: planAcceptanceSchema,
  } as const

  /** A zod field is required exactly when its schema rejects `undefined`. */
  function acceptsUndefined(schema: SchemaProbe): boolean {
    return schema.safeParse(undefined).success
  }

  it('mirrors the root object of the published schema file', () => {
    expect(CONSTITUTION.additionalProperties).toBe(false)
    expect(Object.keys(planDocumentSchema.shape)).toEqual([
      'schemaVersion',
      'project',
      'plan',
      'phases',
      'workItems',
      'relations',
    ])
    const shape = planDocumentSchema.shape as unknown as Record<string, SchemaProbe>
    for (const key of CONSTITUTION.required) {
      expect(acceptsUndefined(shape[key])).toBe(false)
    }
    expect(CONSTITUTION.properties.schemaVersion).toEqual({ const: 1 })
  })

  it('keeps every definition closed, fully keyed, and required exactly as published', () => {
    for (const [name, schema] of Object.entries(objectDefinitionSchemas)) {
      const def = CONSTITUTION.$defs[name]
      expect(def?.additionalProperties, name).toBe(false)
      const shape = schema.shape as unknown as Record<string, SchemaProbe>
      expect(Object.keys(shape).sort(), name).toEqual(Object.keys(def?.properties ?? {}).sort())
      const required = new Set(def?.required ?? [])
      for (const [key, field] of Object.entries(shape)) {
        expect(acceptsUndefined(field), `${name}.${key}`).toBe(!required.has(key))
      }
    }
  })

  it('mirrors every controlled enum of the published schema file', () => {
    const enumParity: [string, string, readonly string[]][] = [
      ['phase', 'status', PLAN_PHASE_STATUSES],
      ['workItem', 'type', PLAN_WORK_ITEM_TYPES],
      ['workItem', 'executorKind', PLAN_EXECUTOR_KINDS],
      ['workItem', 'status', PLAN_WORK_ITEM_STATUSES],
      ['relation', 'kind', PLAN_RELATION_KINDS],
      ['acceptance', 'kind', PLAN_ACCEPTANCE_KINDS],
    ]
    for (const [defName, propertyName, members] of enumParity) {
      const published = CONSTITUTION.$defs[defName]?.properties?.[propertyName]?.enum ?? []
      expect([...members].sort(), `${defName}.${propertyName}`).toEqual([...published].sort())
    }
    const publishedVerifierKinds = (CONSTITUTION.$defs.verifier?.oneOf ?? []).map(
      variant => variant.properties?.kind?.const,
    )
    expect([...publishedVerifierKinds].sort()).toEqual([...PLAN_ACCEPTANCE_KINDS].sort())
  })
})
