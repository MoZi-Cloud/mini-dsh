import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  PlanDoctorError,
  activatePlanVersion,
  claimWorkItem,
  compilePlan,
  evaluateAcceptanceCriterion,
  changeWorkStatus,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  releaseWorkLease,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type PlanVersionId,
  type WorkItemId,
  type WorkLeaseClaim,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

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

/**
 * Open the golden ledger, drive its W01 entry items DONE through the real
 * writers — releasing each claim, as the shipped tools do around delivery —
 * and claim SCHEMA-001, the item their completion readies.
 */
async function claimGoldenSchemaItem(): Promise<{ db: DatabaseSync; claim: WorkLeaseClaim }> {
  const db = await goldenLedger()
  // Activation runs through its writer; the phase state has no writer and
  // the DONE moves go through the real writers so replay parity holds.
  activatePlanVersion(db, GOLDEN_VERSION)
  db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W01')
  for (const [stableKey, criterion] of [['OWNER-REVIEW-001', 'AC-OWNER-001'], ['PRE-001', 'AC-PRE-001']] as const) {
    const id = brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`)
    const claim = claimWorkItem(db, id, 'doctor/agent', { nowMs: 30 })
    changeWorkStatus(db, id, 'VERIFYING', { nowMs: 32, actorRef: 'doctor/agent' })
    releaseWorkLease(db, claim.leaseId, claim.leaseToken, { nowMs: 33, actorRef: 'doctor/agent' })
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`),
      'WAIVED',
      { nowMs: 34, evaluatedBy: 'doctor/agent' },
    )
    changeWorkStatus(db, id, 'DONE', { nowMs: 36, actorRef: 'doctor/agent' })
  }
  const claim = claimWorkItem(db, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'doctor/agent', { nowMs: 40 })
  return { db, claim }
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

