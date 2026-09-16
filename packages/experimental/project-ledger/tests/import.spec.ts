import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_EVENT_FORMAT_VERSION as STORE_EVENT_FORMAT_VERSION,
  openProjectLedgerDatabase,
} from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_IMPORT_ACTOR_REF,
  PLAN_COMPILER_VERSION,
  PLAN_PARSER_VERSION,
  PlanDocumentError,
  PlanImportError,
  PROJECT_EVENT_FORMAT_VERSION,
  compilePlan,
  importPlanVersion,
  parsePlanDocument,
  validatePlanSchema,
  validatePlanSemantics,
  type CompiledPlan,
  type PlanDocumentV1,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/** Parse, validate, and compile a plan document from its exact source text. */
function compileFromText(sourceText: string): CompiledPlan {
  const { value } = parsePlanDocument(sourceText)
  return compilePlan(validatePlanSchema(value), { sourceText })
}

/** Compile an already-typed document object against the given source text. */
function compileDocument(document: PlanDocumentV1, sourceText: string): CompiledPlan {
  validatePlanSchema(document)
  validatePlanSemantics(document)
  return compilePlan(document, { sourceText })
}

const LEDGER_TABLES = [
  'plans',
  'plan_versions',
  'phases',
  'work_items',
  'work_item_relations',
  'acceptance_criteria',
  'verification_specs',
  'plan_imports',
  'project_events',
] as const

/** Row counts of every ledger table, the no-partial-write assertion. */
function rowCounts(db: DatabaseSync): Record<(typeof LEDGER_TABLES)[number], number> {
  return Object.fromEntries(LEDGER_TABLES.map(table => [
    table,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  ])) as Record<(typeof LEDGER_TABLES)[number], number>
}

const EMPTY_COUNTS = {
  plans: 0,
  plan_versions: 0,
  phases: 0,
  work_items: 0,
  work_item_relations: 0,
  acceptance_criteria: 0,
  verification_specs: 0,
  plan_imports: 0,
  project_events: 0,
}

/** One-project document exercising every verifier seam, backlog items, and hierarchy. */
function syntheticDocument(): PlanDocumentV1 {
  return {
    schemaVersion: 1,
    project: { id: 'p2', name: 'Project Two' },
    plan: {
      id: 'p2-plan',
      name: 'P2 Plan',
      version: 1,
      baseline: { repoHead: 'abc1234', worktreeHash: 'def5678' },
    },
    phases: [{ id: 'PH1', title: 'Phase One', ordinal: 0, status: 'PLANNED' }],
    workItems: [
      {
        id: 'CHILD',
        phaseId: 'PH1',
        parentId: 'ROOT',
        type: 'IMPLEMENTATION',
        executorKind: 'AGENT',
        title: 'Child item',
        priority: 5,
        status: 'PROPOSED',
        acceptance: [
          {
            id: 'AC-SQL',
            kind: 'SQL_ASSERTION',
            description: 'ledger rows exist',
            required: true,
            verifier: { kind: 'SQL_ASSERTION', query: 'SELECT COUNT(*) AS n FROM plans', expected: { rows: null } },
          },
          {
            id: 'AC-GRAPH',
            kind: 'GRAPH_ASSERTION',
            description: 'call edge exists',
            required: false,
            verifier: { kind: 'GRAPH_ASSERTION', query: 'calls(compilePlan)', expected: ['importPlanVersion'] },
          },
          {
            id: 'AC-CMD',
            kind: 'COMMAND',
            description: 'tool runs unsandboxed with approval',
            required: false,
            verifier: {
              kind: 'COMMAND',
              command: 'echo ok',
              expectedExitCode: 0,
              sandboxRequired: false,
              approvalRequired: true,
            },
          },
        ],
      },
      {
        id: 'ROOT',
        phaseId: 'PH1',
        type: 'DESIGN',
        executorKind: 'OWNER',
        title: 'Root item',
        description: 'Root of the hierarchy',
        priority: 1,
        status: 'PROPOSED',
        acceptance: [
          {
            id: 'AC-OWNER',
            kind: 'OWNER_CONFIRMATION',
            description: 'owner signs off',
            required: true,
            verifier: { kind: 'OWNER_CONFIRMATION', instruction: 'Sign off on the design' },
          },
        ],
      },
      {
        id: 'BACKLOG',
        type: 'RESEARCH',
        executorKind: 'OWNER',
        title: 'Backlog item',
        priority: 0,
        status: 'PROPOSED',
        acceptance: [
          {
            // The same criterion document id as CHILD's: row identities are
            // scoped per work item, so cross-item reuse compiles.
            id: 'AC-SQL',
            kind: 'SQL_ASSERTION',
            description: 'backlog variant',
            required: false,
            verifier: { kind: 'SQL_ASSERTION', query: 'SELECT 1', expected: 'one' },
          },
        ],
      },
    ],
    relations: [{ from: 'ROOT', to: 'CHILD', kind: 'BLOCKS' }],
  }
}

