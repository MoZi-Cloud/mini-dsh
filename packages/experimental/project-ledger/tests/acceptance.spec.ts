import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_EVALUATION_ACTOR_REF,
  AcceptanceEvaluationError,
  appendProjectEvent,
  compilePlan,
  computeWorkReadiness,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  replayProjectEvents,
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

/** The ledger row id of one golden acceptance criterion. */
function criterionId(stableKey: string, criterion: string): AcceptanceCriterionId {
  return brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`)
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

/** The projection read straight from the materialized tables, for the parity comparison. */
function materializedProjection(db: DatabaseSync): Record<string, unknown> {
  const planVersions = new Map<string, unknown>()
  const versionRows = db.prepare('SELECT id, plan_id, version_no, source_document_hash FROM plan_versions')
    .all() as { id: string; plan_id: string; version_no: number; source_document_hash: string }[]
  for (const row of versionRows) {
    planVersions.set(row.id, {
      planId: row.plan_id,
      versionNo: row.version_no,
      sourceDocumentHash: row.source_document_hash,
    })
  }
  const criteriaByItem = new Map<string, Map<string, unknown>>()
  const criteriaRows = db.prepare(
    'SELECT id, work_item_id, ordinal, criterion_kind, required, status FROM acceptance_criteria ORDER BY ordinal',
  ).all() as {
    id: string
    work_item_id: string
    ordinal: number
    criterion_kind: string
    required: number
    status: string
  }[]
  for (const row of criteriaRows) {
    const criteria = criteriaByItem.get(row.work_item_id) ?? new Map<string, unknown>()
    criteria.set(row.id, {
      ordinal: row.ordinal,
      criterionKind: row.criterion_kind,
      required: row.required === 1,
      status: row.status,
    })
    criteriaByItem.set(row.work_item_id, criteria)
  }
  const workItems = new Map<string, unknown>()
  const itemRows = db.prepare('SELECT id, stable_key, title, plan_version_id, status FROM work_items')
    .all() as { id: string; stable_key: string; title: string; plan_version_id: string; status: string }[]
  for (const row of itemRows) {
    workItems.set(row.id, {
      stableKey: row.stable_key,
      title: row.title,
      planVersionId: row.plan_version_id,
      status: row.status,
      criteria: criteriaByItem.get(row.id) ?? new Map(),
    })
  }
  const leases = new Map<string, unknown>()
  const leaseRows = db.prepare(
    'SELECT id, work_item_id, worker_identity, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms, released_at_ms '
    + 'FROM work_leases',
  ).all() as {
    id: string
    work_item_id: string
    worker_identity: string
    status: string
    acquired_at_ms: number
    heartbeat_at_ms: number
    expires_at_ms: number
    released_at_ms: number | null
  }[]
  for (const row of leaseRows) {
    leases.set(row.id, {
      workItemId: row.work_item_id,
      workerIdentity: row.worker_identity,
      status: row.status,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatAtMs: row.heartbeat_at_ms,
      expiresAtMs: row.expires_at_ms,
      releasedAtMs: row.released_at_ms ?? undefined,
    })
  }
  // No test in this file prepares work packets; the rebuild seam owns packet parity.
  return { planVersions, workItems, leases, workPackets: new Map(), decisionRequests: new Map(), decisions: new Map() }
}

describe('verification_specs storage', () => {
  it('stores every verifier spec with its tagged columns and never executes it', async () => {
    const db = await goldenLedger()
    const specCount = db.prepare('SELECT COUNT(*) AS count FROM verification_specs').get() as { count: number }
    expect(specCount.count).toBe(16)

    const commandSpec = db.prepare(
      'SELECT verifier_kind, command_text, expected_exit_code, query_text, expected_json, owner_instruction, '
      + 'sandbox_required, approval_required FROM verification_specs WHERE criterion_id = ?',
    ).get(criterionId('PRE-001', 'AC-PRE-001')) as Record<string, unknown>
    expect(commandSpec).toEqual({
      verifier_kind: 'COMMAND',
      command_text: 'test -f docs/mini/v1.6a/fork-mini-DSH改造方案-v1.6a.md',
      expected_exit_code: 0,
      query_text: null,
      expected_json: null,
      owner_instruction: null,
      sandbox_required: 1,
      approval_required: 0,
    })

    const ownerSpec = db.prepare(
      'SELECT command_text, owner_instruction, sandbox_required FROM verification_specs WHERE criterion_id = ?',
    ).get(criterionId('OWNER-REVIEW-001', 'AC-OWNER-001')) as Record<string, unknown>
    expect(ownerSpec).toEqual({
      command_text: null,
      owner_instruction: 'Confirm v1.6a Ledger Core scope and activation.',
      sandbox_required: 1,
    })

    // Evaluating a COMMAND criterion stores the caller-reported result; a
    // command that could not succeed still "passes" because nothing runs it.
    db.prepare(
      'INSERT INTO acceptance_criteria '
      + '(id, work_item_id, ordinal, criterion_kind, description, required, status) '
      + "VALUES ('ac:wi:mini-dsh:PRE-001:AC-NEVER', 'wi:mini-dsh:PRE-001', 1, 'COMMAND', 'Never executed', 1, 'PENDING')",
    ).run()
    db.prepare(
      'INSERT INTO verification_specs '
      + '(id, criterion_id, verifier_kind, command_text, expected_exit_code, query_text, expected_json, '
      + 'owner_instruction, sandbox_required, approval_required) '
      + "VALUES ('vs:ac:wi:mini-dsh:PRE-001:AC-NEVER', 'ac:wi:mini-dsh:PRE-001:AC-NEVER', 'COMMAND', "
      + "'definitely-never-run-xyz', 0, NULL, NULL, NULL, 1, 0)",
    ).run()
    const evaluation = evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:PRE-001:AC-NEVER'),
      'PASS',
      { nowMs: 7 },
    )
    expect(evaluation.status).toBe('PASSING')
    db.close()
  })
})

describe('evaluateAcceptanceCriterion', () => {
  it('records the evaluation, moves the projection, and appends the event', async () => {
    const db = await goldenLedger()
    const id = criterionId('PRE-001', 'AC-PRE-001')

    const evaluation = evaluateAcceptanceCriterion(db, id, 'FAIL', {
      attemptRef: 'att:1',
      repoHead: 'head123',
      worktreeHash: 'wt1',
      observed: { failures: 2 },
      verificationRef: 'vr:1',
      evaluatedBy: 'agent/a',
      nowMs: 7,
    })
    expect(evaluation).toEqual({
      evaluationId: `ev:${id}:17`,
      criterionId: id,
      workItemId: 'wi:mini-dsh:PRE-001',
      fromStatus: 'PENDING',
      status: 'FAILING',
      result: 'FAIL',
      sequenceNo: 17,
      evaluatedAtMs: 7,
    })

    expect(db.prepare('SELECT status FROM acceptance_criteria WHERE id = ?').get(id))
      .toEqual({ status: 'FAILING' })
    const row = db.prepare(
      'SELECT id, criterion_id, work_item_id, attempt_ref, repo_head, worktree_hash, result, observed_json, '
      + 'verification_ref, evaluated_by, evaluated_at_ms FROM acceptance_evaluations',
    ).get() as Record<string, unknown>
    expect(row).toEqual({
      id: `ev:${id}:17`,
      criterion_id: id,
      work_item_id: 'wi:mini-dsh:PRE-001',
      attempt_ref: 'att:1',
      repo_head: 'head123',
      worktree_hash: 'wt1',
      result: 'FAIL',
      observed_json: '{"failures":2}',
      verification_ref: 'vr:1',
      evaluated_by: 'agent/a',
      evaluated_at_ms: 7,
    })
    const event = db.prepare(
      'SELECT event_type, ignorable, entity_type, entity_id, actor_ref, payload_json, created_at_ms '
      + 'FROM project_events WHERE project_id = ? AND sequence_no = 17',
    ).get(PROJECT) as Record<string, unknown>
    expect(event).toEqual({
      event_type: 'acceptance/evaluated',
      ignorable: 0,
      entity_type: 'acceptance_criterion',
      entity_id: id,
      actor_ref: 'agent/a',
      payload_json: JSON.stringify({ workItemId: 'wi:mini-dsh:PRE-001', criterionId: id, result: 'FAIL', status: 'FAILING' }),
      created_at_ms: 7,
    })
    db.close()
  })

  it('keeps the full evaluation history append-only', async () => {
    const db = await goldenLedger()
    const id = criterionId('PRE-001', 'AC-PRE-001')
    evaluateAcceptanceCriterion(db, id, 'FAIL', { nowMs: 7 })
    const second = evaluateAcceptanceCriterion(db, id, 'PASS', { nowMs: 8 })

    expect(second.sequenceNo).toBe(18)
    expect(second.fromStatus).toBe('FAILING')
    expect(second.status).toBe('PASSING')
    const rows = db.prepare(
      'SELECT result, evaluated_at_ms FROM acceptance_evaluations ORDER BY evaluated_at_ms',
    ).all() as { result: string; evaluated_at_ms: number }[]
    expect(rows).toEqual([
      { result: 'FAIL', evaluated_at_ms: 7 },
      { result: 'PASS', evaluated_at_ms: 8 },
    ])
    db.close()
  })

  it('maps each evaluable result to its projection status', async () => {
    const db = await goldenLedger()
    const cases = [
      { id: criterionId('PRE-001', 'AC-PRE-001'), result: 'PASS', status: 'PASSING' },
      { id: criterionId('PRE-002', 'AC-PRE-002'), result: 'FAIL', status: 'FAILING' },
      { id: criterionId('SCHEMA-001', 'AC-SCHEMA-001'), result: 'BLOCKED', status: 'BLOCKED' },
      { id: criterionId('IMPORT-001', 'AC-IMPORT-001'), result: 'WAIVED', status: 'WAIVED' },
    ] as const
    for (const entry of cases) {
      evaluateAcceptanceCriterion(db, entry.id, entry.result, { nowMs: 7 })
      expect(db.prepare('SELECT status FROM acceptance_criteria WHERE id = ?').get(entry.id))
        .toEqual({ status: entry.status })
    }
    db.close()
  })

  it('an ERROR result records history without moving the projection', async () => {
    const db = await goldenLedger()
    const id = criterionId('PRE-001', 'AC-PRE-001')
    evaluateAcceptanceCriterion(db, id, 'FAIL', { nowMs: 7 })

    const errored = evaluateAcceptanceCriterion(db, id, 'ERROR', { nowMs: 8 })
    expect(errored.fromStatus).toBe('FAILING')
    expect(errored.status).toBe('FAILING')
    expect(db.prepare('SELECT status FROM acceptance_criteria WHERE id = ?').get(id))
      .toEqual({ status: 'FAILING' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM acceptance_evaluations').get())
      .toEqual({ count: 2 })
    db.close()
  })

  it('rejects an unknown criterion without writing', async () => {
    const db = await goldenLedger()
    const thrown = thrownError(
      AcceptanceEvaluationError,
      () => evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:NOPE'), 'PASS'),
    )
    expect(thrown.code).toBe('unknown-criterion')
    expect(thrown.message).toBe('acceptance criterion "ac:wi:mini-dsh:NOPE" is not recorded in this ledger')
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_events WHERE project_id = ?').get(PROJECT))
      .toEqual({ count: 16 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM acceptance_evaluations').get())
      .toEqual({ count: 0 })
    db.close()
  })

  it('defaults the evaluator identity and clock', async () => {
    const db = await goldenLedger()
    const evaluation = evaluateAcceptanceCriterion(db, criterionId('PRE-001', 'AC-PRE-001'), 'PASS')
    expect(evaluation.evaluatedAtMs).toBeGreaterThan(0)
    const row = db.prepare('SELECT evaluated_by, evaluated_at_ms FROM acceptance_evaluations').get() as
      | Record<string, unknown>
    expect(row.evaluated_by).toBe(DEFAULT_EVALUATION_ACTOR_REF)
    expect(row.evaluated_at_ms).toBe(evaluation.evaluatedAtMs)
    db.close()
  })

  it('rolls the whole evaluation back when the event append fails', async () => {
    const db = await goldenLedger()
    db.exec('CREATE TRIGGER block_eval_events BEFORE INSERT ON project_events '
      + "BEGIN SELECT RAISE(ABORT, 'evaluation-blocked-by-test'); END")

    expect(() => evaluateAcceptanceCriterion(db, criterionId('PRE-001', 'AC-PRE-001'), 'PASS', { nowMs: 7 }))
      .toThrow('evaluation-blocked-by-test')
    expect(db.prepare('SELECT status FROM acceptance_criteria WHERE id = ?').get(criterionId('PRE-001', 'AC-PRE-001')))
      .toEqual({ status: 'PENDING' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM acceptance_evaluations').get())
      .toEqual({ count: 0 })
    db.close()
  })
})

describe('replay', () => {
  it('replays evaluations into the criterion projection with parity', async () => {
    const db = await goldenLedger()
    const id = criterionId('PRE-001', 'AC-PRE-001')
    evaluateAcceptanceCriterion(db, id, 'FAIL', { nowMs: 7 })
    evaluateAcceptanceCriterion(db, id, 'PASS', { nowMs: 8 })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed.workItems.get(brandString<WorkItemId>('wi:mini-dsh:PRE-001'))?.criteria.get(id)).toEqual({
      ordinal: 0,
      criterionKind: 'COMMAND',
      required: true,
      status: 'PASSING',
    })
    expect(replayed).toEqual(materializedProjection(db))
    db.close()
  })

  it('fails closed on evaluations naming unknown entities', async () => {
    const db = await goldenLedger()
    appendProjectEvent(db, PROJECT, 'acceptance/evaluated', {
      workItemId: 'wi:mini-dsh:GHOST',
      criterionId: 'ac:wi:mini-dsh:GHOST:X',
      result: 'PASS',
      status: 'PASSING',
    }, { nowMs: 2 })
    expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:GHOST)')
    db.close()

    const withItem = await goldenLedger()
    appendProjectEvent(withItem, PROJECT, 'acceptance/evaluated', {
      workItemId: 'wi:mini-dsh:PRE-001',
      criterionId: 'ac:wi:mini-dsh:PRE-001:GHOST',
      result: 'PASS',
      status: 'PASSING',
    }, { nowMs: 2 })
    expect(thrownError(Error, () => replayProjectEvents(withItem, PROJECT)).message)
      .toContain('payload field "criterionId" names no replayed acceptance criterion '
        + '(ac:wi:mini-dsh:PRE-001:GHOST)')
    withItem.close()
  })

  it('fails replay on mistyped evaluation payloads', async () => {
    const db = await goldenLedger()
    const base = {
      workItemId: 'wi:mini-dsh:PRE-001',
      criterionId: 'ac:wi:mini-dsh:PRE-001:AC-PRE-001',
      result: 'PASS',
      status: 'PASSING',
    }
    appendProjectEvent(db, PROJECT, 'acceptance/evaluated', base, { nowMs: 2 })
    const setPayload = (payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = 17')
        .run(JSON.stringify(payload), PROJECT)
    }

    for (const field of Object.keys(base)) {
      const payload = Object.fromEntries(Object.entries(base).filter(([key]) => key !== field))
      setPayload(payload)
      expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload({ ...base, result: 'SPICED' })
    expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "result" is not an acceptance evaluation result: "SPICED"')
    setPayload({ ...base, status: 'SPICED' })
    expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "status" is not an acceptance criterion status: "SPICED"')
    db.close()
  })
})

describe('readiness closed loop', () => {
  it('a waived required criterion stops blocking the claim', async () => {
    const db = await goldenLedger()
    db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
    const item = brandString<WorkItemId>('wi:mini-dsh:PRE-001')
    const id = criterionId('PRE-001', 'AC-PRE-001')
    evaluateAcceptanceCriterion(db, id, 'FAIL', { nowMs: 7 })

    expect(computeWorkReadiness(db, item).reasons.map(reason => reason.kind)).toEqual([
      'acceptance-criterion-blocked',
    ])
    evaluateAcceptanceCriterion(db, id, 'WAIVED', { nowMs: 8 })
    expect(computeWorkReadiness(db, item)).toEqual({ ready: true, reasons: [] })
    db.close()
  })
})