describe('planDoctor', () => {
  it('reports zero issues for the golden import, before and after activation (BOOT-01)', async () => {
    const db = await goldenLedger()
    try {
      const expected = {
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        planId: 'mini-dsh-v1.6a-ledger',
        versionNo: 1,
        status: 'DRAFT',
        projectId: 'mini-dsh',
        databaseUserVersion: 9,
        eventFormatVersion: 10,
        baselineRepoHead: null,
        baselineWorktreeHash: null,
        counts: { phases: 13, workItems: 15, relations: 14, criteria: 16, events: 16 },
        issues: [],
      }
      expect(planDoctor(db, GOLDEN_VERSION)).toEqual(expected)
      activatePlanVersion(db, GOLDEN_VERSION)
      expect(planDoctor(db, GOLDEN_VERSION)).toEqual({
        ...expected,
        status: 'ACTIVE',
        counts: { phases: 13, workItems: 15, relations: 14, criteria: 16, events: 17 },
      })
    } finally {
      db.close()
    }
  })

  it('stays clean across a full real work loop and fails loud on an unknown version', async () => {
    const { db, claim } = await claimGoldenSchemaItem()
    try {
      const id = brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001')
      changeWorkStatus(db, id, 'VERIFYING', { nowMs: 45, actorRef: 'doctor/agent' })
      releaseWorkLease(db, claim.leaseId, claim.leaseToken, { nowMs: 46, actorRef: 'doctor/agent' })
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001'),
        'PASS',
        { nowMs: 50, evaluatedBy: 'doctor/agent' },
      )
      changeWorkStatus(db, id, 'DONE', { nowMs: 55, actorRef: 'doctor/agent' })
      const report = planDoctor(db, GOLDEN_VERSION)
      expect(report.issues).toEqual([])
      expect(report.counts).toEqual({ phases: 13, workItems: 15, relations: 14, criteria: 16, events: 32 })
      expect(report.status).toBe('ACTIVE')

      const error = thrownError(PlanDoctorError, () =>
        planDoctor(db, brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v9')))
      expect(error.code).toBe('unknown-plan-version')
      expect(error.message).toContain('is not recorded in this ledger')
    } finally {
      db.close()
    }
  })

  it('flags leases still ACTIVE past their expiry on the reading clock', async () => {
    const { db, claim } = await claimGoldenSchemaItem()
    try {
      // Before the horizon the pass stays clean; the reading clock is the
      // check's only input, and the released predecessor leases prove a
      // row past its old expiry never trips it once it is no longer ACTIVE.
      expect(planDoctor(db, GOLDEN_VERSION, { nowMs: claim.expiresAtMs - 1 }).issues).toEqual([])
      expect(planDoctor(db, GOLDEN_VERSION, { nowMs: claim.expiresAtMs }).issues).toEqual([
        {
          code: 'stale-active-lease',
          refId: claim.leaseId,
          message: `work lease "${claim.leaseId}" is still ACTIVE past its expiry at ${claim.expiresAtMs}; `
            + 'the reaper owns its recovery',
        },
      ])
    } finally {
      db.close()
    }
  })

  it('flags items without acceptance and criteria without verifiers', async () => {
    const db = await goldenLedger()
    try {
      db.prepare(
        'INSERT INTO work_items (id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, '
        + 'work_type, executor_kind, title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:mini-dsh:ADHOC-9', 'mini-dsh', 'plv:mini-dsh-v1.6a-ledger:v1', NULL, NULL, 'ADHOC-9', "
        + "'IMPLEMENTATION', 'AGENT', 'Unchecked item', NULL, 0, 'READY', 0, 5, 5)",
      ).run()
      db.prepare('DELETE FROM verification_specs WHERE criterion_id = ?')
        .run('ac:wi:mini-dsh:DB-001:AC-DB-001')
      const issues = planDoctor(db, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'work-item-without-acceptance',
          refId: 'wi:mini-dsh:ADHOC-9',
          message: 'work item "wi:mini-dsh:ADHOC-9" records no acceptance criterion; a completable item owes at least one',
        },
        {
          code: 'criterion-without-verifier',
          refId: 'ac:wi:mini-dsh:DB-001:AC-DB-001',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-DB-001" records no verification spec; its outcome would be unverifiable',
        },
        {
          code: 'projection-drift',
          refId: 'wi:mini-dsh:ADHOC-9',
          message: 'work item "wi:mini-dsh:ADHOC-9" is materialized but no work/created event replays it',
        },
      ])
    } finally {
      db.close()
    }
  })

  it('flags hierarchy and ordering cycles and cross-project relations', async () => {
    const db = await goldenLedger()
    try {
      db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE stable_key = ?')
        .run('wi:mini-dsh:DB-001', 'SCHEMA-001')
      db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE stable_key = ?')
        .run('wi:mini-dsh:SCHEMA-001', 'DB-001')
      db.prepare(
        'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
        + "VALUES ('rel:cycle:1', 'wi:mini-dsh:DB-001', 'wi:mini-dsh:SCHEMA-001', 'BLOCKS', 5)",
      ).run()
      db.prepare(
        'INSERT INTO work_items (id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, '
        + 'work_type, executor_kind, title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:other:ITEM-1', 'other-project', NULL, NULL, NULL, 'ITEM-1', "
        + "'IMPLEMENTATION', 'AGENT', 'Other project item', NULL, 0, 'READY', 0, 5, 5)",
      ).run()
      db.prepare(
        'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
        + "VALUES ('rel:cross:1', 'wi:mini-dsh:SCHEMA-001', 'wi:other:ITEM-1', 'RELATES_TO', 5)",
      ).run()
      const issues = planDoctor(db, GOLDEN_VERSION).issues
      const codes = issues.map(issue => issue.code)
      expect(codes.filter(code => code === 'hierarchy-cycle')).toHaveLength(1)
      expect(codes.filter(code => code === 'ordering-cycle')).toHaveLength(1)
      expect(codes).toContain('relation-crosses-projects')
      const ordering = issues.find(issue => issue.code === 'ordering-cycle')
      expect(ordering?.message).toContain('wi:mini-dsh:DB-001')
      expect(ordering?.message).toContain('wi:mini-dsh:SCHEMA-001')
      expect(issues.find(issue => issue.code === 'relation-crosses-projects')?.message)
        .toContain('crosses projects (mini-dsh -> other-project)')
    } finally {
      db.close()
    }
  })

  it('flags projection drift and unreadable timelines instead of throwing', async () => {
    const drift = await goldenLedger()
    try {
      drift.prepare('UPDATE work_items SET status = ? WHERE stable_key = ?').run('IN_PROGRESS', 'DB-001')
      drift.prepare('UPDATE acceptance_criteria SET status = ? WHERE id = ?')
        .run('FAILING', 'ac:wi:mini-dsh:DB-001:AC-DB-001')
      const issues = planDoctor(drift, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'wi:mini-dsh:DB-001',
          message: 'work item "wi:mini-dsh:DB-001" has materialized status IN_PROGRESS but replays to BLOCKED',
        },
        {
          code: 'projection-drift',
          refId: 'ac:wi:mini-dsh:DB-001:AC-DB-001',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-DB-001" has materialized status FAILING but replays to PENDING',
        },
      ])
    } finally {
      drift.close()
    }

    const unreadable = await goldenLedger()
    try {
      unreadable.prepare("UPDATE project_events SET payload_json = '{' WHERE sequence_no = 3")
        .run()
      const issues = planDoctor(unreadable, GOLDEN_VERSION).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]?.code).toBe('event-timeline-unreadable')
      expect(issues[0]?.message).toContain('the project event timeline cannot be decoded by event format 10')
    } finally {
      unreadable.close()
    }

    const rawCriterion = await goldenLedger()
    try {
      rawCriterion.prepare(
        'INSERT INTO acceptance_criteria (id, work_item_id, ordinal, criterion_kind, description, required, status) '
        + "VALUES ('ac:wi:mini-dsh:DB-001:AC-RAW', 'wi:mini-dsh:DB-001', 9, 'TEST', 'Raw criterion', 1, 'PENDING')",
      ).run()
      const issues = planDoctor(rawCriterion, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'criterion-without-verifier',
          refId: 'ac:wi:mini-dsh:DB-001:AC-RAW',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-RAW" records no verification spec; its outcome would be unverifiable',
        },
        {
          code: 'projection-drift',
          refId: 'ac:wi:mini-dsh:DB-001:AC-RAW',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-RAW" is materialized but replays to no criterion of its work item',
        },
      ])
    } finally {
      rawCriterion.close()
    }

    const revoked = await goldenLedger()
    try {
      activatePlanVersion(revoked, GOLDEN_VERSION)
      revoked.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W01')
      revoked.prepare('UPDATE work_items SET status = ? WHERE stable_key IN (?, ?)').run('DONE', 'OWNER-REVIEW-001', 'PRE-001')
      const claim = claimWorkItem(revoked, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'doctor/agent', { nowMs: 40 })
      revoked.prepare("UPDATE work_leases SET status = 'REVOKED' WHERE work_item_id = 'wi:mini-dsh:SCHEMA-001'").run()
      // The pinned clock keeps this scenario about the revoked row: the claim
      // expired in 1970, so the default wall clock would also flag it stale.
      const issues = planDoctor(revoked, GOLDEN_VERSION, { nowMs: 41 }).issues
      expect(issues.filter(issue => issue.code === 'projection-drift').map(issue => issue.message)).toContain(
        `work lease "${claim.leaseId}" has materialized status REVOKED but replays to ACTIVE`,
      )
      // The raw seam also moved the two DONE items without events; those
      // drifts are the seam's, and the lease mismatch is still found.
      expect(issues).toHaveLength(3)
    } finally {
      revoked.close()
    }

    const leaseless = await goldenLedger()
    try {
      leaseless.prepare(
        'INSERT INTO work_leases (id, work_item_id, worker_identity, lease_token_hash, status, '
        + 'acquired_at_ms, heartbeat_at_ms, expires_at_ms) '
        + "VALUES ('ls:orphan:1', 'wi:mini-dsh:SCHEMA-001', 'ghost', 'hash', 'ACTIVE', 5, 5, 9999999999999)",
      ).run()
      const issues = planDoctor(leaseless, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'ls:orphan:1',
          message: 'work lease "ls:orphan:1" is materialized but no work/claimed event replays it',
        },
      ])
    } finally {
      leaseless.close()
    }
  })
})