describe('golden plan import (IMPORT-001)', () => {
  it('imports the repository plan once into every ledger table', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const compiled = compileFromText(GOLDEN_PLAN_TEXT)
    const result = importPlanVersion(db, compiled)

    expect(result).toEqual({
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      reused: false,
      importedWorkItemCount: 15,
    })
    expect(rowCounts(db)).toEqual({
      ...EMPTY_COUNTS,
      plans: 1,
      plan_versions: 1,
      phases: 13,
      work_items: 15,
      work_item_relations: 14,
      acceptance_criteria: 16,
      verification_specs: 16,
      plan_imports: 1,
      project_events: 16,
    })

    expect(db.prepare('SELECT project_id, name, current_version_id FROM plans').get()).toEqual({
      project_id: 'mini-dsh',
      name: 'Plan-as-Data Ledger Core',
      // Import never activates: activation is a later work package's event.
      current_version_id: null,
    })
    expect(db.prepare(
      'SELECT status, version_no, baseline_repo_head, baseline_worktree_hash, activated_at_ms, superseded_at_ms '
      + 'FROM plan_versions',
    ).get()).toEqual({
      status: 'DRAFT',
      version_no: 1,
      baseline_repo_head: null,
      baseline_worktree_hash: null,
      activated_at_ms: null,
      superseded_at_ms: null,
    })
    const versionRow = db.prepare('SELECT source_document_hash, compiled_ir_hash FROM plan_versions').get() as {
      source_document_hash: string
      compiled_ir_hash: string
    }
    expect(versionRow.source_document_hash).toBe(createHash('sha256').update(GOLDEN_PLAN_TEXT, 'utf8').digest('hex'))
    expect(versionRow.compiled_ir_hash).toBe(compiled.compiledIrHash)

    const phaseDescriptions = db.prepare('SELECT stable_key, description FROM phases WHERE stable_key IN (?, ?)')
      .all('W00', 'W03') as { stable_key: string; description: string | null }[]
    expect(Object.fromEntries(phaseDescriptions.map(row => [row.stable_key, row.description]))).toEqual({
      W00: 'Pin DSH source, import prior design history, and define the real 4K benchmark before production code.',
      W03: null,
    })

    const importItem = db.prepare(
      'SELECT wi.stable_key, wi.work_type, wi.executor_kind, wi.title, wi.priority, wi.status, wi.lock_version, '
      + 'wi.phase_id, wi.plan_version_id, p.stable_key AS phase_key '
      + 'FROM work_items wi JOIN phases p ON p.id = wi.phase_id WHERE wi.stable_key = ?',
    ).get('IMPORT-001') as Record<string, unknown>
    expect(importItem).toEqual({
      stable_key: 'IMPORT-001',
      work_type: 'IMPLEMENTATION',
      executor_kind: 'AGENT',
      title: 'Compile and transactionally import an immutable plan version',
      priority: 80,
      status: 'BLOCKED',
      lock_version: 0,
      phase_id: 'ph:plv:mini-dsh-v1.6a-ledger:v1:W03',
      plan_version_id: 'plv:mini-dsh-v1.6a-ledger:v1',
      phase_key: 'W03',
    })

    expect(db.prepare(
      'SELECT id, relation_kind FROM work_item_relations WHERE from_work_item_id = ? AND to_work_item_id = ?',
    ).get('wi:mini-dsh:IMPORT-001', 'wi:mini-dsh:EVENT-001')).toEqual({
      id: 'rel:wi:mini-dsh:IMPORT-001:wi:mini-dsh:EVENT-001:PRECEDES',
      relation_kind: 'PRECEDES',
    })

    const spec = db.prepare(
      'SELECT c.ordinal, c.criterion_kind, c.required, c.status, s.command_text, s.expected_exit_code, s.query_text, '
      + 's.expected_json, s.owner_instruction, s.sandbox_required, s.approval_required '
      + 'FROM acceptance_criteria c JOIN verification_specs s ON s.criterion_id = c.id WHERE c.id = ?',
    ).get('ac:wi:mini-dsh:IMPORT-001:AC-IMPORT-001') as Record<string, unknown>
    expect(spec).toEqual({
      ordinal: 0,
      criterion_kind: 'TEST',
      required: 1,
      status: 'PENDING',
      command_text: 'pnpm exec vitest run packages/experimental/project-ledger/tests/import.spec.ts',
      expected_exit_code: 0,
      query_text: null,
      expected_json: null,
      owner_instruction: null,
      sandbox_required: 1,
      approval_required: 0,
    })
    const ownerSpec = db.prepare(
      'SELECT s.owner_instruction FROM acceptance_criteria c '
      + 'JOIN verification_specs s ON s.criterion_id = c.id WHERE c.criterion_kind = ?',
    ).get('OWNER_CONFIRMATION') as { owner_instruction: string }
    expect(ownerSpec.owner_instruction).toBe('Confirm v1.6a Ledger Core scope and activation.')

    const importRow = db.prepare(
      'SELECT id, project_id, source_path, source_hash, schema_version, parser_version, compiler_version, status, '
      + 'plan_version_id FROM plan_imports',
    ).get() as Record<string, unknown>
    expect(importRow).toEqual({
      id: 'imp:plv:mini-dsh-v1.6a-ledger:v1',
      project_id: 'mini-dsh',
      source_path: null,
      source_hash: versionRow.source_document_hash,
      schema_version: 1,
      parser_version: PLAN_PARSER_VERSION,
      compiler_version: PLAN_COMPILER_VERSION,
      status: 'IMPORTED',
      plan_version_id: 'plv:mini-dsh-v1.6a-ledger:v1',
    })

    const events = db.prepare(
      'SELECT sequence_no, event_format_version, event_type, ignorable, entity_type, entity_id, actor_ref, payload_json '
      + 'FROM project_events ORDER BY sequence_no',
    ).all() as Record<string, unknown>[]
    expect(events).toHaveLength(16)
    expect(events[0]).toEqual({
      sequence_no: 1,
      event_format_version: PROJECT_EVENT_FORMAT_VERSION,
      event_type: 'plan/imported',
      ignorable: 0,
      entity_type: 'plan_version',
      entity_id: 'plv:mini-dsh-v1.6a-ledger:v1',
      actor_ref: DEFAULT_IMPORT_ACTOR_REF,
      payload_json: JSON.stringify({
        planId: 'mini-dsh-v1.6a-ledger',
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        versionNo: 1,
        sourceDocumentHash: versionRow.source_document_hash,
      }),
    })
    const created = events.slice(1)
    expect(new Set(created.map(event => event['event_type']))).toEqual(new Set(['work/created']))
    const importCreated = created.find(event => event['entity_id'] === 'wi:mini-dsh:IMPORT-001')
    expect(JSON.parse(String(importCreated?.['payload_json']))).toEqual({
      workItemId: 'wi:mini-dsh:IMPORT-001',
      stableKey: 'IMPORT-001',
      title: 'Compile and transactionally import an immutable plan version',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
    })
    expect(created.map(event => event['sequence_no'])).toEqual([...created.keys()].map(offset => offset + 2))

    db.close()
  })

  it('re-importing the same source is idempotent by hash', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const compiled = compileFromText(GOLDEN_PLAN_TEXT)
    importPlanVersion(db, compiled)
    const afterFirst = rowCounts(db)

    const repeat = importPlanVersion(db, compiled)
    const recompiled = compileFromText(GOLDEN_PLAN_TEXT)
    expect(recompiled.compiledIrHash).toBe(compiled.compiledIrHash)
    const repeatAfterRecompile = importPlanVersion(db, recompiled)

    expect(repeat).toEqual({ planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1', reused: true, importedWorkItemCount: 0 })
    expect(repeatAfterRecompile).toEqual(repeat)
    expect(rowCounts(db)).toEqual(afterFirst)
    expect(afterFirst.project_events).toBe(16)
    db.close()
  })

  it('importing a second version with fresh work items appends without touching the first', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const compiledV1 = compileFromText(GOLDEN_PLAN_TEXT)
    importPlanVersion(db, compiledV1)

    const documentV2 = structuredClone(validatePlanSchema(parsePlanDocument(GOLDEN_PLAN_TEXT).value))
    documentV2.plan.version = 2
    documentV2.phases[3]!.title = 'Plan compiler and immutable import (revised)'
    for (const workItem of documentV2.workItems) {
      workItem.id = `${workItem.id}-V2`
    }
    for (const relation of documentV2.relations) {
      relation.from = `${relation.from}-V2`
      relation.to = `${relation.to}-V2`
    }
    const compiledV2 = compileDocument(documentV2, JSON.stringify(documentV2))
    expect(compiledV2.compiledIrHash).not.toBe(compiledV1.compiledIrHash)
    const resultV2 = importPlanVersion(db, compiledV2)

    expect(resultV2).toEqual({
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v2',
      reused: false,
      importedWorkItemCount: 15,
    })
    expect(rowCounts(db)).toEqual({
      ...EMPTY_COUNTS,
      plans: 1,
      plan_versions: 2,
      phases: 26,
      work_items: 30,
      work_item_relations: 28,
      acceptance_criteria: 32,
      verification_specs: 32,
      plan_imports: 2,
      project_events: 32,
    })
    expect(db.prepare('SELECT source_document_hash FROM plan_versions WHERE version_no = 1').get()).toEqual({
      source_document_hash: compiledV1.sourceDocumentHash,
    })
    expect(db.prepare('SELECT current_version_id FROM plans').get()).toEqual({ current_version_id: null })
    db.close()
  })

  it('rejects a version re-declaring work items recorded under another version', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compileFromText(GOLDEN_PLAN_TEXT))
    const afterFirst = rowCounts(db)

    // Work items are project-scoped projection rows: re-pointing them at a
    // new version is the supersede flow's decision, not an import side effect.
    const documentV2 = structuredClone(validatePlanSchema(parsePlanDocument(GOLDEN_PLAN_TEXT).value))
    documentV2.plan.version = 2
    documentV2.phases[3]!.title = 'Plan compiler and immutable import (revised)'
    try {
      importPlanVersion(db, compileDocument(documentV2, JSON.stringify(documentV2)))
      expect.unreachable('work-item-conflict expected')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PlanImportError)
      expect((error as PlanImportError).code).toBe('work-item-conflict')
      expect((error as PlanImportError).message).toContain('belongs to the supersede flow')
    }
    expect(rowCounts(db)).toEqual(afterFirst)
    db.close()
  })

  it('rejects re-declaring a backlog work item, naming the backlog in the reason', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    db.prepare(
      'INSERT INTO work_items '
      + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, title, '
      + 'description, priority, status, lock_version, created_at_ms, updated_at_ms) '
      + "VALUES (?, ?, NULL, NULL, NULL, ?, 'DOCUMENTATION', 'AGENT', ?, NULL, 0, 'READY', 0, 1, 1)",
    ).run('wi:mini-dsh:PRE-001', 'mini-dsh', 'PRE-001', 'Backlog twin discovered outside any plan')
    try {
      importPlanVersion(db, compileFromText(GOLDEN_PLAN_TEXT))
      expect.unreachable('work-item-conflict expected')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PlanImportError)
      expect((error as PlanImportError).code).toBe('work-item-conflict')
      expect((error as PlanImportError).message).toContain('is already recorded under the backlog')
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_versions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_imports').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_events').get()).toEqual({ n: 0 })
    db.close()
  })

  it('rejects a version number reuse with different source content and writes nothing', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compileFromText(GOLDEN_PLAN_TEXT))
    const afterFirst = rowCounts(db)

    // Same semantic content, different source bytes: the hash idempotency
    // misses, the version number collides, and the immutable version wins.
    const reserialized = compileFromText(JSON.stringify(validatePlanSchema(parsePlanDocument(GOLDEN_PLAN_TEXT).value)))
    expect(reserialized.sourceDocumentHash).not.toBe(createHash('sha256').update(GOLDEN_PLAN_TEXT, 'utf8').digest('hex'))
    try {
      importPlanVersion(db, reserialized)
      expect.unreachable('version-conflict expected')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PlanImportError)
      expect((error as PlanImportError).code).toBe('version-conflict')
      expect((error as PlanImportError).message).toContain('already records version 1')
    }
    expect(rowCounts(db)).toEqual(afterFirst)
    db.close()
  })

  it('a compile error never reaches the database', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const document = structuredClone(validatePlanSchema(parsePlanDocument(GOLDEN_PLAN_TEXT).value))
    const first = document.workItems[0]!
    first.acceptance.push(structuredClone(first.acceptance[0]!))

    validatePlanSchema(document)
    validatePlanSemantics(document)
    try {
      compilePlan(document, { sourceText: GOLDEN_PLAN_TEXT })
      expect.unreachable('duplicate-criterion-id expected')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PlanDocumentError)
      expect((error as PlanDocumentError).issues).toEqual([{
        code: 'duplicate-criterion-id',
        message: `acceptance criterion id '${first.acceptance[0]!.id}' is already used by acceptance[0]`,
        path: `workItems[0].acceptance[${first.acceptance.length - 1}].id`,
      }])
    }
    expect(rowCounts(db)).toEqual(EMPTY_COUNTS)
    db.close()
  })

  it('a mid-transaction write failure rolls back every row', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const compiled = structuredClone(compileFromText(GOLDEN_PLAN_TEXT)) as unknown as {
      workItems: { id: string }[]
    }
    compiled.workItems[1]!.id = compiled.workItems[0]!.id

    expect(() => importPlanVersion(db, compiled as unknown as CompiledPlan)).toThrow(/UNIQUE constraint failed/)
    expect(rowCounts(db)).toEqual(EMPTY_COUNTS)
    db.close()
  })

  it('an impossible verifier variant hits the unreachable branch and rolls back', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const corrupted = structuredClone(compileFromText(GOLDEN_PLAN_TEXT)) as unknown as {
      workItems: { acceptance: { verifier: { kind: string } }[] }[]
    }
    corrupted.workItems[0]!.acceptance[0]!.verifier.kind = 'TELEPATHY'

    expect(() => importPlanVersion(db, corrupted as unknown as CompiledPlan))
      .toThrow('unreachable variant in plan verifier kind')
    expect(rowCounts(db)).toEqual(EMPTY_COUNTS)
    db.close()
  })

  it('options record source path, actor, and clock', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compileFromText(GOLDEN_PLAN_TEXT), {
      sourcePath: 'docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml',
      actorRef: 'agent/session-42',
      nowMs: 1_700_000_000_000,
    })

    expect(db.prepare('SELECT source_path, imported_at_ms FROM plan_imports').get()).toEqual({
      source_path: 'docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml',
      imported_at_ms: 1_700_000_000_000,
    })
    expect(db.prepare('SELECT DISTINCT actor_ref FROM project_events').get()).toEqual({ actor_ref: 'agent/session-42' })
    expect(db.prepare('SELECT DISTINCT created_at_ms FROM project_events').get())
      .toEqual({ created_at_ms: 1_700_000_000_000 })
    expect(db.prepare('SELECT DISTINCT created_at_ms, updated_at_ms FROM work_items').get()).toEqual({
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: 1_700_000_000_000,
    })
    db.close()
  })
})

