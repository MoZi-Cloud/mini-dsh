import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_LEASE_ACTOR_REF,
  DEFAULT_READINESS_ACTOR_REF,
  LeaseError,
  WorkReadinessError,
  appendProjectEvent,
  blockWorkItem,
  changeWorkStatus,
  compilePlan,
  claimWorkItem,
  computeWorkReadiness,
  evaluateAcceptanceCriterion,
  heartbeatWorkLease,
  importPlanVersion,
  parsePlanDocument,
  reapExpiredLeases,
  releaseWorkLease,
  replayProjectEvents,
  resolveLeaseConfig,
  unblockWorkItem,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type PlanWorkItemStatus,
  type ProjectId,
  type WorkItemId,
  type WorkLeaseId,
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

/** The SHA-256 hex the ledger stores for one lease token. */
function tokenHash(leaseToken: string): string {
  return createHash('sha256').update(leaseToken).digest('hex')
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

/** Overwrite a work item status directly — the seam of writers this package does not own. */
function setItemStatus(db: DatabaseSync, stableKey: string, status: PlanWorkItemStatus): void {
  db.prepare('UPDATE work_items SET status = ? WHERE stable_key = ?').run(status, stableKey)
}

/** The materialized status of one golden work item. */
function itemStatus(db: DatabaseSync, stableKey: string): PlanWorkItemStatus {
  return (db.prepare('SELECT status FROM work_items WHERE stable_key = ?')
    .get(stableKey) as { status: PlanWorkItemStatus }).status
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

function leaseCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM work_leases').get() as { n: number }).n
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
  const workItems = new Map<string, unknown>()
  const itemRows = db.prepare('SELECT id, stable_key, title, plan_version_id, status FROM work_items')
    .all() as { id: string; stable_key: string; title: string; plan_version_id: string; status: string }[]
  for (const row of itemRows) {
    const criteria = new Map<string, unknown>()
    const criteriaRows = db.prepare(
      'SELECT id, ordinal, criterion_kind, required, status FROM acceptance_criteria WHERE work_item_id = ? ORDER BY ordinal',
    ).all(row.id) as { id: string; ordinal: number; criterion_kind: string; required: number; status: string }[]
    for (const criterion of criteriaRows) {
      criteria.set(criterion.id, {
        ordinal: criterion.ordinal,
        criterionKind: criterion.criterion_kind,
        required: criterion.required === 1,
        status: criterion.status,
      })
    }
    workItems.set(row.id, {
      stableKey: row.stable_key,
      title: row.title,
      planVersionId: row.plan_version_id,
      status: row.status,
      criteria,
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

describe('resolveLeaseConfig', () => {
  it('defaults to the documented policy and merges partial overrides', () => {
    expect(resolveLeaseConfig()).toEqual({ ttlMs: 300_000, heartbeatIntervalMs: 60_000, reaperIntervalMs: 30_000 })
    expect(resolveLeaseConfig({ ttlMs: 1000, heartbeatIntervalMs: 400 }))
      .toEqual({ ttlMs: 1000, heartbeatIntervalMs: 400, reaperIntervalMs: 30_000 })
    expect(resolveLeaseConfig({ ttlMs: 1000, heartbeatIntervalMs: 400, reaperIntervalMs: 200 }))
      .toEqual({ ttlMs: 1000, heartbeatIntervalMs: 400, reaperIntervalMs: 200 })
  })

  it('fails loud on a policy violating heartbeatIntervalMs < ttlMs / 2', () => {
    const exactlyHalf = thrownError(
      LeaseError,
      () => resolveLeaseConfig({ ttlMs: 300_000, heartbeatIntervalMs: 150_000 }),
    )
    expect(exactlyHalf.code).toBe('invalid-lease-config')
    expect(exactlyHalf.message)
      .toBe('lease config violates heartbeatIntervalMs < ttlMs / 2 (got ttlMs 300000, heartbeatIntervalMs 150000)')

    const overHalf = thrownError(
      LeaseError,
      () => resolveLeaseConfig({ ttlMs: 1000, heartbeatIntervalMs: 600 }),
    )
    expect(overHalf.message)
      .toBe('lease config violates heartbeatIntervalMs < ttlMs / 2 (got ttlMs 1000, heartbeatIntervalMs 600)')
  })

  it('fails loud on non-positive or non-integer fields', () => {
    for (const [config, message] of [
      [{ ttlMs: 0 }, 'lease config ttlMs must be a positive integer, got 0'],
      [{ ttlMs: 1.5 }, 'lease config ttlMs must be a positive integer, got 1.5'],
      [{ heartbeatIntervalMs: -1 }, 'lease config heartbeatIntervalMs must be a positive integer, got -1'],
      [{ reaperIntervalMs: 0 }, 'lease config reaperIntervalMs must be a positive integer, got 0'],
    ] as const) {
      expect(thrownError(LeaseError, () => resolveLeaseConfig(config)).message).toBe(message)
    }
  })
})

describe('claimWorkItem', () => {
  it('claims a ready item, storing the hashed token and the work/claimed event', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const target = itemId('SCHEMA-001')
    const claim = claimWorkItem(db, target, 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })

    expect(claim.leaseId).toBe('ls:wi:mini-dsh:SCHEMA-001:17')
    // The token is an asymmetric matcher inside `toEqual`, so it is asserted
    // beside the structural comparison instead.
    const { leaseToken, ...claimWithoutToken } = claim
    expect(claimWithoutToken).toEqual({
      leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17',
      workItemId: target,
      workerIdentity: 'worker-a',
      status: 'ACTIVE',
      acquiredAtMs: 1000,
      heartbeatAtMs: 1000,
      expiresAtMs: 2000,
      releasedAtMs: undefined,
      sequenceNo: 17,
    })
    expect(leaseToken).toMatch(/^[0-9a-f]{64}$/)
    expect(db.prepare(
      'SELECT id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, '
      + 'expires_at_ms, released_at_ms FROM work_leases',
    ).get()).toEqual({
      id: 'ls:wi:mini-dsh:SCHEMA-001:17',
      work_item_id: target,
      worker_identity: 'worker-a',
      lease_token_hash: tokenHash(claim.leaseToken),
      status: 'ACTIVE',
      acquired_at_ms: 1000,
      heartbeat_at_ms: 1000,
      expires_at_ms: 2000,
      released_at_ms: null,
    })
    expect(db.prepare(
      'SELECT event_type, ignorable, entity_type, entity_id, actor_ref, created_at_ms FROM project_events '
      + 'WHERE sequence_no = 17',
    ).get()).toEqual({
      event_type: 'work/claimed',
      ignorable: 0,
      entity_type: 'work_item',
      entity_id: target,
      actor_ref: DEFAULT_LEASE_ACTOR_REF,
      created_at_ms: 1000,
    })
    expect(eventPayload(db, 17)).toEqual({
      workItemId: target,
      leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17',
      workerIdentity: 'worker-a',
      fromStatus: 'BLOCKED',
      toStatus: 'IN_PROGRESS',
      acquiredAtMs: 1000,
      expiresAtMs: 2000,
    })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('IN_PROGRESS')
    db.close()
  })

  it('refuses a claim while readiness recomputes blocked, writing nothing', async () => {
    const db = await goldenLedger()
    const thrown = thrownError(
      LeaseError,
      () => claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', { nowMs: 1000 }),
    )
    expect(thrown.code).toBe('work-not-ready')
    expect(thrown.message).toBe(
      'work item "wi:mini-dsh:SCHEMA-001" is not ready to claim: '
      + 'plan version "plv:mini-dsh-v1.6a-ledger:v1" is DRAFT; work opens when the version is activated; '
      + 'phase "ph:plv:mini-dsh-v1.6a-ledger:v1:W01" is PLANNED; work opens when the phase is READY or ACTIVE; '
      + 'BLOCKS from "wi:mini-dsh:OWNER-REVIEW-001" (status READY) is not satisfied; '
      + 'the edge closes when the source item is DONE; '
      + 'BLOCKS from "wi:mini-dsh:PRE-001" (status READY) is not satisfied; '
      + 'the edge closes when the source item is DONE',
    )
    expect(thrown.reasons).toEqual(computeWorkReadiness(db, itemId('SCHEMA-001')).reasons)
    expect(eventCount(db)).toBe(16)
    expect(leaseCount(db)).toBe(0)
    db.close()
  })

  it('propagates the readiness error for an unknown work item', async () => {
    const db = await goldenLedger()
    const thrown = thrownError(
      WorkReadinessError,
      () => claimWorkItem(db, brandString<WorkItemId>('wi:mini-dsh:NOPE'), 'worker-a'),
    )
    expect(thrown.code).toBe('unknown-work-item')
    expect(leaseCount(db)).toBe(0)
    db.close()
  })

  it('rejects a second claimer while the first lease is live', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    const thrown = thrownError(
      LeaseError,
      () => claimWorkItem(db, itemId('SCHEMA-001'), 'worker-b', { nowMs: 1500 }),
    )
    expect(thrown.code).toBe('work-not-ready')
    expect(thrown.reasons).toEqual([
      {
        kind: 'work-status-closed',
        message: 'work item "wi:mini-dsh:SCHEMA-001" has status IN_PROGRESS and is not open for a claim',
      },
      {
        kind: 'lease-active',
        refId: 'ls:wi:mini-dsh:SCHEMA-001:17',
        message: 'active lease "ls:wi:mini-dsh:SCHEMA-001:17" held by worker-a expires at 2000',
      },
    ])
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_leases WHERE status = 'ACTIVE'").get()).toEqual({ n: 1 })
    expect(eventCount(db)).toBe(17)
    db.close()
  })

  it('reaps a stale lease for this item inside the claim transaction', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    setItemStatus(db, 'SCHEMA-001', 'READY')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-b', { nowMs: 5000 })

    expect(claim.leaseId).toBe('ls:wi:mini-dsh:SCHEMA-001:19')
    expect(db.prepare('SELECT status FROM work_leases WHERE id = ?').get('ls:wi:mini-dsh:SCHEMA-001:17'))
      .toEqual({ status: 'EXPIRED' })
    expect(eventPayload(db, 18)).toEqual({
      workItemId: itemId('SCHEMA-001'),
      leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17',
      workerIdentity: 'worker-a',
      toStatus: 'READY',
    })
    expect(eventPayload(db, 19)).toMatchObject({ workerIdentity: 'worker-b', fromStatus: 'READY' })
    db.close()
  })
})

describe('heartbeatWorkLease', () => {
  it('extends only the holder lease and records the heartbeat event', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    const lease = heartbeatWorkLease(db, leaseId, claim.leaseToken, {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1500,
    })

    expect(lease).toEqual({
      leaseId,
      workItemId: itemId('SCHEMA-001'),
      workerIdentity: 'worker-a',
      status: 'ACTIVE',
      acquiredAtMs: 1000,
      heartbeatAtMs: 1500,
      expiresAtMs: 2500,
      releasedAtMs: undefined,
    })
    expect(db.prepare('SELECT heartbeat_at_ms, expires_at_ms FROM work_leases WHERE id = ?').get(leaseId))
      .toEqual({ heartbeat_at_ms: 1500, expires_at_ms: 2500 })
    expect(db.prepare('SELECT entity_type, entity_id, actor_ref FROM project_events WHERE sequence_no = 18').get())
      .toEqual({ entity_type: 'work_lease', entity_id: leaseId, actor_ref: DEFAULT_LEASE_ACTOR_REF })
    expect(eventPayload(db, 18)).toEqual({
      workItemId: itemId('SCHEMA-001'),
      leaseId,
      workerIdentity: 'worker-a',
      expiresAtMs: 2500,
    })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('IN_PROGRESS')
    db.close()
  })

  it('refuses a wrong token without writing', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', { nowMs: 1000 })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    const thrown = thrownError(LeaseError, () => heartbeatWorkLease(db, leaseId, 'not-the-token', { nowMs: 1500 }))
    expect(thrown.code).toBe('lease-token-mismatch')
    expect(thrown.message).toBe(
      `work lease "${leaseId}" token does not match; only the lease holder may extend or release it`,
    )
    expect(eventCount(db)).toBe(17)
    expect(db.prepare('SELECT expires_at_ms FROM work_leases WHERE id = ?').get(leaseId))
      .toEqual({ expires_at_ms: 300_000 + 1000 })
    db.close()
  })

  it('refuses an unknown lease', async () => {
    const db = await goldenLedger()
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:99')
    const thrown = thrownError(LeaseError, () => heartbeatWorkLease(db, leaseId, 'token'))
    expect(thrown.code).toBe('unknown-lease')
    expect(thrown.message).toBe(`work lease "${leaseId}" is not recorded in this ledger`)
    db.close()
  })

  it('refuses a lease that is no longer active', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
      nowMs: 1000,
    })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    releaseWorkLease(db, leaseId, claim.leaseToken, { nowMs: 1500 })
    const thrown = thrownError(LeaseError, () => heartbeatWorkLease(db, leaseId, claim.leaseToken, { nowMs: 1600 }))
    expect(thrown.code).toBe('lease-not-active')
    expect(thrown.message).toBe(`work lease "${leaseId}" has status RELEASED; only an ACTIVE lease can be heartbeated`)
    db.close()
  })

  it('refuses a heartbeat at or past expiry instead of resurrecting the lease', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    const thrown = thrownError(LeaseError, () => heartbeatWorkLease(db, leaseId, claim.leaseToken, { nowMs: 2000 }))
    expect(thrown.code).toBe('lease-not-active')
    expect(thrown.message).toBe(
      `work lease "${leaseId}" expired at 2000; the reaper owns recovery and this call cannot resurrect it`,
    )
    expect(db.prepare('SELECT heartbeat_at_ms, expires_at_ms FROM work_leases WHERE id = ?').get(leaseId))
      .toEqual({ heartbeat_at_ms: 1000, expires_at_ms: 2000 })
    expect(eventCount(db)).toBe(17)
    db.close()
  })
})

