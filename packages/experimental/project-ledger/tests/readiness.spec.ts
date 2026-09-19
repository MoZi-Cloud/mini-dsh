import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_STATUS_ACTOR_REF,
  WorkReadinessError,
  WorkStatusError,
  changeWorkStatus,
  compilePlan,
  computeWorkReadiness,
  detectWorkGraphCycles,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  replayProjectEvents,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type AcceptanceCriterionStatus,
  type CompiledPlan,
  type PlanAcceptanceKind,
  type PlanId,
  type PlanVersionId,
  type PlanWorkItemStatus,
  type ProjectId,
  type ReplayedCriterion,
  type ReplayedLease,
  type ReplayedLeaseStatus,
  type ReplayedPlanVersion,
  type ReplayedProjectProjection,
  type ReplayedWorkItem,
  type SourceDocumentHash,
  type WorkItemId,
  type WorkLeaseId,
  type WorkReadiness,
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

/** Recompute readiness for a golden work item by stable key. */
function readinessOf(db: DatabaseSync, stableKey: string, nowMs?: number): WorkReadiness {
  return computeWorkReadiness(db, itemId(stableKey), nowMs === undefined ? {} : { nowMs })
}

/** Flip the imported DRAFT version to ACTIVE — the seam of the activation writer (a later package). */
function activateVersion(db: DatabaseSync): void {
  db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
}

/** Overwrite a work item status directly — the seam of writers this package does not own. */
function setItemStatus(db: DatabaseSync, stableKey: string, status: PlanWorkItemStatus): void {
  db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, itemId(stableKey))
}

/** The projection read straight from the materialized tables, for the parity comparison. */
function materializedProjection(db: DatabaseSync): ReplayedProjectProjection {
  const planVersions = new Map<PlanVersionId, ReplayedPlanVersion>()
  const versionRows = db.prepare('SELECT id, plan_id, version_no, source_document_hash FROM plan_versions')
    .all() as { id: string; plan_id: string; version_no: number; source_document_hash: string }[]
  for (const row of versionRows) {
    planVersions.set(brandString<PlanVersionId>(row.id), {
      planId: brandString<PlanId>(row.plan_id),
      versionNo: row.version_no,
      sourceDocumentHash: brandString<SourceDocumentHash>(row.source_document_hash),
    })
  }
  const criteriaByItem = new Map<string, Map<AcceptanceCriterionId, ReplayedCriterion>>()
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
    const criteria = criteriaByItem.get(row.work_item_id) ?? new Map<AcceptanceCriterionId, ReplayedCriterion>()
    criteria.set(brandString<AcceptanceCriterionId>(row.id), {
      ordinal: row.ordinal,
      criterionKind: row.criterion_kind as PlanAcceptanceKind,
      required: row.required === 1,
      status: row.status as AcceptanceCriterionStatus,
    })
    criteriaByItem.set(row.work_item_id, criteria)
  }
  const workItems = new Map<WorkItemId, ReplayedWorkItem>()
  const itemRows = db.prepare('SELECT id, stable_key, title, plan_version_id, status FROM work_items')
    .all() as { id: string; stable_key: string; title: string; plan_version_id: string; status: string }[]
  for (const row of itemRows) {
    workItems.set(brandString<WorkItemId>(row.id), {
      stableKey: row.stable_key,
      title: row.title,
      planVersionId: brandString<PlanVersionId>(row.plan_version_id),
      status: row.status as PlanWorkItemStatus,
      criteria: criteriaByItem.get(row.id) ?? new Map(),
    })
  }
  const leases = new Map<WorkLeaseId, ReplayedLease>()
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
    leases.set(brandString<WorkLeaseId>(row.id), {
      workItemId: brandString<WorkItemId>(row.work_item_id),
      workerIdentity: row.worker_identity,
      status: row.status as ReplayedLeaseStatus,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatAtMs: row.heartbeat_at_ms,
      expiresAtMs: row.expires_at_ms,
      releasedAtMs: row.released_at_ms ?? undefined,
    })
  }
  // No test in this file prepares work packets; the rebuild seam owns packet parity.
  return {
    planVersions, workItems, leases, workPackets: new Map(),
    decisionRequests: new Map(), decisions: new Map(), approvals: new Map(),
    resourceRequirements: new Map(), resourceInstances: new Map(), resourceVerifications: new Map(),
  }
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

