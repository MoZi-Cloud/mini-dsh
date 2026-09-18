/** The plan directory read seam: which plans a ledger records, and their current-version pointer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import { compilePlan, importPlanVersion, listPlans, parsePlanDocument, validatePlanSchema, type CompiledPlan } from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/**
 * A second plan in a different project, so the directory lists more than
 * one row through the real compile-and-import path instead of hand-written
 * rows.
 */
const SECOND_PLAN_TEXT = `schemaVersion: 1
project:
  id: directory-proj
  name: Directory Proof
plan:
  id: directory-plan
  name: Directory Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: WORK-001
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the work
    priority: 10
    status: READY
    acceptance:
      - id: AC-WORK-001
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations: []
`

/** Parse, validate, and compile a plan document. */
function compilePlanText(text: string): CompiledPlan {
  const { value } = parsePlanDocument(text)
  return compilePlan(validatePlanSchema(value), { sourceText: text })
}

describe('listPlans()', () => {
  it('lists nothing from a ledger with no plan', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    expect(listPlans(db)).toEqual([])
  })

  it('lists the imported plan with no current version named yet', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const compiled = compilePlanText(GOLDEN_PLAN_TEXT)
    const { planVersionId } = importPlanVersion(db, compiled)
    expect(listPlans(db)).toEqual([{
      planId: compiled.planId,
      projectId: compiled.projectId,
      name: compiled.planName,
      currentVersionId: null,
    }])
    expect(planVersionId).toBeDefined()
  })

  it('orders entries by project then plan and exposes the current-version pointer', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
    const { planVersionId } = importPlanVersion(db, compilePlanText(SECOND_PLAN_TEXT))
    // Naming the current version is an owner seam without an exported
    // writer (v1.6a §5), so the directory test sets the pointer the same
    // way the pinned-fixture generator does.
    db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run(planVersionId, 'directory-plan')
    expect(listPlans(db)).toEqual([
      {
        planId: 'directory-plan',
        projectId: 'directory-proj',
        name: 'Directory Proof Plan',
        currentVersionId: planVersionId,
      },
      {
        planId: 'mini-dsh-v1.6a-ledger',
        projectId: 'mini-dsh',
        name: 'Plan-as-Data Ledger Core',
        currentVersionId: null,
      },
    ])
  })
})