describe('releaseWorkLease', () => {
  it('releases the lease and recomputes the in-flight item to READY', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
      nowMs: 1000,
    })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    const lease = releaseWorkLease(db, leaseId, claim.leaseToken, { nowMs: 1500 })

    expect(lease).toEqual({
      leaseId,
      workItemId: itemId('SCHEMA-001'),
      workerIdentity: 'worker-a',
      status: 'RELEASED',
      acquiredAtMs: 1000,
      heartbeatAtMs: 1000,
      expiresAtMs: 11_000,
      releasedAtMs: 1500,
    })
    expect(db.prepare('SELECT status, released_at_ms FROM work_leases WHERE id = ?').get(leaseId))
      .toEqual({ status: 'RELEASED', released_at_ms: 1500 })
    expect(eventPayload(db, 18)).toEqual({
      workItemId: itemId('SCHEMA-001'),
      leaseId,
      workerIdentity: 'worker-a',
      toStatus: 'READY',
    })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('READY')
    db.close()
  })

  it('recomputes onto BLOCKED when the release finds open blockers', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
      nowMs: 1000,
    })
    evaluateAcceptanceCriterion(db, criterionId('SCHEMA-001', 'AC-SCHEMA-001'), 'FAIL', { nowMs: 1200 })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    const lease = releaseWorkLease(db, leaseId, claim.leaseToken, { nowMs: 1500 })
    expect(lease.status).toBe('RELEASED')
    expect(eventPayload(db, 19)).toMatchObject({ toStatus: 'BLOCKED' })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('BLOCKED')
    db.close()
  })

  it('refuses a wrong token, an unknown lease, a past-expiry call, and a second release', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
      nowMs: 1000,
    })
    const leaseId = brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:17')
    const mismatch = thrownError(LeaseError, () => releaseWorkLease(db, leaseId, 'wrong', { nowMs: 1500 }))
    expect(mismatch.code).toBe('lease-token-mismatch')

    const unknown = thrownError(
      LeaseError,
      () => releaseWorkLease(db, brandString<WorkLeaseId>('ls:wi:mini-dsh:SCHEMA-001:99'), 'token'),
    )
    expect(unknown.code).toBe('unknown-lease')

    releaseWorkLease(db, leaseId, claim.leaseToken, { nowMs: 1500 })
    const again = thrownError(LeaseError, () => releaseWorkLease(db, leaseId, claim.leaseToken, { nowMs: 1600 }))
    expect(again.code).toBe('lease-not-active')
    expect(again.message).toBe(`work lease "${leaseId}" has status RELEASED; only an ACTIVE lease can be released`)
    db.close()
  })
})

