import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  BaselineDriftError,
  LeaseError,
  PlanActivationError,
  PlanSupersedeError,
  activatePlanVersion,
  appendProjectEvent,
  claimWorkItem,
  compilePlan,
  computeWorkReadiness,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  listAgentTodo,
  parsePlanDocument,
  readProjectEvents,
  recordBaselineDrift,
  releaseWorkLease,
  replayProjectEvents,
  supersedePlanVersion,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type PlanId,
  type PlanVersionId,
  type ProjectId,
  type WorkItemId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/**
 * A minimal plan that pins a baseline, so the drift writer exercises the
 * real compile-and-import path instead of hand-written rows.
 */
const DRIFT_PLAN_TEXT = `schemaVersion: 1
project:
  id: drift-proj
  name: Drift Proof
plan:
  id: drift-plan
  name: Drift Proof Plan
  version: 1
  baseline:
    repoHead: head-1
    worktreeHash: tree-1
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

const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_VERSION = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1')

/** Parse, validate, and compile the golden plan document. */
function compileGolden(): CompiledPlan {
  const { value } = parsePlanDocument(GOLDEN_PLAN_TEXT)
  return compilePlan(validatePlanSchema(value), { sourceText: GOLDEN_PLAN_TEXT })
}

/** Open a ledger holding the golden import (16 required events, sequences 1..16). */
async function goldenLedger(): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  importPlanVersion(db, compileGolden())
  return db
}

/** Open a ledger holding the baseline-pinned drift fixture (2 events, sequences 1..2). */
async function driftLedger(): Promise<DatabaseSync> {
  const db = await openProjectLedgerDatabase(':memory:')
  importPlanVersion(db, compilePlan(validatePlanSchema(parsePlanDocument(DRIFT_PLAN_TEXT).value), { sourceText: DRIFT_PLAN_TEXT }))
  return db
}

/** The ledger row id of a golden work item. */
function itemId(stableKey: string): WorkItemId {
  return brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`)
}

