/**
 * Authority boundaries of the v1.6a Ledger Core (§4-§6, AC-INTEGRATE-002):
 * the agent loop, plan mode, and the session todo tool stay structurally
 * decoupled from Project Ledger; a plan document reaches the ledger only
 * through the explicit validated compile-and-import seam; and acceptance is
 * the only authority that completes a work item, so a session todo can never
 * shortcut project work to `DONE`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  AcceptanceEvaluationError,
  PLAN_WORK_ITEM_STATUSES,
  WorkStatusError,
  changeWorkStatus,
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type PlanWorkItemStatus,
  type WorkItemId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/** The ledger row id of a golden work item. */
function itemId(stableKey: string): WorkItemId {
  return brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`)
}

/** The ledger row id of one golden acceptance criterion. */
function criterionId(stableKey: string, criterion: string): AcceptanceCriterionId {
  return brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`)
}

/** Parse, validate, and compile the golden plan document. */
function compileGolden(): CompiledPlan {
  const { value } = parsePlanDocument(GOLDEN_PLAN_TEXT)
  return compilePlan(validatePlanSchema(value), { sourceText: GOLDEN_PLAN_TEXT })
}

/** Overwrite a work item status directly — the seam of writers this package does not own. */
function setItemStatus(db: DatabaseSync, stableKey: string, status: PlanWorkItemStatus): void {
  db.prepare('UPDATE work_items SET status = ? WHERE stable_key = ?').run(status, stableKey)
}

/** Row counts across every ledger table, for the nothing-mounted assertions. */
function mountedRowCounts(db: DatabaseSync): Record<string, number> {
  const tables = [
    'plans',
    'plan_versions',
    'phases',
    'work_items',
    'work_item_relations',
    'acceptance_criteria',
    'verification_specs',
    'plan_imports',
    'project_events',
  ]
  return Object.fromEntries(tables.map(table => [
    table,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  ]))
}