describe('compilation for import', () => {
  it('binds hierarchy, backlog, baseline, and all five verifier seams', async () => {
    const document = syntheticDocument()
    const compiled = compileDocument(document, JSON.stringify(document))
    // Rows are ordered parents-first even though the document declares the
    // child first; equal-depth items keep document order.
    expect(compiled.workItems.map(workItem => workItem.stableKey)).toEqual(['ROOT', 'BACKLOG', 'CHILD'])
    const [root, backlog, child] = compiled.workItems
    expect(child?.parentWorkItemId).toBe(root?.id)
    expect(child?.phaseId).toBe('ph:plv:p2-plan:v1:PH1')
    expect(backlog?.phaseId).toBeUndefined()
    expect(backlog?.parentWorkItemId).toBeUndefined()
    expect(compiled.baselineRepoHead).toBe('abc1234')
    expect(compiled.baselineWorktreeHash).toBe('def5678')

    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compiled)

    const specs = db.prepare(
      'SELECT c.id, s.verifier_kind, s.command_text, s.expected_exit_code, s.query_text, s.expected_json, '
      + 's.owner_instruction, s.sandbox_required, s.approval_required '
      + 'FROM acceptance_criteria c JOIN verification_specs s ON s.criterion_id = c.id ORDER BY c.id',
    ).all() as Record<string, unknown>[]
    expect(specs).toEqual([
      {
        id: 'ac:wi:p2:BACKLOG:AC-SQL',
        verifier_kind: 'SQL_ASSERTION',
        command_text: null,
        expected_exit_code: null,
        query_text: 'SELECT 1',
        expected_json: '"one"',
        owner_instruction: null,
        sandbox_required: 1,
        approval_required: 0,
      },
      {
        id: 'ac:wi:p2:CHILD:AC-CMD',
        verifier_kind: 'COMMAND',
        command_text: 'echo ok',
        expected_exit_code: 0,
        query_text: null,
        expected_json: null,
        owner_instruction: null,
        sandbox_required: 0,
        approval_required: 1,
      },
      {
        id: 'ac:wi:p2:CHILD:AC-GRAPH',
        verifier_kind: 'GRAPH_ASSERTION',
        command_text: null,
        expected_exit_code: null,
        query_text: 'calls(compilePlan)',
        expected_json: '["importPlanVersion"]',
        owner_instruction: null,
        sandbox_required: 1,
        approval_required: 0,
      },
      {
        id: 'ac:wi:p2:CHILD:AC-SQL',
        verifier_kind: 'SQL_ASSERTION',
        command_text: null,
        expected_exit_code: null,
        query_text: 'SELECT COUNT(*) AS n FROM plans',
        expected_json: '{"rows":null}',
        owner_instruction: null,
        sandbox_required: 1,
        approval_required: 0,
      },
      {
        id: 'ac:wi:p2:ROOT:AC-OWNER',
        verifier_kind: 'OWNER_CONFIRMATION',
        command_text: null,
        expected_exit_code: null,
        query_text: null,
        expected_json: null,
        owner_instruction: 'Sign off on the design',
        sandbox_required: 1,
        approval_required: 0,
      },
    ])
    const workItemRows = db.prepare('SELECT stable_key, phase_id, parent_work_item_id FROM work_items')
      .all() as { stable_key: string; phase_id: string | null; parent_work_item_id: string | null }[]
    expect(Object.fromEntries(workItemRows.map(row => [row.stable_key, row]))).toMatchObject({
      CHILD: { phase_id: 'ph:plv:p2-plan:v1:PH1', parent_work_item_id: 'wi:p2:ROOT' },
      ROOT: { phase_id: 'ph:plv:p2-plan:v1:PH1', parent_work_item_id: null },
      BACKLOG: { phase_id: null, parent_work_item_id: null },
    })
    expect(db.prepare('SELECT baseline_repo_head, baseline_worktree_hash FROM plan_versions').get()).toEqual({
      baseline_repo_head: 'abc1234',
      baseline_worktree_hash: 'def5678',
    })
    db.close()
  })

  it('hashes the IR by content, not member order, and the source by exact text', () => {
    const document = syntheticDocument()
    const compiled = compileDocument(document, 'source-one')
    // Same members, different object key order (top level and baseline): the
    // canonical JSON sorts members, array order stays row-significant.
    const reordered = {
      relations: document.relations,
      workItems: document.workItems,
      phases: document.phases,
      plan: { ...document.plan, baseline: { worktreeHash: 'def5678', repoHead: 'abc1234' } },
      project: document.project,
      schemaVersion: 1,
    } as PlanDocumentV1
    const compiledReordered = compileDocument(reordered, 'source-one')

    expect(compiledReordered.compiledIrHash).toBe(compiled.compiledIrHash)
    expect(compileDocument(document, 'source-two').sourceDocumentHash)
      .toBe(createHash('sha256').update('source-two', 'utf8').digest('hex'))
    expect(compiled.sourceDocumentHash).toBe(createHash('sha256').update('source-one', 'utf8').digest('hex'))
  })

  it('stamps the same event envelope version as the SQLite store', () => {
    expect(PROJECT_EVENT_FORMAT_VERSION).toBe(STORE_EVENT_FORMAT_VERSION)
  })
})