/** The ledger row id of a golden acceptance criterion. */
function criterionId(stableKey: string, criterion: string): AcceptanceCriterionId {
  return brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`)
}

/**
 * Make a golden item claimable through the causal rows: activate the version
 * through its writer, activate its phase, and satisfy the BLOCKS edges — the
 * phase and item moves are the seams of writers this package does not own.
 */
function makeClaimable(db: DatabaseSync, phaseKey: string): void {
  activatePlanVersion(db, GOLDEN_VERSION)
  db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', phaseKey)
  db.prepare('UPDATE work_items SET status = ? WHERE stable_key IN (?, ?)').run('DONE', 'OWNER-REVIEW-001', 'PRE-001')
}

/** The decoded payload of one project event. */
function eventPayload(db: DatabaseSync, sequenceNo: number): Record<string, unknown> {
  const row = db.prepare('SELECT payload_json FROM project_events WHERE sequence_no = ?')
    .get(sequenceNo) as { payload_json: string }
  return JSON.parse(row.payload_json) as Record<string, unknown>
}

/** Overwrite one event's payload — the seam of a hand-written log for replay rejection cases. */
function rewritePayload(db: DatabaseSync, sequenceNo: number, payload: Record<string, unknown>): void {
  db.prepare('UPDATE project_events SET payload_json = ? WHERE sequence_no = ?')
    .run(JSON.stringify(payload), sequenceNo)
}

function eventCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n
}

/** The materialized status of one golden work item. */
function itemStatus(db: DatabaseSync, stableKey: string): string {
  return (db.prepare('SELECT status FROM work_items WHERE stable_key = ?')
    .get(stableKey) as { status: string }).status
}

/**
 * Call a thunk and return the package error it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownError<T extends Error>(expected: new (...args: never[]) => T, call: () => unknown): T {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(expected)
    return error as T
  }
  expect.unreachable(`expected the call to throw ${expected.name}`)
}

describe('supersedePlanVersion', () => {
  it('retires an active version, freezes new claims, and queues live attempts for review', async () => {
    const db = await goldenLedger()
    try {
      makeClaimable(db, 'W01')
      // A historical evaluation and a live attempt exist before the supersede.
      evaluateAcceptanceCriterion(db, criterionId('OWNER-REVIEW-001', 'AC-OWNER-001'), 'PASS', { nowMs: 30 })
      const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker/session-9', {
        nowMs: 40,
        leaseConfig: { ttlMs: 100_000, heartbeatIntervalMs: 20_000 },
      })
      const before = db.prepare(
        'SELECT source_document_hash, compiled_ir_hash, baseline_repo_head, baseline_worktree_hash, created_at_ms FROM plan_versions WHERE id = ?',
      ).get(GOLDEN_VERSION) as Record<string, string | number | null>

      const supersede = supersedePlanVersion(db, GOLDEN_VERSION, { nowMs: 50 })
      expect(supersede).toEqual({
        planVersionId: GOLDEN_VERSION,
        planId: 'mini-dsh-v1.6a-ledger',
        succeededBy: undefined,
        policy: 'freeze-new-claims-and-review-active',
        supersededAtMs: 50,
        reviewAttempts: [{
          workItemId: 'wi:mini-dsh:SCHEMA-001',
          leaseId: claim.leaseId,
          workerIdentity: 'worker/session-9',
          expiresAtMs: claim.expiresAtMs,
        }],
        sequenceNo: 20,
      })
      expect(eventPayload(db, 20)).toEqual({
        planId: 'mini-dsh-v1.6a-ledger',
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        policy: 'freeze-new-claims-and-review-active',
        supersededAtMs: 50,
        reviewAttempts: [{
          workItemId: 'wi:mini-dsh:SCHEMA-001',
          leaseId: claim.leaseId,
          workerIdentity: 'worker/session-9',
          expiresAtMs: claim.expiresAtMs,
        }],
      })

      // Superseded versions remain queryable: the row, its immutable plan
      // facts, the replayed version entry, and the todo view all stay.
      const version = db.prepare('SELECT status, superseded_at_ms, current_version_id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?')
        .get(GOLDEN_VERSION) as { status: string; superseded_at_ms: number; current_version_id: string | null }
      expect(version).toEqual({ status: 'SUPERSEDED', superseded_at_ms: 50, current_version_id: null })
      const after = db.prepare(
        'SELECT source_document_hash, compiled_ir_hash, baseline_repo_head, baseline_worktree_hash, created_at_ms FROM plan_versions WHERE id = ?',
      ).get(GOLDEN_VERSION) as Record<string, string | number | null>
      expect(after).toEqual(before)
      const activatedAtMs = (db.prepare('SELECT activated_at_ms FROM plan_versions WHERE id = ?')
        .get(GOLDEN_VERSION) as { activated_at_ms: number }).activated_at_ms
      expect(replayProjectEvents(db, PROJECT).planVersions.get(GOLDEN_VERSION)).toEqual({
        planId: 'mini-dsh-v1.6a-ledger',
        versionNo: 1,
        sourceDocumentHash: before.source_document_hash,
        status: 'SUPERSEDED',
        activatedAtMs,
        supersededAtMs: 50,
      })
      expect(readProjectEvents(db, PROJECT)).toHaveLength(20)
      expect(listAgentTodo(db, PROJECT, { nowMs: 55 }).entries.map(entry => entry.stableKey)).toContain('SCHEMA-001')

      // New claims stop: readiness recomputes the version blocker.
      expect(computeWorkReadiness(db, itemId('DB-001'), { nowMs: 55 }).reasons[0]?.kind).toBe('plan-version-not-active')
      const denied = thrownError(LeaseError, () => claimWorkItem(db, itemId('DB-001'), 'worker/session-10', { nowMs: 55 }))
      expect(denied.code).toBe('work-not-ready')
      expect(denied.message).toContain('plan version "plv:mini-dsh-v1.6a-ledger:v1" is SUPERSEDED')

      // Active attempts require review: the attempt keeps its lease and its
      // version binding, and once it gives the lease up it lands BLOCKED —
      // never resurrected without an owner's rebind.
      expect(itemStatus(db, 'SCHEMA-001')).toBe('IN_PROGRESS')
      expect((db.prepare('SELECT plan_version_id FROM work_items WHERE stable_key = ?')
        .get('SCHEMA-001') as { plan_version_id: string }).plan_version_id).toBe('plv:mini-dsh-v1.6a-ledger:v1')
      releaseWorkLease(db, claim.leaseId, claim.leaseToken, { nowMs: 60 })
      expect(itemStatus(db, 'SCHEMA-001')).toBe('BLOCKED')
      expect(computeWorkReadiness(db, itemId('SCHEMA-001'), { nowMs: 65 }).reasons[0]?.kind)
        .toBe('plan-version-not-active')

      // Historical evaluations remain unchanged.
      const evaluations = db.prepare(
        'SELECT criterion_id, result, evaluated_by, evaluated_at_ms FROM acceptance_evaluations',
      ).all() as { criterion_id: string; result: string; evaluated_by: string; evaluated_at_ms: number }[]
      expect(evaluations).toEqual([{
        criterion_id: 'ac:wi:mini-dsh:OWNER-REVIEW-001:AC-OWNER-001',
        result: 'PASS',
        evaluated_by: 'dsh-experimental-project-ledger/acceptance',
        evaluated_at_ms: 30,
      }])
    } finally {
      db.close()
    }
  })

  it('rejects unknown versions, inactive versions, and foreign or unknown successors', async () => {
    const db = await goldenLedger()
    try {
      const unknown = thrownError(PlanSupersedeError, () =>
        supersedePlanVersion(db, brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v9')))
      expect(unknown.code).toBe('unknown-plan-version')
      expect(unknown.message).toContain('is not recorded in this ledger')

      const inactive = thrownError(PlanSupersedeError, () => supersedePlanVersion(db, GOLDEN_VERSION))
      expect(inactive.code).toBe('version-not-active')
      expect(inactive.message).toContain('is DRAFT; only an ACTIVE version can be superseded')

      makeClaimable(db, 'W01')
      const unknownSuccessor = thrownError(PlanSupersedeError, () =>
        supersedePlanVersion(db, GOLDEN_VERSION, { succeededBy: brandString<PlanVersionId>('plv:ghost:v1') }))
      expect(unknownSuccessor.code).toBe('unknown-successor')
      expect(unknownSuccessor.message).toContain('plv:ghost:v1" named as the successor is not recorded')

      db.prepare(
        "INSERT INTO plans (id, project_id, name, current_version_id, created_at_ms) VALUES ('other-plan', 'mini-dsh', 'Other', NULL, 5)",
      ).run()
      db.prepare(
        'INSERT INTO plan_versions (id, plan_id, version_no, status, baseline_repo_head, baseline_worktree_hash, '
        + "source_document_hash, compiled_ir_hash, created_at_ms) VALUES ('plv:other-plan:v1', 'other-plan', 1, 'DRAFT', "
        + "NULL, NULL, 'sha-a', 'sha-b', 5)",
      ).run()
      const foreign = thrownError(PlanSupersedeError, () =>
        supersedePlanVersion(db, GOLDEN_VERSION, { succeededBy: brandString<PlanVersionId>('plv:other-plan:v1') }))
      expect(foreign.code).toBe('successor-not-same-plan')
      expect(foreign.message).toContain('a successor must continue plan "mini-dsh-v1.6a-ledger"')
      expect(eventCount(db)).toBe(17)
    } finally {
      db.close()
    }
  })

  it('names the successor and repoints the plan pointer when it named the retired version', async () => {
    const db = await goldenLedger()
    try {
      makeClaimable(db, 'W01')
      const successor = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v2')
      db.prepare(
        'INSERT INTO plan_versions (id, plan_id, version_no, status, baseline_repo_head, baseline_worktree_hash, '
        + "source_document_hash, compiled_ir_hash, created_at_ms) VALUES (?, 'mini-dsh-v1.6a-ledger', 2, 'DRAFT', "
        + "NULL, NULL, 'sha-c', 'sha-d', 6)",
      ).run(successor)

      const supersede = supersedePlanVersion(db, GOLDEN_VERSION, { succeededBy: successor, nowMs: 50 })
      expect(supersede.succeededBy).toBe(successor)
      expect(supersede.reviewAttempts).toEqual([])
      expect(eventPayload(db, 18).succeededBy).toBe('plv:mini-dsh-v1.6a-ledger:v2')
      expect((db.prepare('SELECT current_version_id FROM plans').get() as { current_version_id: string }).current_version_id)
        .toBe('plv:mini-dsh-v1.6a-ledger:v2')
      expect(replayProjectEvents(db, PROJECT).planVersions.size).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe('activatePlanVersion', () => {
  it('activates a DRAFT version: status, stamp, pointer, and the required event in one transaction', async () => {
    const db = await goldenLedger()
    try {
      const activation = activatePlanVersion(db, GOLDEN_VERSION, { nowMs: 20 })
      expect(activation).toEqual({
        planVersionId: GOLDEN_VERSION,
        planId: 'mini-dsh-v1.6a-ledger',
        activatedAtMs: 20,
        sequenceNo: 17,
      })
      expect(eventPayload(db, 17)).toEqual({
        planId: 'mini-dsh-v1.6a-ledger',
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        activatedAtMs: 20,
      })
      expect(db.prepare('SELECT status, activated_at_ms, superseded_at_ms FROM plan_versions WHERE id = ?')
        .get(GOLDEN_VERSION)).toEqual({ status: 'ACTIVE', activated_at_ms: 20, superseded_at_ms: null })
      expect((db.prepare('SELECT current_version_id FROM plans').get() as { current_version_id: string }).current_version_id)
        .toBe('plv:mini-dsh-v1.6a-ledger:v1')
      const sourceHash = (db.prepare('SELECT source_document_hash FROM plan_versions WHERE id = ?')
        .get(GOLDEN_VERSION) as { source_document_hash: string }).source_document_hash
      const replayed = replayProjectEvents(db, PROJECT)
      expect(replayed.planVersions.get(GOLDEN_VERSION)).toEqual({
        planId: 'mini-dsh-v1.6a-ledger',
        versionNo: 1,
        sourceDocumentHash: sourceHash,
        status: 'ACTIVE',
        activatedAtMs: 20,
        supersededAtMs: undefined,
      })
      expect(replayed.currentPlanVersions.get(brandString<PlanId>('mini-dsh-v1.6a-ledger'))).toBe(GOLDEN_VERSION)
    } finally {
      db.close()
    }
  })

  it('rejects unknown versions, unimported versions, a second ACTIVE version, and non-DRAFT states', async () => {
    const db = await goldenLedger()
    try {
      const unknown = thrownError(PlanActivationError, () =>
        activatePlanVersion(db, brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v9')))
      expect(unknown.code).toBe('unknown-plan-version')
      expect(unknown.message).toContain('is not recorded in this ledger')

      // A hand-inserted version row carries no plan_imports record: the
      // activation seam refuses versions that never entered through the
      // supported importer.
      db.prepare(
        'INSERT INTO plan_versions (id, plan_id, version_no, status, baseline_repo_head, baseline_worktree_hash, '
        + "source_document_hash, compiled_ir_hash, created_at_ms) VALUES ('plv:mini-dsh-v1.6a-ledger:v2', "
        + "'mini-dsh-v1.6a-ledger', 2, 'DRAFT', NULL, NULL, 'sha-c', 'sha-d', 6)",
      ).run()
      const unimported = thrownError(PlanActivationError, () =>
        activatePlanVersion(db, brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v2')))
      expect(unimported.code).toBe('import-record-missing')
      expect(unimported.message).toContain('records no plan_imports row')
      db.prepare(
        'INSERT INTO plan_imports (id, project_id, source_path, source_hash, schema_version, parser_version, '
        + 'compiler_version, status, plan_version_id, imported_at_ms) '
        + "VALUES ('imp:plv:mini-dsh-v1.6a-ledger:v2', 'mini-dsh', NULL, 'sha-c', 1, '1', '1', 'IMPORTED', "
        + "'plv:mini-dsh-v1.6a-ledger:v2', 6)",
      ).run()

      expect(activatePlanVersion(db, GOLDEN_VERSION, { nowMs: 20 }).sequenceNo).toBe(17)
      const second = thrownError(PlanActivationError, () =>
        activatePlanVersion(db, brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v2'), { nowMs: 21 }))
      expect(second.code).toBe('active-version-exists')
      expect(second.message).toContain('already has an ACTIVE version (plv:mini-dsh-v1.6a-ledger:v1)')

      const again = thrownError(PlanActivationError, () => activatePlanVersion(db, GOLDEN_VERSION, { nowMs: 22 }))
      expect(again.code).toBe('version-not-draft')
      expect(again.message).toContain('is ACTIVE; only a DRAFT version activates')
      expect(eventCount(db)).toBe(17)
    } finally {
      db.close()
    }
  })
})

describe('recordBaselineDrift', () => {
  it('records the drift, blocks the next claim, and never rewrites the pin', async () => {
    const db = await driftLedger()
    try {
      activatePlanVersion(db, brandString<PlanVersionId>('plv:drift-plan:v1'))
      const work = brandString<WorkItemId>('wi:drift-proj:WORK-001')
      const drift = recordBaselineDrift(db, work, { repoHead: 'head-2', worktreeHash: null }, { nowMs: 20 })
      expect(drift).toEqual({
        driftId: 'dr:wi:drift-proj:WORK-001:4',
        workItemId: 'wi:drift-proj:WORK-001',
        planVersionId: 'plv:drift-plan:v1',
        baselineRepoHead: 'head-1',
        baselineWorktreeHash: 'tree-1',
        observedRepoHead: 'head-2',
        observedWorktreeHash: null,
        detectedAtMs: 20,
        sequenceNo: 4,
      })
      expect(eventPayload(db, 4)).toEqual({
        workItemId: 'wi:drift-proj:WORK-001',
        planVersionId: 'plv:drift-plan:v1',
        blockerId: 'dr:wi:drift-proj:WORK-001:4',
        baselineRepoHead: 'head-1',
        baselineWorktreeHash: 'tree-1',
        observedRepoHead: 'head-2',
        observedWorktreeHash: null,
      })
      expect(readProjectEvents(db, brandString<ProjectId>('drift-proj'))[3]).toMatchObject({
        eventType: 'baseline/drift-detected',
        entityType: 'work_external_blocker',
        entityId: 'dr:wi:drift-proj:WORK-001:4',
      })
      expect(db.prepare('SELECT blocker_kind, status, external_ref FROM work_external_blockers WHERE id = ?')
        .get(drift.driftId)).toEqual({ blocker_kind: 'BASELINE_DRIFT', status: 'OPEN', external_ref: 'head-2' })

      const readiness = computeWorkReadiness(db, work, { nowMs: 25 })
      expect(readiness.reasons[0]?.kind).toBe('external-blocker-open')
      expect(readiness.reasons[0]?.refId).toBe('dr:wi:drift-proj:WORK-001:4')
      const denied = thrownError(LeaseError, () => claimWorkItem(db, work, 'worker/session-9', { nowMs: 25 }))
      expect(denied.code).toBe('work-not-ready')
      expect(denied.message).toContain('external blocker "dr:wi:drift-proj:WORK-001:4"')

      // The pin is immutable: the version keeps its original baseline.
      expect(db.prepare('SELECT baseline_repo_head, baseline_worktree_hash FROM plan_versions WHERE id = ?')
        .get('plv:drift-plan:v1')).toEqual({ baseline_repo_head: 'head-1', baseline_worktree_hash: 'tree-1' })
    } finally {
      db.close()
    }
  })

  it('rejects unknown items, unplanned items, unpinned baselines, and unchanged facts', async () => {
    const db = await goldenLedger()
    try {
      const unknown = thrownError(BaselineDriftError, () =>
        recordBaselineDrift(db, brandString<WorkItemId>('wi:mini-dsh:NOPE'), { repoHead: 'head-2', worktreeHash: null }))
      expect(unknown.code).toBe('unknown-work-item')

      db.prepare('UPDATE work_items SET plan_version_id = NULL WHERE stable_key = ?').run('SCHEMA-001')
      const unplanned = thrownError(BaselineDriftError, () =>
        recordBaselineDrift(db, itemId('SCHEMA-001'), { repoHead: 'head-2', worktreeHash: null }))
      expect(unplanned.code).toBe('work-item-unplanned')
      db.prepare('UPDATE work_items SET plan_version_id = ? WHERE stable_key = ?').run('plv:mini-dsh-v1.6a-ledger:v1', 'SCHEMA-001')

      const unpinned = thrownError(BaselineDriftError, () =>
        recordBaselineDrift(db, itemId('SCHEMA-001'), { repoHead: 'head-2', worktreeHash: null }))
      expect(unpinned.code).toBe('baseline-unpinned')
      expect(unpinned.message).toContain('pins no baseline; an unpinned version cannot drift')
      expect(eventCount(db)).toBe(16)

      const driftDb = await driftLedger()
      try {
        const unchanged = thrownError(BaselineDriftError, () =>
          recordBaselineDrift(
            driftDb,
            brandString<WorkItemId>('wi:drift-proj:WORK-001'),
            { repoHead: 'head-1', worktreeHash: 'tree-1' },
          ))
        expect(unchanged.code).toBe('baseline-unchanged')
        expect(unchanged.message).toContain('equal the baseline pinned by plan version "plv:drift-plan:v1"')
        expect(eventCount(driftDb)).toBe(2)
      } finally {
        driftDb.close()
      }
    } finally {
      db.close()
    }
  })
})

describe('recordBaselineDrift against partially pinned baselines', () => {
  it('drifts when only one pin moved, rendering absent facts as none', async () => {
    const headless = await driftLedger()
    try {
      headless.prepare('UPDATE plan_versions SET baseline_repo_head = NULL').run()
      activatePlanVersion(headless, brandString<PlanVersionId>('plv:drift-plan:v1'))
      const drift = recordBaselineDrift(
        headless,
        brandString<WorkItemId>('wi:drift-proj:WORK-001'),
        { repoHead: null, worktreeHash: 'tree-2' },
        { nowMs: 20 },
      )
      expect(drift.baselineRepoHead).toBe(null)
      expect(drift.observedRepoHead).toBe(null)
      const detail = (headless.prepare('SELECT detail FROM work_external_blockers WHERE id = ?')
        .get(drift.driftId) as { detail: string }).detail
      expect(detail).toContain('pinned head none')
      expect(detail).toContain('observed head none')
    } finally {
      headless.close()
    }

    const treeless = await driftLedger()
    try {
      treeless.prepare('UPDATE plan_versions SET baseline_worktree_hash = NULL').run()
      activatePlanVersion(treeless, brandString<PlanVersionId>('plv:drift-plan:v1'))
      const drift = recordBaselineDrift(
        treeless,
        brandString<WorkItemId>('wi:drift-proj:WORK-001'),
        { repoHead: 'head-2', worktreeHash: null },
        { nowMs: 20 },
      )
      expect(drift.baselineWorktreeHash).toBe(null)
      expect(drift.observedWorktreeHash).toBe(null)
    } finally {
      treeless.close()
    }
  })
})

describe('replaying supersede and drift events', () => {
  /** A golden ledger with an active version superseded at event 18. */
  async function supersededLedger(): Promise<{ db: DatabaseSync; base: Record<string, unknown> }> {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    supersedePlanVersion(db, GOLDEN_VERSION, { nowMs: 50 })
    return { db, base: eventPayload(db, 18) }
  }

  it('accepts the recorded events and fails closed on unreadable supersede payloads', async () => {
    const clean = await supersededLedger()
    try {
      expect(replayProjectEvents(clean.db, PROJECT).planVersions.size).toBe(1)
    } finally {
      clean.db.close()
    }

    const transforms: readonly ((base: Record<string, unknown>) => Record<string, unknown>)[] = [
      base => ({ ...base, planVersionId: 'plv:ghost:v1' }),
      base => ({ ...base, planId: 'wrong-plan' }),
      base => ({ ...base, policy: 'ship-it' }),
      base => ({ ...base, reviewAttempts: 'nope' }),
      base => ({ ...base, reviewAttempts: [3] }),
      (base) => {
        const withoutStamp = { ...base }
        delete withoutStamp.supersededAtMs
        return withoutStamp
      },
      base => ({ ...base, succeededBy: 5 }),
    ]
    const expected: readonly RegExp[] = [
      /names no replayed plan version \(plv:ghost:v1\)/,
      /names plan "wrong-plan", but version "plv:mini-dsh-v1\.6a-ledger:v1" belongs to plan "mini-dsh-v1\.6a-ledger"/,
      /is not the supersede policy: "ship-it"/,
      /field "reviewAttempts" must be an array/,
      /field "reviewAttempts\[0\]" must be an object/,
      /field "supersededAtMs" must be a number/,
      /field "succeededBy" must be a string/,
    ]
    for (let index = 0; index < transforms.length; index += 1) {
      const transform = transforms[index]
      const pattern = expected[index]
      if (transform === undefined || pattern === undefined) throw new Error('unreachable case row')
      const { db, base } = await supersededLedger()
      try {
        rewritePayload(db, 18, transform(base))
        expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message, `case ${index}`)
          .toMatch(pattern)
      } finally {
        db.close()
      }
    }
  })

  it('fails closed when a version retires twice or a drift names no replayed item', async () => {
    const duplicate = await supersededLedger()
    try {
      const recorded = eventPayload(duplicate.db, 18)
      appendProjectEvent(
        duplicate.db,
        PROJECT,
        'plan/version-superseded',
        { ...recorded, supersededAtMs: 60 },
        { entityType: 'plan_version', entityId: 'plv:mini-dsh-v1.6a-ledger:v1', nowMs: 60 },
      )
      expect(thrownError(Error, () => replayProjectEvents(duplicate.db, PROJECT)).message)
        .toContain('supersedes plan version "plv:mini-dsh-v1.6a-ledger:v1" twice in this timeline')
    } finally {
      duplicate.db.close()
    }

    const driftDb = await driftLedger()
    try {
      const work = brandString<WorkItemId>('wi:drift-proj:WORK-001')
      recordBaselineDrift(driftDb, work, { repoHead: 'head-2', worktreeHash: null }, { nowMs: 20 })
      expect(replayProjectEvents(driftDb, brandString<ProjectId>('drift-proj')).workItems.size).toBe(1)
      const base = eventPayload(driftDb, 3)
      rewritePayload(driftDb, 3, { ...base, workItemId: 'wi:drift-proj:GONE' })
      expect(thrownError(Error, () => replayProjectEvents(driftDb, brandString<ProjectId>('drift-proj'))).message)
        .toContain('names no replayed work item (wi:drift-proj:GONE)')

      const numeric = await driftLedger()
      try {
        recordBaselineDrift(numeric, work, { repoHead: 'head-2', worktreeHash: null }, { nowMs: 20 })
        rewritePayload(numeric, 3, { ...eventPayload(numeric, 3), observedRepoHead: 5 })
        expect(thrownError(Error, () => replayProjectEvents(numeric, brandString<ProjectId>('drift-proj'))).message)
          .toContain('field "observedRepoHead" must be a string or null')
      } finally {
        numeric.close()
      }
    } finally {
      driftDb.close()
    }
  })
})