describe('computeWorkReadiness', () => {
  it('rejects an unknown work item', async () => {
    const db = await goldenLedger()
    const thrown = thrownError(
      WorkReadinessError,
      () => computeWorkReadiness(db, brandString<WorkItemId>('wi:mini-dsh:NOPE')),
    )
    expect(thrown.code).toBe('unknown-work-item')
    expect(thrown.message).toBe('work item "wi:mini-dsh:NOPE" is not recorded in this ledger')
    db.close()
  })

  it('reports every blocker of a dependent item under the DRAFT version', async () => {
    const db = await goldenLedger()
    expect(readinessOf(db, 'SCHEMA-001')).toEqual({
      ready: false,
      reasons: [
        {
          kind: 'plan-version-not-active',
          refId: 'plv:mini-dsh-v1.6a-ledger:v1',
          message: 'plan version "plv:mini-dsh-v1.6a-ledger:v1" is DRAFT; work opens when the version is activated',
        },
        {
          kind: 'phase-not-active',
          refId: 'ph:plv:mini-dsh-v1.6a-ledger:v1:W01',
          message: 'phase "ph:plv:mini-dsh-v1.6a-ledger:v1:W01" is PLANNED; work opens when the phase is READY or ACTIVE',
        },
        {
          kind: 'blocking-relation-open',
          refId: 'wi:mini-dsh:OWNER-REVIEW-001',
          message: 'BLOCKS from "wi:mini-dsh:OWNER-REVIEW-001" (status READY) is not satisfied; '
            + 'the edge closes when the source item is DONE',
        },
        {
          kind: 'blocking-relation-open',
          refId: 'wi:mini-dsh:PRE-001',
          message: 'BLOCKS from "wi:mini-dsh:PRE-001" (status READY) is not satisfied; '
            + 'the edge closes when the source item is DONE',
        },
      ],
    })
    db.close()
  })

  it('an item behind an open edge stays blocked while a sibling with none is ready', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    expect(readinessOf(db, 'PRE-001')).toEqual({ ready: true, reasons: [] })
    expect(readinessOf(db, 'SCHEMA-001').ready).toBe(false)
    expect(readinessOf(db, 'SCHEMA-001').reasons.map(reason => reason.kind)).toEqual([
      'phase-not-active',
      'blocking-relation-open',
      'blocking-relation-open',
    ])
    db.close()
  })

  it('hierarchy is composition, not dependency', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE id = ?')
      .run(itemId('OWNER-REVIEW-001'), itemId('PRE-001'))

    // The parent is not DONE, yet the child stays claimable: §10 forbids
    // reading parent_work_item_id as a dependency.
    expect(readinessOf(db, 'PRE-001')).toEqual({ ready: true, reasons: [] })
    db.close()
  })

  it('a satisfied ordering edge drops its blocker', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    setItemStatus(db, 'OWNER-REVIEW-001', 'DONE')
    setItemStatus(db, 'PRE-001', 'DONE')

    const readiness = readinessOf(db, 'SCHEMA-001')
    expect(readiness.reasons.map(reason => reason.kind)).toEqual(['phase-not-active'])
    db.close()
  })

  it('external blockers open and close the item', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    db.prepare(
      'INSERT INTO work_external_blockers '
      + '(id, work_item_id, blocker_kind, title, detail, status, external_ref, created_at_ms, resolved_at_ms) '
      + "VALUES ('eb:test:1', ?, 'ENVIRONMENT', 'Registry quota exhausted', NULL, 'OPEN', NULL, 1, NULL)",
    ).run(itemId('PRE-001'))
    expect(readinessOf(db, 'PRE-001').reasons).toEqual([{
      kind: 'external-blocker-open',
      refId: 'eb:test:1',
      message: 'external blocker "eb:test:1" (Registry quota exhausted) is OPEN',
    }])

    db.prepare("UPDATE work_external_blockers SET status = 'RESOLVED', resolved_at_ms = 2 WHERE id = 'eb:test:1'").run()
    expect(readinessOf(db, 'PRE-001')).toEqual({ ready: true, reasons: [] })
    db.close()
  })

  it('a required failing acceptance criterion blocks until waived', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    db.prepare("UPDATE acceptance_criteria SET status = 'FAILING' WHERE work_item_id = ? AND required = 1")
      .run(itemId('PRE-001'))
    expect(readinessOf(db, 'PRE-001').reasons).toEqual([{
      kind: 'acceptance-criterion-blocked',
      refId: 'ac:wi:mini-dsh:PRE-001:AC-PRE-001',
      message: 'required acceptance criterion "ac:wi:mini-dsh:PRE-001:AC-PRE-001" is FAILING',
    }])

    db.prepare("UPDATE acceptance_criteria SET status = 'WAIVED' WHERE work_item_id = ? AND required = 1")
      .run(itemId('PRE-001'))
    expect(readinessOf(db, 'PRE-001')).toEqual({ ready: true, reasons: [] })
    db.close()
  })

  it('a live active lease blocks and an expired one does not', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    const insertLease = db.prepare(
      'INSERT INTO work_leases '
      + '(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, '
      + 'expires_at_ms, released_at_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    )
    insertLease.run('lease:test:1', itemId('PRE-001'), 'agent/a', 'tok', 'ACTIVE', 1, 1, 6_000)
    expect(readinessOf(db, 'PRE-001', 5_000).reasons).toEqual([{
      kind: 'lease-active',
      refId: 'lease:test:1',
      message: 'active lease "lease:test:1" held by agent/a expires at 6000',
    }])
    // Past expiry the lease is stale: the reaper (a later package) retires it,
    // and readiness stops treating it as a claim blocker.
    expect(readinessOf(db, 'PRE-001', 6_001)).toEqual({ ready: true, reasons: [] })
    db.close()
  })

  it('treats an unexpired lease as live under the default clock', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    db.prepare(
      'INSERT INTO work_leases '
      + '(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, '
      + 'expires_at_ms, released_at_ms) '
      + "VALUES ('lease:test:2', ?, 'agent/b', 'tok', 'ACTIVE', 1, 1, 32503680000000, NULL)",
    ).run(itemId('PRE-001'))
    expect(readinessOf(db, 'PRE-001').reasons.map(reason => reason.kind)).toEqual(['lease-active'])
    db.close()
  })

  it('closes mid-flight and terminal statuses to a new claim', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    for (const status of ['IN_PROGRESS', 'VERIFYING', 'DONE', 'FAILED', 'CANCELLED', 'SUPERSEDED'] as const) {
      setItemStatus(db, 'PRE-001', status)
      expect(readinessOf(db, 'PRE-001').reasons).toEqual([{
        kind: 'work-status-closed',
        message: `work item "${itemId('PRE-001')}" has status ${status} and is not open for a claim`,
      }])
    }
    db.close()
  })

  it('recomputes past statuses that merely project readiness', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    for (const status of ['PROPOSED', 'READY', 'BLOCKED'] as const) {
      setItemStatus(db, 'PRE-001', status)
      expect(readinessOf(db, 'PRE-001')).toEqual({ ready: true, reasons: [] })
    }
    db.close()
  })

  it('backlog work without a plan version or phase skips those checks', async () => {
    const db = await goldenLedger()
    activateVersion(db)
    db.prepare(
      'INSERT INTO work_items '
      + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
      + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
      + "VALUES ('wi:mini-dsh:BACKLOG-1', 'mini-dsh', NULL, NULL, NULL, 'BACKLOG-1', 'IMPLEMENTATION', 'AGENT', "
      + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
    ).run()
    expect(readinessOf(db, 'BACKLOG-1')).toEqual({ ready: true, reasons: [] })
    db.close()
  })
})