describe('reapExpiredLeases', () => {
  it('expires stale leases and recomputes abandoned items to READY', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    const reaped = reapExpiredLeases(db, { nowMs: 5000 })

    expect(reaped).toEqual([
      {
        leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17',
        workItemId: itemId('SCHEMA-001'),
        workerIdentity: 'worker-a',
        fromItemStatus: 'IN_PROGRESS',
        toItemStatus: 'READY',
        sequenceNo: 18,
      },
    ])
    expect(db.prepare('SELECT status, released_at_ms FROM work_leases').get())
      .toEqual({ status: 'EXPIRED', released_at_ms: null })
    expect(eventPayload(db, 18)).toEqual({
      workItemId: itemId('SCHEMA-001'),
      leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17',
      workerIdentity: 'worker-a',
      toStatus: 'READY',
    })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('READY')
    expect(reapExpiredLeases(db, { nowMs: 5000 })).toEqual([])
    db.close()
  })

  it('recomputes an abandoned item onto BLOCKED when a required criterion is failing', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    evaluateAcceptanceCriterion(db, criterionId('SCHEMA-001', 'AC-SCHEMA-001'), 'FAIL', { nowMs: 1500 })
    const reaped = reapExpiredLeases(db, { nowMs: 5000 })

    expect(reaped).toEqual([
      expect.objectContaining({ leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17', toItemStatus: 'BLOCKED', sequenceNo: 19 }),
    ])
    expect(itemStatus(db, 'SCHEMA-001')).toBe('BLOCKED')
    db.close()
  })

  it('reaps in bounded batches, leaves non-in-flight statuses alone, and never declares FAILED', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    setItemStatus(db, 'SCHEMA-001', 'DONE')
    db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W02')
    claimWorkItem(db, itemId('DB-001'), 'worker-b', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    setItemStatus(db, 'DB-001', 'DONE')
    db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W03')
    claimWorkItem(db, itemId('IMPORT-001'), 'worker-c', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })

    const firstBatch = reapExpiredLeases(db, { limit: 2, nowMs: 5000 })
    expect(firstBatch.map(lease => lease.leaseId))
      .toEqual(['ls:wi:mini-dsh:DB-001:18', 'ls:wi:mini-dsh:IMPORT-001:19'])
    // DB-001's lifecycle moved on to DONE while its lease was live, so the
    // reaper leaves it; IMPORT-001's edge source is that DONE item, so its
    // abandoned IN_PROGRESS recomputes READY.
    expect(firstBatch.map(lease => lease.toItemStatus)).toEqual(['DONE', 'READY'])

    const secondBatch = reapExpiredLeases(db, { limit: 2, nowMs: 5000 })
    expect(secondBatch).toEqual([
      {
        leaseId: 'ls:wi:mini-dsh:SCHEMA-001:17',
        workItemId: itemId('SCHEMA-001'),
        workerIdentity: 'worker-a',
        fromItemStatus: 'DONE',
        toItemStatus: 'DONE',
        sequenceNo: 22,
      },
    ])
    expect(itemStatus(db, 'SCHEMA-001')).toBe('DONE')
    expect(itemStatus(db, 'DB-001')).toBe('DONE')
    expect(itemStatus(db, 'IMPORT-001')).toBe('READY')
    db.close()
  })

  it('refuses a non-positive reap limit', async () => {
    const db = await goldenLedger()
    const thrown = thrownError(LeaseError, () => reapExpiredLeases(db, { limit: 0 }))
    expect(thrown.code).toBe('invalid-argument')
    expect(thrown.message).toBe('reap limit must be a positive integer, got 0')
    db.close()
  })
})

