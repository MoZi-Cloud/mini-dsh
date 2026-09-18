import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  TODO_VIEW_STATUSES,
  WorkStatusError,
  WorkTodoError,
  changeWorkStatus,
  claimWorkItem,
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  listAgentTodo,
  listOwnerTodo,
  listWorkTodo,
  parsePlanDocument,
  resolveWorkTodoSpec,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type ProjectId,
  type WorkItemId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

const PROJECT = brandString<ProjectId>('mini-dsh')

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

/** The ledger row id of a golden work item. */
function itemId(stableKey: string): WorkItemId {
  return brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`)
}

/** The ledger row id of a golden acceptance criterion. */
function criterionId(stableKey: string, criterion: string): AcceptanceCriterionId {
  return brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`)
}

/**
 * Make a golden item claimable through the causal rows: activate the version,
 * activate its phase, and satisfy the BLOCKS edges — the seams of writers
 * this package does not own (activation, evaluation outcomes).
 */
function makeClaimable(db: DatabaseSync, phaseKey: string): void {
  db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
  db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', phaseKey)
  db.prepare('UPDATE work_items SET status = ? WHERE stable_key IN (?, ?)').run('DONE', 'OWNER-REVIEW-001', 'PRE-001')
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

/** One view entry by stable key, failing the test when it is absent. */
function entryByStableKey(view: ReturnType<typeof listAgentTodo>, stableKey: string) {
  const entry = view.entries.find(candidate => candidate.stableKey === stableKey)
  if (entry === undefined) throw new Error(`expected a todo entry for ${stableKey}`)
  return entry
}

describe('resolveWorkTodoSpec', () => {
  it('defaults to every executor kind, de-duplicated and sorted, on the current clock', () => {
    const spec = resolveWorkTodoSpec()
    expect(spec.executorKinds).toEqual(['AGENT', 'EXTERNAL', 'OWNER', 'SYSTEM'])
    expect(spec.nowMs).toBeGreaterThan(0)
  })

  it('de-duplicates and sorts a named filter and carries the request clock', () => {
    expect(resolveWorkTodoSpec({ executorKinds: ['OWNER', 'AGENT', 'OWNER'] })).toEqual({
      executorKinds: ['AGENT', 'OWNER'],
      nowMs: resolveWorkTodoSpec({ executorKinds: ['OWNER'] }).nowMs,
    })
    expect(resolveWorkTodoSpec({ executorKinds: ['SYSTEM'], nowMs: 42 })).toEqual({
      executorKinds: ['SYSTEM'],
      nowMs: 42,
    })
  })

  it('rejects an explicitly empty kind filter', () => {
    const error = thrownError(WorkTodoError, () => resolveWorkTodoSpec({ executorKinds: [] }))
    expect(error.code).toBe('empty-executor-kinds')
    expect(error.message).toContain('executorKinds must name at least one executor kind')
  })
})

describe('owner and agent todo views', () => {
  it('separate owner and agent work on the golden plan', async () => {
    const db = await goldenLedger()
    try {
      const owner = listOwnerTodo(db, PROJECT, { nowMs: 5 })
      const agent = listAgentTodo(db, PROJECT, { nowMs: 5 })
      expect(owner.executorKinds).toEqual(['OWNER'])
      expect(agent.executorKinds).toEqual(['AGENT'])

      expect(owner.entries).toEqual([{
        workItemId: 'wi:mini-dsh:OWNER-REVIEW-001',
        stableKey: 'OWNER-REVIEW-001',
        title: 'Approve the pinned v1.6a Ledger Core scope',
        executorKind: 'OWNER',
        status: 'READY',
        priority: 100,
        phaseStableKey: 'W00',
        readiness: {
          ready: false,
          reasons: [{
            kind: 'plan-version-not-active',
            refId: 'plv:mini-dsh-v1.6a-ledger:v1',
            message: 'plan version "plv:mini-dsh-v1.6a-ledger:v1" is DRAFT; work opens when the version is activated',
          }],
        },
        activeLease: null,
      }])

      expect(agent.entries).toHaveLength(14)
      expect(new Set(agent.entries.map(entry => entry.executorKind))).toEqual(new Set(['AGENT']))
      expect(agent.entries.map(entry => entry.stableKey).slice(0, 3)).toEqual(['PRE-001', 'PRE-002', 'SCHEMA-001'])
      expect(agent.entries.map(entry => entry.workItemId)).not.toContain('wi:mini-dsh:OWNER-REVIEW-001')
      const ownerIds = new Set(owner.entries.map(entry => entry.workItemId))
      for (const entry of agent.entries) expect(ownerIds.has(entry.workItemId)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('shows the live lease and recomputed blockers on claimed work', async () => {
    const db = await goldenLedger()
    try {
      makeClaimable(db, 'W01')
      const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker/session-9', {
        nowMs: 10,
        leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      })
      const agent = listAgentTodo(db, PROJECT, { nowMs: 15 })
      expect(agent.entries).toHaveLength(13)
      const entry = entryByStableKey(agent, 'SCHEMA-001')
      expect(entry.status).toBe('IN_PROGRESS')
      expect(entry.activeLease).toEqual({
        leaseId: claim.leaseId,
        workerIdentity: 'worker/session-9',
        expiresAtMs: 1010,
      })
      expect(entry.readiness.reasons.map(reason => reason.kind)).toEqual(['work-status-closed', 'lease-active'])

      const afterExpiry = listAgentTodo(db, PROJECT, { nowMs: 2000 })
      const expired = entryByStableKey(afterExpiry, 'SCHEMA-001')
      expect(expired.activeLease).toBe(null)
      expect(expired.readiness.reasons.map(reason => reason.kind)).toEqual(['work-status-closed'])

      expect(listOwnerTodo(db, PROJECT, { nowMs: 15 }).entries).toEqual([])
    } finally {
      db.close()
    }
  })

  it('orders a mixed-kind view by executor kind and descending priority', async () => {
    const db = await goldenLedger()
    try {
      const view = listWorkTodo(db, PROJECT, { executorKinds: ['OWNER', 'AGENT'], nowMs: 5 })
      expect(view.executorKinds).toEqual(['AGENT', 'OWNER'])
      expect(view.entries).toHaveLength(15)
      expect(view.entries[0]?.stableKey).toBe('PRE-001')
      expect(view.entries[14]?.stableKey).toBe('OWNER-REVIEW-001')
      for (const entry of view.entries) {
        expect(TODO_VIEW_STATUSES).toContain(entry.status)
      }
    } finally {
      db.close()
    }
  })

  it('lists a phase-less ad hoc item with a null phase', async () => {
    const db = await goldenLedger()
    try {
      db.prepare(
        'INSERT INTO work_items (id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, '
        + 'work_type, executor_kind, title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:mini-dsh:ADHOC-2', 'mini-dsh', 'plv:mini-dsh-v1.6a-ledger:v1', NULL, NULL, 'ADHOC-2', "
        + "'IMPLEMENTATION', 'AGENT', 'Ad hoc objective', NULL, 0, 'PROPOSED', 0, 5, 5)",
      ).run()
      const agent = listAgentTodo(db, PROJECT, { nowMs: 5 })
      expect(agent.entries).toHaveLength(15)
      const entry = entryByStableKey(agent, 'ADHOC-2')
      expect(entry.phaseStableKey).toBe(null)
      expect(entry.status).toBe('PROPOSED')
      expect(listOwnerTodo(db, PROJECT, { nowMs: 5 }).entries).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('the session-todo completion boundary', () => {
  it('keeps project completion reachable only through the acceptance seam', async () => {
    const db = await goldenLedger()
    try {
      makeClaimable(db, 'W01')

      // A session todo holds no project identity, and the status writer has
      // no API that accepts an external "completed" flag: reaching DONE from
      // any non-VERIFYING status is refused outright.
      const direct = thrownError(WorkStatusError, () => changeWorkStatus(db, itemId('SCHEMA-001'), 'DONE'))
      expect(direct.code).toBe('transition-not-allowed')
      expect(direct.message).toContain('cannot change status from BLOCKED to DONE')

      claimWorkItem(db, itemId('SCHEMA-001'), 'worker/session-9', { nowMs: 20 })
      changeWorkStatus(db, itemId('SCHEMA-001'), 'VERIFYING', { nowMs: 25 })
      const held = thrownError(WorkStatusError, () => changeWorkStatus(db, itemId('SCHEMA-001'), 'DONE'))
      expect(held.code).toBe('acceptance-not-passed')
      expect(held.message).toContain('cannot complete while required acceptance is outstanding')
      expect(held.message).toContain('"ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001" is PENDING')

      evaluateAcceptanceCriterion(
        db,
        criterionId('SCHEMA-001', 'AC-SCHEMA-001'),
        'WAIVED',
        { nowMs: 30 },
      )
      const completed = changeWorkStatus(db, itemId('SCHEMA-001'), 'DONE', { nowMs: 31 })
      expect(completed).toMatchObject({ fromStatus: 'VERIFYING', toStatus: 'DONE' })

      const agent = listAgentTodo(db, PROJECT, { nowMs: 32 })
      expect(agent.entries).toHaveLength(12)
      expect(agent.entries.map(entry => entry.stableKey)).not.toContain('SCHEMA-001')
      expect(listOwnerTodo(db, PROJECT, { nowMs: 32 }).entries).toEqual([])
    } finally {
      db.close()
    }
  })
})