describe('changeWorkStatus', () => {
  it('moves an item through its allowed transitions and records each event', async () => {
    const db = await goldenLedger()
    setItemStatus(db, 'PRE-001', 'IN_PROGRESS')

    const first = changeWorkStatus(db, itemId('PRE-001'), 'VERIFYING', { actorRef: 'agent/a', nowMs: 7 })
    expect(first).toEqual({
      workItemId: itemId('PRE-001'),
      fromStatus: 'IN_PROGRESS',
      toStatus: 'VERIFYING',
      sequenceNo: 17,
      createdAtMs: 7,
    })
    // Completion authority: the required criterion must pass before DONE.
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:PRE-001:AC-PRE-001'),
      'PASS',
      { nowMs: 7 },
    )
    const second = changeWorkStatus(db, itemId('PRE-001'), 'DONE', { actorRef: 'agent/a', nowMs: 8 })
    expect(second.sequenceNo).toBe(19)

    expect(db.prepare('SELECT status, updated_at_ms FROM work_items WHERE id = ?').get(itemId('PRE-001')))
      .toEqual({ status: 'DONE', updated_at_ms: 8 })
    const event = db.prepare(
      'SELECT event_type, ignorable, entity_type, entity_id, actor_ref, payload_json, created_at_ms '
      + 'FROM project_events WHERE project_id = ? AND sequence_no = 17',
    ).get(PROJECT) as Record<string, unknown>
    expect(event).toEqual({
      event_type: 'work/status-changed',
      ignorable: 0,
      entity_type: 'work_item',
      entity_id: 'wi:mini-dsh:PRE-001',
      actor_ref: 'agent/a',
      payload_json: JSON.stringify({ workItemId: 'wi:mini-dsh:PRE-001', fromStatus: 'IN_PROGRESS', toStatus: 'VERIFYING' }),
      created_at_ms: 7,
    })
    db.close()
  })

  it('admits PROPOSED work to READY under the default actor and clock', async () => {
    const db = await goldenLedger()
    setItemStatus(db, 'PRE-001', 'PROPOSED')

    const change = changeWorkStatus(db, itemId('PRE-001'), 'READY')
    expect(change.fromStatus).toBe('PROPOSED')
    expect(change.toStatus).toBe('READY')
    expect(change.sequenceNo).toBe(17)
    expect(change.createdAtMs).toBeGreaterThan(0)
    const event = db.prepare('SELECT actor_ref FROM project_events WHERE project_id = ? AND sequence_no = 17')
      .get(PROJECT) as { actor_ref: string }
    expect(event.actor_ref).toBe(DEFAULT_STATUS_ACTOR_REF)
    db.close()
  })

  it('refuses transitions owned by dedicated events, no-ops, and terminal statuses', async () => {
    const db = await goldenLedger()

    const claim = thrownError(
      WorkStatusError,
      () => changeWorkStatus(db, itemId('PRE-001'), 'IN_PROGRESS', { nowMs: 7 }),
    )
    expect(claim.code).toBe('transition-not-allowed')
    expect(claim.message).toBe('work item "wi:mini-dsh:PRE-001" cannot change status from READY to IN_PROGRESS '
      + '(allowed from READY: CANCELLED)')

    const noop = thrownError(
      WorkStatusError,
      () => changeWorkStatus(db, itemId('PRE-001'), 'READY', { nowMs: 7 }),
    )
    expect(noop.message).toBe('work item "wi:mini-dsh:PRE-001" already has status READY')

    setItemStatus(db, 'PRE-001', 'DONE')
    const terminal = thrownError(
      WorkStatusError,
      () => changeWorkStatus(db, itemId('PRE-001'), 'READY', { nowMs: 7 }),
    )
    expect(terminal.message).toBe('work item "wi:mini-dsh:PRE-001" cannot change status from DONE to READY '
      + '(allowed from DONE: nothing; the status is terminal)')

    // Rejections write nothing: no event, no status move.
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_events WHERE project_id = ?').get(PROJECT))
      .toEqual({ count: 16 })
    expect(db.prepare('SELECT status FROM work_items WHERE id = ?').get(itemId('PRE-001')))
      .toEqual({ status: 'DONE' })
    db.close()
  })

  it('rejects an unknown work item without writing', async () => {
    const db = await goldenLedger()
    const thrown = thrownError(
      WorkStatusError,
      () => changeWorkStatus(db, brandString<WorkItemId>('wi:mini-dsh:NOPE'), 'READY', { nowMs: 7 }),
    )
    expect(thrown.code).toBe('unknown-work-item')
    expect(thrown.message).toBe('work item "wi:mini-dsh:NOPE" is not recorded in this ledger')
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_events WHERE project_id = ?').get(PROJECT))
      .toEqual({ count: 16 })
    db.close()
  })

  it('rolls the whole transition back when the event append fails', async () => {
    const db = await goldenLedger()
    setItemStatus(db, 'PRE-001', 'IN_PROGRESS')
    const before = db.prepare('SELECT updated_at_ms FROM work_items WHERE id = ?')
      .get(itemId('PRE-001')) as { updated_at_ms: number }
    db.exec('CREATE TRIGGER block_status_events BEFORE INSERT ON project_events '
      + "BEGIN SELECT RAISE(ABORT, 'transition-blocked-by-test'); END")

    expect(() => changeWorkStatus(db, itemId('PRE-001'), 'VERIFYING', { nowMs: 7 }))
      .toThrow('transition-blocked-by-test')
    expect(db.prepare('SELECT status, updated_at_ms FROM work_items WHERE id = ?').get(itemId('PRE-001')))
      .toEqual({ status: 'IN_PROGRESS', updated_at_ms: before.updated_at_ms })
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_events WHERE project_id = ?').get(PROJECT))
      .toEqual({ count: 16 })
    db.close()
  })
})