describe('blockWorkItem and unblockWorkItem', () => {
  it('unblocks a BLOCKED item once its readiness recomputes clean', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const change = unblockWorkItem(db, itemId('SCHEMA-001'), { nowMs: 100 })

    expect(change).toEqual({
      workItemId: itemId('SCHEMA-001'),
      fromStatus: 'BLOCKED',
      toStatus: 'READY',
      readiness: { ready: true, reasons: [] },
      sequenceNo: 17,
      createdAtMs: 100,
    })
    expect(db.prepare(
      'SELECT event_type, entity_type, entity_id, actor_ref FROM project_events WHERE sequence_no = 17',
    ).get()).toEqual({
      event_type: 'work/unblocked',
      entity_type: 'work_item',
      entity_id: itemId('SCHEMA-001'),
      actor_ref: DEFAULT_READINESS_ACTOR_REF,
    })
    expect(eventPayload(db, 17)).toEqual({
      workItemId: itemId('SCHEMA-001'),
      fromStatus: 'BLOCKED',
      toStatus: 'READY',
    })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('READY')
    // The applier path rides along here: the fold moves the item the same
    // way. Full parity lives in the event-driven parity test.
    expect(replayProjectEvents(db, PROJECT).workItems.get(itemId('SCHEMA-001'))?.status).toBe('READY')
    const repeat = thrownError(LeaseError, () => unblockWorkItem(db, itemId('SCHEMA-001')))
    expect(repeat.code).toBe('nothing-to-unblock')
    expect(repeat.message).toBe('work item "wi:mini-dsh:SCHEMA-001" is already materialized as READY')
    db.close()
  })

  it('blocks a READY item whose readiness recomputes blocked, carrying the recomputed reasons', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    unblockWorkItem(db, itemId('SCHEMA-001'), { nowMs: 100 })
    evaluateAcceptanceCriterion(db, criterionId('SCHEMA-001', 'AC-SCHEMA-001'), 'FAIL', { nowMs: 150 })
    const reasons = [
      {
        kind: 'acceptance-criterion-blocked',
        refId: 'ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001',
        message: 'required acceptance criterion "ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001" is FAILING',
      },
    ]
    const change = blockWorkItem(db, itemId('SCHEMA-001'), { nowMs: 200 })

    expect(change).toEqual({
      workItemId: itemId('SCHEMA-001'),
      fromStatus: 'READY',
      toStatus: 'BLOCKED',
      readiness: { ready: false, reasons },
      sequenceNo: 19,
      createdAtMs: 200,
    })
    expect(eventPayload(db, 19)).toEqual({
      workItemId: itemId('SCHEMA-001'),
      fromStatus: 'READY',
      toStatus: 'BLOCKED',
      reasons,
    })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('BLOCKED')
    // The default clock and actor resolve inside the writer, not the caller.
    const repeat = thrownError(LeaseError, () => blockWorkItem(db, itemId('SCHEMA-001')))
    expect(repeat.code).toBe('nothing-to-block')
    expect(repeat.message).toBe('work item "wi:mini-dsh:SCHEMA-001" is already materialized as BLOCKED')
    db.close()
  })

  it('refuses projection moves with nothing to materialize', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    unblockWorkItem(db, itemId('SCHEMA-001'), { nowMs: 100 })
    const blockReady = thrownError(LeaseError, () => blockWorkItem(db, itemId('SCHEMA-001'), { nowMs: 150 }))
    expect(blockReady.code).toBe('nothing-to-block')
    expect(blockReady.message).toBe(
      'work item "wi:mini-dsh:SCHEMA-001" recomputes ready; there is nothing to materialize as BLOCKED',
    )
    db.close()

    const stale = await goldenLedger()
    const blockBlocked = thrownError(LeaseError, () => blockWorkItem(stale, itemId('SCHEMA-001'), { nowMs: 150 }))
    expect(blockBlocked.code).toBe('nothing-to-block')
    expect(blockBlocked.message).toBe('work item "wi:mini-dsh:SCHEMA-001" is already materialized as BLOCKED')

    const unblockBlocked = thrownError(LeaseError, () => unblockWorkItem(stale, itemId('SCHEMA-001'), { nowMs: 150 }))
    expect(unblockBlocked.code).toBe('nothing-to-unblock')
    expect(unblockBlocked.message).toBe(
      'work item "wi:mini-dsh:SCHEMA-001" recomputes blocked: '
      + 'plan version "plv:mini-dsh-v1.6a-ledger:v1" is DRAFT; work opens when the version is activated; '
      + 'phase "ph:plv:mini-dsh-v1.6a-ledger:v1:W01" is PLANNED; work opens when the phase is READY or ACTIVE; '
      + 'BLOCKS from "wi:mini-dsh:OWNER-REVIEW-001" (status READY) is not satisfied; '
      + 'the edge closes when the source item is DONE; '
      + 'BLOCKS from "wi:mini-dsh:PRE-001" (status READY) is not satisfied; '
      + 'the edge closes when the source item is DONE',
    )
    stale.close()

    const done = await goldenLedger()
    makeClaimable(done, 'W01')
    unblockWorkItem(done, itemId('SCHEMA-001'), { nowMs: 100 })
    claimWorkItem(done, itemId('SCHEMA-001'), 'worker-a', { nowMs: 150 })
    const unblockInFlight = thrownError(
      LeaseError,
      () => unblockWorkItem(done, itemId('SCHEMA-001'), { nowMs: 200 }),
    )
    expect(unblockInFlight.code).toBe('nothing-to-unblock')
    expect(unblockInFlight.message).toBe(
      'work item "wi:mini-dsh:SCHEMA-001" recomputes blocked: '
      + 'work item "wi:mini-dsh:SCHEMA-001" has status IN_PROGRESS and is not open for a claim; '
      + 'active lease "ls:wi:mini-dsh:SCHEMA-001:18" held by worker-a expires at 300150',
    )
    done.close()
  })

  it('refuses projection moves on items outside the READY/BLOCKED pair', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
      nowMs: 1000,
    })
    const inFlight = thrownError(LeaseError, () => blockWorkItem(db, itemId('SCHEMA-001'), { nowMs: 1500 }))
    expect(inFlight.code).toBe('status-not-projectable')
    expect(inFlight.message).toBe(
      'work item "wi:mini-dsh:SCHEMA-001" has status IN_PROGRESS; '
      + 'the readiness projection only moves READY and BLOCKED items',
    )
    db.close()

    const proposed = await goldenLedger()
    makeClaimable(proposed, 'W01')
    setItemStatus(proposed, 'SCHEMA-001', 'PROPOSED')
    const unblockProposed = thrownError(
      LeaseError,
      () => unblockWorkItem(proposed, itemId('SCHEMA-001'), { nowMs: 1500 }),
    )
    expect(unblockProposed.code).toBe('status-not-projectable')
    expect(unblockProposed.message).toBe(
      'work item "wi:mini-dsh:SCHEMA-001" has status PROPOSED; '
      + 'the readiness projection only moves READY and BLOCKED items',
    )
    proposed.close()
  })
})