const EMPTY_MOUNT = {
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

describe('structural decoupling', () => {
  it('couples no harness package into the ledger except the mini bundle mount', () => {
    for (const dir of ['packages/core/agent-loop', 'packages/core/agent', 'packages/plan/plan-mode', 'packages/todo/tool-todo']) {
      const manifest = JSON.parse(readFileSync(`${REPO_ROOT}/${dir}/package.json`, 'utf8')) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      const ledgerDeps = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
        .filter(name => name.startsWith('@deepseek-ai/dsh-experimental-project-ledger'))
      expect(ledgerDeps).toEqual([])
    }

    // The ledger itself carries no harness runtime dependency: it cannot
    // reach the loop, plan mode, or the todo tool even by accident.
    const ledger = JSON.parse(readFileSync(`${REPO_ROOT}/packages/experimental/project-ledger/package.json`, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(ledger.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-util-values',
      'yaml',
      'zod',
    ])
  })

  it('mounts the ledger only through an experimental bundle outside the default product', () => {
    // The default installation ships no mini template: the ledger is a
    // v1.6a experimental capability (§6), and the default-product isolation
    // gate refuses experimental packages in shipped compositions (§4 keeps
    // `dsh --profile mini` the only launch form regardless).
    expect(PROFILE_TEMPLATES.mini).toBeUndefined()

    // The mount itself is an experimental profile bundle: no bin, one patch,
    // and the ledger store as its payload.
    const root = `${REPO_ROOT}/packages/experimental/mini-profile`
    const bundle = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      name?: string
      bin?: unknown
      dependencies?: Record<string, string>
    }
    expect(bundle.name).toBe('@deepseek-ai/dsh-experimental-mini-profile')
    expect(bundle.bin).toBeUndefined()
    expect(bundle.dependencies?.['@deepseek-ai/dsh-experimental-project-ledger']).toBe('workspace:^')
    expect(bundle.dependencies?.['@deepseek-ai/dsh-experimental-project-ledger-sqlite']).toBe('workspace:^')
    const patch = readFileSync(`${root}/cordis.patch.yml`, 'utf8')
    expect(patch).toContain('id: project-ledger')
    expect(patch).toContain("name: '@deepseek-ai/dsh-experimental-mini-profile'")
  })
})

describe('the plan-mode and ledger seam', () => {
  it('mounts a plan only through the explicit validated compile-and-import step', async () => {
    const db = await openProjectLedgerDatabase(':memory:')

    // Parsing, schema validation, semantics, and compilation are pure: no
    // ledger handle exists, and compiling twice agrees on the canonical IR.
    const compiled = compileGolden()
    const again = compileGolden()
    expect(again.compiledIrHash).toBe(compiled.compiledIrHash)
    expect(mountedRowCounts(db)).toEqual(EMPTY_MOUNT)

    // The import is the single mounting step.
    importPlanVersion(db, compiled)
    expect(mountedRowCounts(db)).toEqual({
      ...EMPTY_MOUNT,
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

    // A mounted version is immutable: later edits to the plan document never
    // overwrite it — the same version with new content is a conflict.
    const edited = GOLDEN_PLAN_TEXT.replace(
      'title: Put v1.4/v1.5 design history and v1.6a fixtures in-repo',
      'title: Rewritten draft title',
    )
    const { value: editedValue } = parsePlanDocument(edited)
    const editedCompile = compilePlan(validatePlanSchema(editedValue), { sourceText: edited })
    expect(() => importPlanVersion(db, editedCompile)).toThrow(
      'plan "mini-dsh-v1.6a-ledger" already records version 1 from different source content '
        + '(plv:mini-dsh-v1.6a-ledger:v1); bump plan.version and re-import',
    )
    expect(mountedRowCounts(db)).toEqual({
      ...EMPTY_MOUNT,
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
    expect(db.prepare("SELECT title FROM work_items WHERE stable_key = 'PRE-001'").get())
      .toEqual({ title: 'Put v1.4/v1.5 design history and v1.6a fixtures in-repo' })
    db.close()
  })
})

describe('the todo and completion authority seam', () => {
  it('closes DONE to every status but VERIFYING', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compileGolden())
    for (const status of PLAN_WORK_ITEM_STATUSES) {
      if (status === 'VERIFYING') continue
      setItemStatus(db, 'PRE-001', status)
      const thrown = thrownError(WorkStatusError, () => changeWorkStatus(db, itemId('PRE-001'), 'DONE'))
      expect(thrown.code).toBe('transition-not-allowed')
      expect(eventCount(db)).toBe(16)
    }
    db.close()
  })

  it('completes a VERIFYING item only when required acceptance has passed or been waived', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compileGolden())
    const target = itemId('PRE-001')
    const criterion = criterionId('PRE-001', 'AC-PRE-001')

    setItemStatus(db, 'PRE-001', 'IN_PROGRESS')
    changeWorkStatus(db, target, 'VERIFYING')

    // An unevaluated criterion has not passed: completion is refused.
    const pending = thrownError(WorkStatusError, () => changeWorkStatus(db, target, 'DONE'))
    expect(pending.code).toBe('acceptance-not-passed')
    expect(pending.message).toBe(
      `work item "${target}" cannot complete while required acceptance is outstanding: `
        + `"${criterion}" is PENDING`,
    )

    // A failed or blocked criterion refuses completion through the same gate.
    evaluateAcceptanceCriterion(db, criterion, 'FAIL')
    const failing = thrownError(WorkStatusError, () => changeWorkStatus(db, target, 'DONE'))
    expect(failing.code).toBe('acceptance-not-passed')
    expect(failing.message).toBe(
      `work item "${target}" cannot complete while required acceptance is outstanding: `
        + `"${criterion}" is FAILING`,
    )
    const waived = evaluateAcceptanceCriterion(db, criterion, 'WAIVED')
    expect(waived.status).toBe('WAIVED')
    changeWorkStatus(db, target, 'DONE')
    expect(db.prepare('SELECT status FROM work_items WHERE id = ?').get(target)).toEqual({ status: 'DONE' })

    // Unknown criteria cannot gate-crash the writer: the rejection rolls back
    // and the item stays VERIFYING.
    setItemStatus(db, 'PRE-002', 'IN_PROGRESS')
    changeWorkStatus(db, itemId('PRE-002'), 'VERIFYING')
    const unknown = thrownError(
      AcceptanceEvaluationError,
      () => evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:PRE-002:NOPE'), 'PASS'),
    )
    expect(unknown.code).toBe('unknown-criterion')
    expect(db.prepare('SELECT status FROM work_items WHERE stable_key = ?').get('PRE-002'))
      .toEqual({ status: 'VERIFYING' })
    db.close()
  })
})

/** Call a thunk and return the package error it threw; any other outcome fails the test. */
function thrownError<T extends Error>(expected: new (...args: never[]) => T, call: () => unknown): T {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(expected)
    return error as T
  }
  expect.unreachable(`expected the call to throw ${expected.name}`)
}

function eventCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n
}