describe('detectWorkGraphCycles', () => {
  it('a compiled ledger is acyclic', async () => {
    const db = await goldenLedger()
    expect(detectWorkGraphCycles(db, PROJECT)).toEqual({ hierarchyCycles: [], orderingCycles: [] })
    db.close()
  })

  it('detects an ordering cycle among raw relation rows', async () => {
    const db = await goldenLedger()
    db.prepare(
      'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
      + "VALUES ('rel:test:1', ?, ?, 'PRECEDES', 1)",
    ).run(itemId('SCHEMA-001'), itemId('OWNER-REVIEW-001'))

    expect(detectWorkGraphCycles(db, PROJECT)).toEqual({
      hierarchyCycles: [],
      orderingCycles: [[itemId('OWNER-REVIEW-001'), itemId('SCHEMA-001'), itemId('OWNER-REVIEW-001')]],
    })
    db.close()
  })

  it('detects a hierarchy cycle among raw parent rows', async () => {
    const db = await goldenLedger()
    db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE id = ?')
      .run(itemId('PRE-001'), itemId('OWNER-REVIEW-001'))
    db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE id = ?')
      .run(itemId('OWNER-REVIEW-001'), itemId('PRE-001'))

    expect(detectWorkGraphCycles(db, PROJECT)).toEqual({
      hierarchyCycles: [[itemId('OWNER-REVIEW-001'), itemId('PRE-001'), itemId('OWNER-REVIEW-001')]],
      orderingCycles: [],
    })
    db.close()
  })

  it('ignores non-ordering relations and edges outside the project', async () => {
    const db = await goldenLedger()
    db.prepare(
      'INSERT INTO work_items '
      + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
      + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
      + "VALUES ('wi:other:X', 'other', NULL, NULL, NULL, 'X', 'RESEARCH', 'AGENT', 'Foreign work', NULL, 0, "
      + "'READY', 0, 1, 1)",
    ).run()
    const insertRelation = db.prepare(
      'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
      + 'VALUES (?, ?, ?, ?, 1)',
    )
    insertRelation.run('rel:test:2', 'wi:other:X', itemId('PRE-001'), 'BLOCKS')
    insertRelation.run('rel:test:3', itemId('PRE-001'), itemId('SCHEMA-001'), 'RELATES_TO')

    expect(detectWorkGraphCycles(db, PROJECT)).toEqual({ hierarchyCycles: [], orderingCycles: [] })
    db.close()
  })

  it('a project without work items has no cycles', async () => {
    const db = await goldenLedger()
    expect(detectWorkGraphCycles(db, brandString<ProjectId>('fresh'))).toEqual({
      hierarchyCycles: [],
      orderingCycles: [],
    })
    db.close()
  })
})

describe('replay parity', () => {
  it('the fold stays equal to the materialized projection through status transitions', async () => {
    const db = await goldenLedger()
    setItemStatus(db, 'PRE-001', 'IN_PROGRESS')
    changeWorkStatus(db, itemId('PRE-001'), 'VERIFYING', { actorRef: 'agent/a', nowMs: 7 })
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:PRE-001:AC-PRE-001'),
      'PASS',
      { nowMs: 7 },
    )
    changeWorkStatus(db, itemId('PRE-001'), 'DONE', { actorRef: 'agent/a', nowMs: 8 })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed.workItems.get(itemId('PRE-001'))).toEqual({
      stableKey: 'PRE-001',
      title: 'Put v1.4/v1.5 design history and v1.6a fixtures in-repo',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      status: 'DONE',
      criteria: new Map([
        [brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:PRE-001:AC-PRE-001'), {
          ordinal: 0,
          criterionKind: 'COMMAND',
          required: true,
          status: 'PASSING',
        }],
      ]),
    })
    expect(replayed).toEqual(materializedProjection(db))
    db.close()
  })
})