describe('two connections contending for one claim', () => {
  it('a claimer holding the write lock excludes the second claimer, and the index backstops the lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-ledger-lease-'))
    const dbA = await openProjectLedgerDatabase(join(dir, 'ledger.sqlite'))
    const dbB = await openProjectLedgerDatabase(join(dir, 'ledger.sqlite'))
    try {
      importPlanVersion(dbA, compileGolden())
      makeClaimable(dbA, 'W01')
      const target = itemId('SCHEMA-001')

      // Connection A holds the claim's write transaction uncommitted while
      // connection B attempts its own claim: the loser must hit the lock, not
      // observe a half-claimed item.
      dbA.exec('BEGIN IMMEDIATE')
      dbA.prepare(
        'INSERT INTO work_leases '
        + '(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms) '
        + "VALUES ('ls:wi:mini-dsh:SCHEMA-001:999', ?, 'holder', 'hash', 'ACTIVE', 1, 1, 9999999999999)",
      ).run(target)
      dbB.exec('PRAGMA busy_timeout = 50')
      expect(() => claimWorkItem(dbB, target, 'worker-b', { nowMs: 1000 })).toThrow(/database is locked/)
      dbA.exec('COMMIT')

      const thrown = thrownError(LeaseError, () => claimWorkItem(dbB, target, 'worker-b', { nowMs: 1000 }))
      expect(thrown.code).toBe('work-not-ready')
      expect(thrown.reasons).toEqual([
        {
          kind: 'lease-active',
          refId: 'ls:wi:mini-dsh:SCHEMA-001:999',
          message: 'active lease "ls:wi:mini-dsh:SCHEMA-001:999" held by holder expires at 9999999999999',
        },
      ])
      expect(dbB.prepare("SELECT COUNT(*) AS n FROM work_leases WHERE status = 'ACTIVE'").get()).toEqual({ n: 1 })
      expect(() => dbB.prepare(
        'INSERT INTO work_leases '
        + '(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms) '
        + "VALUES ('ls:wi:mini-dsh:SCHEMA-001:998', ?, 'double', 'hash', 'ACTIVE', 1, 1, 9999999999999)",
      ).run(target)).toThrow(/UNIQUE constraint failed/)
    } finally {
      dbA.close()
      dbB.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('lease write failures roll back', () => {
  it('a trigger-forced lease insert rolls back the whole claim', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    db.exec('CREATE TRIGGER forced_lease_reject BEFORE INSERT ON work_leases '
      + 'BEGIN SELECT RAISE(ABORT, \'forced lease rejection\'); END')
    expect(() => claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', { nowMs: 1000 }))
      .toThrow('forced lease rejection')
    expect(eventCount(db)).toBe(16)
    expect(leaseCount(db)).toBe(0)
    expect(itemStatus(db, 'SCHEMA-001')).toBe('BLOCKED')
    db.exec('DROP TRIGGER forced_lease_reject')
    db.close()
  })

  it('a trigger-forced event insert rolls back the whole reaper batch', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
      leaseConfig: { ttlMs: 1000, heartbeatIntervalMs: 400 },
      nowMs: 1000,
    })
    db.exec('CREATE TRIGGER forced_event_reject BEFORE INSERT ON project_events '
      + 'BEGIN SELECT RAISE(ABORT, \'forced event rejection\'); END')
    expect(() => reapExpiredLeases(db, { nowMs: 5000 })).toThrow('forced event rejection')
    expect(eventCount(db)).toBe(17)
    expect(db.prepare('SELECT status FROM work_leases').get()).toEqual({ status: 'ACTIVE' })
    expect(itemStatus(db, 'SCHEMA-001')).toBe('IN_PROGRESS')
    db.exec('DROP TRIGGER forced_event_reject')
    db.close()
  })
})

