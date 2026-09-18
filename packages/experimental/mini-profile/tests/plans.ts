/**
 * Plan fixtures and seeding helpers shared by the mini-profile specs: the
 * pinned v1.6a golden plan, a multi-project proof with claimable and blocked
 * work, a single-project unphased proof, an owner-gated acceptance proof, and
 * a dual-observable-criterion proof for per-criterion report verdicts.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import {
  compilePlan,
  importPlanVersion,
  parsePlanDocument,
  validatePlanSchema,
} from '@deepseek-ai/dsh-experimental-project-ledger'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** The pinned v1.6a golden plan document. */
export const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/**
 * A second project whose owner work carries a blocking relation and whose
 * one agent item is claimable, so a surface covers blocked readiness, live
 * leases, and claims through real writers.
 */
export const TINY_PLAN_TEXT = `schemaVersion: 1
project:
  id: tiny-proj
  name: Tiny Proof
plan:
  id: tiny-plan
  name: Tiny Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: OWNER-A
    phaseId: P0
    type: REVIEW
    executorKind: OWNER
    title: Review the first thing
    priority: 50
    status: READY
    acceptance:
      - id: AC-OWNER-A
        kind: OWNER_CONFIRMATION
        description: Owner accepts the first thing.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm the first thing.
  - id: OWNER-B
    phaseId: P0
    type: REVIEW
    executorKind: OWNER
    title: Review the second thing
    priority: 40
    status: READY
    acceptance:
      - id: AC-OWNER-B
        kind: OWNER_CONFIRMATION
        description: Owner accepts the second thing.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm the second thing.
  - id: AGENT-FREE
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the free work
    priority: 30
    status: READY
    acceptance:
      - id: AC-AGENT-FREE
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations:
  - from: OWNER-A
    to: OWNER-B
    kind: BLOCKS
`

/** A single-project plan with only unphased agent work, covering empty owner views and phase-less rendering. */
export const SOLO_PLAN_TEXT = `schemaVersion: 1
project:
  id: solo-proj
  name: Solo Proof
plan:
  id: solo-plan
  name: Solo Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: AGENT-ONLY
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the solo work
    priority: 20
    status: READY
    acceptance:
      - id: AC-AGENT-ONLY
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

/**
 * A project whose only agent item completes through an OWNER_CONFIRMATION
 * criterion, covering the report path that may never write the owner's
 * evaluation and the VERIFYING state that waits for it.
 */
export const GATED_PLAN_TEXT = `schemaVersion: 1
project:
  id: gated-proj
  name: Gated Proof
plan:
  id: gated-plan
  name: Gated Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: AGENT-GATED
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the gated work
    priority: 10
    status: READY
    acceptance:
      - id: AC-GATED-OWNER
        kind: OWNER_CONFIRMATION
        description: Owner accepts the gated work.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm the gated work.
relations: []
`

/**
 * A project whose only agent item carries two observable TEST criteria beside
 * an owner confirmation, covering per-criterion verdicts, mixed outcomes, and
 * the report path that covers the observable criteria without touching the
 * owner's.
 */
export const DUAL_PLAN_TEXT = `schemaVersion: 1
project:
  id: dual-proj
  name: Dual Proof
plan:
  id: dual-plan
  name: Dual Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: AGENT-DUAL
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the dual work
    priority: 10
    status: READY
    acceptance:
      - id: AC-DUAL-A
        kind: TEST
        description: The first suite works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
      - id: AC-DUAL-B
        kind: TEST
        description: The second suite works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
      - id: AC-DUAL-OWNER
        kind: OWNER_CONFIRMATION
        description: Owner accepts the dual work.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm the dual work.
relations: []
`

/**
 * Parse, validate, and compile one plan document.
 * @param text - the plan document source.
 * @returns the compiled canonical IR.
 */
export function compilePlanText(text: string): ReturnType<typeof compilePlan> {
  const { value } = parsePlanDocument(text)
  return compilePlan(validatePlanSchema(value), { sourceText: text })
}

/**
 * Import one plan document and activate its version, so claims against it
 * are legal.
 * @param db - open ledger database.
 * @param text - the plan document source.
 */
export function seedActivePlan(db: DatabaseSync, text: string): void {
  const { planVersionId } = importPlanVersion(db, compilePlanText(text))
  // Activation is an owner seam without an exported writer (v1.6a §5); specs
  // set it the same way the pinned-fixture generator does.
  db.prepare("UPDATE plan_versions SET status = 'ACTIVE', activated_at_ms = ? WHERE id = ?").run(1_000, planVersionId)
}