describe('lease replay parity', () => {
  it('rebuilds the lease lifecycle and item statuses from the events', async () => {
    const db = await goldenLedger()
    // Only the unprojected rows (version and phase status) are written
    // directly; every work-item status moves through vocabulary writers so
    // the replay can rebuild it.
    db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
    const target = itemId('SCHEMA-001')
    const owner = itemId('OWNER-REVIEW-001')
    const pre = itemId('PRE-001')

    // OWNER-REVIEW-001 and PRE-001 complete through claim → VERIFYING →
    // acceptance PASS → DONE, the only lawful completion path.
    const ownerClaim = claimWorkItem(db, owner, 'worker-owner', { nowMs: 1000 })
    expect(ownerClaim.leaseId).toBe('ls:wi:mini-dsh:OWNER-REVIEW-001:17')
    changeWorkStatus(db, owner, 'VERIFYING', { nowMs: 1050 })
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:OWNER-REVIEW-001:AC-OWNER-001'),
      'PASS',
      { nowMs: 1080 },
    )
    changeWorkStatus(db, owner, 'DONE', { nowMs: 1100 })
    const preClaim = claimWorkItem(db, pre, 'worker-pre', { nowMs: 1150 })
    changeWorkStatus(db, pre, 'VERIFYING', { nowMs: 1200 })
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:PRE-001:AC-PRE-001'),
      'PASS',
      { nowMs: 1230 },
    )
    changeWorkStatus(db, pre, 'DONE', { nowMs: 1250 })
    expect(preClaim.status).toBe('ACTIVE')

    db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W01')
    const first = claimWorkItem(db, target, 'worker-a', {
      leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
      nowMs: 1300,
    })
    heartbeatWorkLease(db, first.leaseId, first.leaseToken, { nowMs: 1500 })
    releaseWorkLease(db, first.leaseId, first.leaseToken, { nowMs: 1800 })
    const second = claimWorkItem(db, target, 'worker-b', { nowMs: 2000 })
    reapExpiredLeases(db, { nowMs: 400_000 })

    expect(second.leaseId).toBe('ls:wi:mini-dsh:SCHEMA-001:28')
    expect(replayProjectEvents(db, PROJECT)).toEqual(materializedProjection(db))
    expect(itemStatus(db, 'SCHEMA-001')).toBe('READY')
    expect(itemStatus(db, 'OWNER-REVIEW-001')).toBe('DONE')
    db.close()
  })
})

describe('replay fails closed on contradictory lease payloads', () => {
  it('rejects mistyped work/claimed payloads', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    appendProjectEvent(db, PROJECT, 'work/claimed', {
      workItemId: itemId('SCHEMA-001'),
      leaseId: 'ls:x:1',
      workerIdentity: 'worker-a',
      fromStatus: 'READY',
      toStatus: 'IN_PROGRESS',
      acquiredAtMs: 1,
      expiresAtMs: 2,
    }, { nowMs: 1 })
    const carrier = 17

    for (const [payload, message] of [
      [{}, 'payload field "workItemId" must be a string'],
      [{ workItemId: itemId('SCHEMA-001') }, 'payload field "leaseId" must be a string'],
      [{
        workItemId: itemId('SCHEMA-001'),
        leaseId: 'ls:x:1',
      }, 'payload field "workerIdentity" must be a string'],
      [{
        workItemId: itemId('SCHEMA-001'),
        leaseId: 'ls:x:1',
        workerIdentity: 'worker-a',
      }, 'payload field "fromStatus" must be a string'],
      [{
        workItemId: itemId('SCHEMA-001'),
        leaseId: 'ls:x:1',
        workerIdentity: 'worker-a',
        fromStatus: 'READY',
        toStatus: 'IN_PROGRESS',
      }, 'payload field "acquiredAtMs" must be a number'],
      [{
        workItemId: itemId('SCHEMA-001'),
        leaseId: 'ls:x:1',
        workerIdentity: 'worker-a',
        fromStatus: 'READY',
        toStatus: 'IN_PROGRESS',
        acquiredAtMs: 1,
      }, 'payload field "expiresAtMs" must be a number'],
      [{
        workItemId: itemId('SCHEMA-001'),
        leaseId: 'ls:x:1',
        workerIdentity: 'worker-a',
        fromStatus: 'SPICED',
        toStatus: 'IN_PROGRESS',
        acquiredAtMs: 1,
        expiresAtMs: 2,
      }, 'payload field "fromStatus" is not a work item status: "SPICED"'],
      [{
        workItemId: brandString<WorkItemId>('wi:mini-dsh:NOPE'),
        leaseId: 'ls:x:1',
        workerIdentity: 'worker-a',
        fromStatus: 'READY',
        toStatus: 'IN_PROGRESS',
        acquiredAtMs: 1,
        expiresAtMs: 2,
      }, 'payload field "workItemId" names no replayed work item (wi:mini-dsh:NOPE)'],
      [{
        workItemId: itemId('SCHEMA-001'),
        leaseId: 'ls:x:1',
        workerIdentity: 'worker-a',
        fromStatus: 'READY',
        toStatus: 'VERIFYING',
        acquiredAtMs: 1,
        expiresAtMs: 2,
      }, 'payload field "toStatus" of a work/claimed event must be IN_PROGRESS, got "VERIFYING"'],
    ] as const) {
      rewritePayload(db, carrier, payload)
      expect(() => replayProjectEvents(db, PROJECT)).toThrow(
        `project event ${carrier} of "mini-dsh" ${message}`,
      )
    }
    db.close()
  })

  it('rejects a second claim of an already replayed lease id', async () => {
    const db = await goldenLedger()
    makeClaimable(db, 'W01')
    const payload = {
      workItemId: itemId('SCHEMA-001'),
      leaseId: 'ls:x:1',
      workerIdentity: 'worker-a',
      fromStatus: 'READY',
      toStatus: 'IN_PROGRESS',
      acquiredAtMs: 1,
      expiresAtMs: 2,
    }
    appendProjectEvent(db, PROJECT, 'work/claimed', payload, { nowMs: 1 })
    appendProjectEvent(db, PROJECT, 'work/claimed', { ...payload, workerIdentity: 'worker-b' }, { nowMs: 2 })
    expect(() => replayProjectEvents(db, PROJECT)).toThrow(
      'project event 18 of "mini-dsh" payload field "leaseId" names an already replayed work lease (ls:x:1)',
    )
    db.close()
  })

  it('rejects heartbeat, expired, and released payloads that contradict the replayed lease', async () => {
    // Each contradictory tail lives on its own ledger: replay fails closed at
    // the first contradiction, so earlier ones would mask later assertions.
    const claimed = async () => {
      const db = await goldenLedger()
      makeClaimable(db, 'W01')
      const claim = claimWorkItem(db, itemId('SCHEMA-001'), 'worker-a', {
        leaseConfig: { ttlMs: 10_000, heartbeatIntervalMs: 4000 },
        nowMs: 1000,
      })
      return { db, claim }
    }
    const leaseRefOf = (claim: { leaseId: WorkLeaseId }) => ({
      workItemId: itemId('SCHEMA-001'),
      leaseId: claim.leaseId,
      workerIdentity: 'worker-a',
    })

    {
      const { db, claim } = await claimed()
      const leaseRef = leaseRefOf(claim)
      appendProjectEvent(db, PROJECT, 'work/lease-heartbeat', { ...leaseRef, expiresAtMs: 2000 }, { nowMs: 2 })
      for (const [payload, message] of [
        [{}, 'payload field "workItemId" must be a string'],
        [{ ...leaseRef }, 'payload field "expiresAtMs" must be a number'],
        [{ ...leaseRef, expiresAtMs: 'soon' }, 'payload field "expiresAtMs" must be a number'],
        [{
          ...leaseRef,
          leaseId: 'ls:wi:mini-dsh:SCHEMA-001:99',
          expiresAtMs: 2,
        }, 'payload field "leaseId" names no replayed work lease (ls:wi:mini-dsh:SCHEMA-001:99)'],
      ] as const) {
        rewritePayload(db, 18, payload)
        expect(() => replayProjectEvents(db, PROJECT)).toThrow(`project event 18 of "mini-dsh" ${message}`)
      }
      db.close()
    }

    {
      const { db, claim } = await claimed()
      const leaseRef = leaseRefOf(claim)
      appendProjectEvent(db, PROJECT, 'work/lease-expired', { ...leaseRef, toStatus: 'READY' }, { nowMs: 2 })
      for (const [payload, message] of [
        [{ ...leaseRef }, 'payload field "toStatus" must be a string'],
        [{
          ...leaseRef,
          toStatus: 'SPICED',
        }, 'payload field "toStatus" is not a work item status: "SPICED"'],
        [{
          ...leaseRef,
          leaseId: 'ls:wi:mini-dsh:SCHEMA-001:99',
          toStatus: 'READY',
        }, 'payload field "leaseId" names no replayed work lease (ls:wi:mini-dsh:SCHEMA-001:99)'],
        [{
          workItemId: brandString<WorkItemId>('wi:mini-dsh:NOPE'),
          leaseId: claim.leaseId,
          workerIdentity: 'worker-a',
          toStatus: 'READY',
        }, 'payload field "workItemId" names no replayed work item (wi:mini-dsh:NOPE)'],
      ] as const) {
        rewritePayload(db, 18, payload)
        expect(() => replayProjectEvents(db, PROJECT)).toThrow(`project event 18 of "mini-dsh" ${message}`)
      }
      db.close()
    }

    {
      // A heartbeat arriving after the lease expired is contradictory.
      const { db, claim } = await claimed()
      const leaseRef = leaseRefOf(claim)
      appendProjectEvent(db, PROJECT, 'work/lease-expired', { ...leaseRef, toStatus: 'READY' }, { nowMs: 2 })
      appendProjectEvent(db, PROJECT, 'work/lease-heartbeat', { ...leaseRef, expiresAtMs: 9 }, { nowMs: 3 })
      expect(() => replayProjectEvents(db, PROJECT)).toThrow(
        `project event 19 of "mini-dsh" payload heartbeats work lease "${claim.leaseId}" whose replayed status is EXPIRED`,
      )
      db.close()
    }

    {
      // A second expiry of the same lease contradicts the replayed lifecycle.
      const { db, claim } = await claimed()
      const leaseRef = leaseRefOf(claim)
      appendProjectEvent(db, PROJECT, 'work/lease-expired', { ...leaseRef, toStatus: 'READY' }, { nowMs: 2 })
      appendProjectEvent(db, PROJECT, 'work/lease-expired', { ...leaseRef, toStatus: 'READY' }, { nowMs: 3 })
      expect(() => replayProjectEvents(db, PROJECT)).toThrow(
        `project event 19 of "mini-dsh" payload expires work lease "${claim.leaseId}" whose replayed status is EXPIRED`,
      )
      db.close()
    }

    {
      // So does a release of the already-expired lease.
      const { db, claim } = await claimed()
      const leaseRef = leaseRefOf(claim)
      appendProjectEvent(db, PROJECT, 'work/lease-expired', { ...leaseRef, toStatus: 'READY' }, { nowMs: 2 })
      appendProjectEvent(db, PROJECT, 'work/lease-released', { ...leaseRef, toStatus: 'READY' }, { nowMs: 3 })
      expect(() => replayProjectEvents(db, PROJECT)).toThrow(
        `project event 19 of "mini-dsh" payload releases work lease "${claim.leaseId}" whose replayed status is EXPIRED`,
      )
      db.close()
    }
  })

  it('rejects mistyped work/blocked and work/unblocked payloads', async () => {
    const db = await goldenLedger()
    const validReasons = [{ kind: 'lease-active', refId: 'ls:x:1', message: 'm' }]
    const blockedBase = {
      workItemId: itemId('SCHEMA-001'),
      fromStatus: 'READY',
      toStatus: 'BLOCKED',
      reasons: validReasons,
    }
    appendProjectEvent(db, PROJECT, 'work/blocked', blockedBase, { nowMs: 1 })
    const carrier = 17

    for (const [payload, message] of [
      [{ workItemId: itemId('SCHEMA-001'), fromStatus: 'READY', toStatus: 'BLOCKED' }, 'payload field "reasons" must be an array'],
      [{ ...blockedBase, reasons: 'spice' }, 'payload field "reasons" must be an array'],
      [{ ...blockedBase, reasons: [42] }, 'payload field "reasons[0]" must be an object'],
      [{ ...blockedBase, reasons: [{ message: 'm' }] }, 'payload field "reasons[0].kind" must be a string'],
      [{ ...blockedBase, reasons: [{ kind: 'TELEPORT', message: 'm' }] }, 'payload field "reasons[0].kind" is not a readiness blocker kind: "TELEPORT"'],
      [{ ...blockedBase, reasons: [{ kind: 'lease-active' }] }, 'payload field "reasons[0].message" must be a string'],
      [{ ...blockedBase, reasons: [{ kind: 'lease-active', message: 'm', refId: 42 }] }, 'payload field "reasons[0].refId" must be a string'],
      [{ ...blockedBase, toStatus: 'READY' }, 'payload field "toStatus" of a work/blocked event must be BLOCKED, got "READY"'],
      [{ ...blockedBase, workItemId: brandString<WorkItemId>('wi:mini-dsh:NOPE') }, 'payload field "workItemId" names no replayed work item (wi:mini-dsh:NOPE)'],
    ] as const) {
      rewritePayload(db, carrier, payload)
      expect(() => replayProjectEvents(db, PROJECT)).toThrow(
        `project event ${carrier} of "mini-dsh" ${message}`,
      )
    }

    // Restore the carrier before appending the unblocked tail so its cases
    // are the first contradiction the replay meets.
    rewritePayload(db, carrier, blockedBase)
    const unblockedBase = { workItemId: itemId('SCHEMA-001'), fromStatus: 'BLOCKED', toStatus: 'READY' }
    appendProjectEvent(db, PROJECT, 'work/unblocked', unblockedBase, { nowMs: 2 })
    rewritePayload(db, 18, { ...unblockedBase, toStatus: 'BLOCKED' })
    expect(() => replayProjectEvents(db, PROJECT)).toThrow(
      'project event 18 of "mini-dsh" payload field "toStatus" of a work/unblocked event must be READY, got "BLOCKED"',
    )
    rewritePayload(db, 18, { ...unblockedBase, workItemId: brandString<WorkItemId>('wi:mini-dsh:NOPE') })
    expect(() => replayProjectEvents(db, PROJECT)).toThrow(
      'project event 18 of "mini-dsh" payload field "workItemId" names no replayed work item (wi:mini-dsh:NOPE)',
    )
    db.close()
  })
})
