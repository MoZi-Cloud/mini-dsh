import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_IMPORT_ACTOR_REF,
  PROJECT_EVENT_FORMAT_VERSION,
  ProjectEventError,
  appendProjectEvent,
  compilePlan,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  readProjectEvents,
  recordDecision,
  replayProjectEvents,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type AcceptanceCriterionStatus,
  type CompiledPlan,
  type DecisionId,
  type DecisionRequestId,
  type PlanAcceptanceKind,
  type PlanId,
  type PlanVersionId,
  type PlanWorkItemStatus,
  type ProjectEventEnvelope,
  type ProjectId,
  type ReplayedCriterion,
  type ReplayedDecision,
  type ReplayedDecisionRequest,
  type ReplayedLease,
  type ReplayedLeaseStatus,
  type ReplayedPlanVersion,
  type ReplayedProjectProjection,
  type ReplayedWorkItem,
  type SourceDocumentHash,
  type WorkItemId,
  type WorkLeaseId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_SOURCE_HASH = createHash('sha256').update(GOLDEN_PLAN_TEXT, 'utf8').digest('hex')

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
 * Call a thunk and return the ProjectEventError it threw; any other outcome
 * fails the test through the instance assertion or the unreachable marker.
 */
function thrownEventError(call: () => unknown): ProjectEventError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProjectEventError)
    return error as ProjectEventError
  }
  expect.unreachable('expected the call to throw ProjectEventError')
}

/**
 * Insert an event row directly, bypassing the codec — the seam for rows a
 * newer or misbehaving writer could leave behind. The sequence is the
 * project's next one, mirroring a real append.
 */
function insertRawEvent(
  db: DatabaseSync,
  overrides: {
    readonly eventType: string
    readonly ignorable: number
    readonly eventFormatVersion?: number
    readonly payloadJson?: string
  },
): void {
  db.prepare(
    'INSERT INTO project_events '
    + '(project_id, sequence_no, event_format_version, event_type, ignorable, entity_type, entity_id, actor_ref, '
    + 'payload_json, created_at_ms) '
    + 'VALUES (?, (SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM project_events WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(
    PROJECT,
    PROJECT,
    overrides.eventFormatVersion ?? PROJECT_EVENT_FORMAT_VERSION,
    overrides.eventType,
    overrides.ignorable,
    null,
    null,
    'raw-test',
    overrides.payloadJson ?? '{}',
  )
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
    .all() as { id: string; stable_key: string; title: string; plan_version_id: string | null; status: string }[]
  for (const row of itemRows) {
    workItems.set(brandString<WorkItemId>(row.id), {
      stableKey: row.stable_key,
      title: row.title,
      planVersionId: brandString<PlanVersionId>(row.plan_version_id!),
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
  const decisionRequests = new Map<DecisionRequestId, ReplayedDecisionRequest>()
  const decisions = new Map<DecisionId, ReplayedDecision>()
  for (const row of db.prepare(
    'SELECT r.id, r.decision_key, r.status, o.option_key FROM decision_requests r '
    + 'LEFT JOIN decision_options o ON o.decision_request_id = r.id',
  ).all() as { id: string; decision_key: string; status: string; option_key: string | null }[]) {
    const existing = decisionRequests.get(brandString<DecisionRequestId>(row.id))
    if (existing === undefined) {
      decisionRequests.set(brandString<DecisionRequestId>(row.id), {
        decisionKey: row.decision_key,
        optionKeys: new Set(row.option_key === null ? [] : [row.option_key]),
        status: row.status as 'OPEN' | 'RESOLVED',
      })
    } else if (row.option_key !== null) {
      decisionRequests.set(brandString<DecisionRequestId>(row.id), {
        ...existing,
        optionKeys: new Set([...existing.optionKeys, row.option_key]),
      })
    }
  }
  for (const row of db.prepare('SELECT id, decision_request_id, decided_by FROM decisions').all() as {
    id: string
    decision_request_id: string
    decided_by: string
  }[]) {
    decisions.set(brandString<DecisionId>(row.id), {
      requestId: brandString<DecisionRequestId>(row.decision_request_id),
      decidedBy: row.decided_by,
    })
  }
  // No test in this file prepares work packets; the rebuild seam owns packet parity.
  return { planVersions, workItems, leases, workPackets: new Map(), decisionRequests, decisions }
}

describe('appendProjectEvent', () => {
  it('allocates dense per-project sequences and stamps the envelope', async () => {
    const db = await goldenLedger()
    const payload = { workItemId: 'wi:mini-dsh:IMPORT-001', fromStatus: 'BLOCKED', toStatus: 'READY' }
    const envelope = appendProjectEvent(db, PROJECT, 'work/status-changed', payload, {
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:IMPORT-001',
      actorRef: 'tester',
      nowMs: 1234,
    })
    expect(envelope).toEqual({
      projectId: 'mini-dsh',
      sequenceNo: 17,
      eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION,
      eventType: 'work/status-changed',
      ignorable: false,
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:IMPORT-001',
      actorRef: 'tester',
      payload,
      createdAtMs: 1234,
    })
    expect(db.prepare('SELECT ignorable, payload_json FROM project_events WHERE project_id = ? AND sequence_no = 17')
      .get(PROJECT)).toEqual({ ignorable: 0, payload_json: JSON.stringify(payload) })

    const otherProject = appendProjectEvent(
      db,
      brandString<ProjectId>('p2'),
      'baseline/drift-detected',
      { repoHead: 'ff' },
      { nowMs: 5 },
    )
    expect(otherProject.sequenceNo).toBe(1)
    db.close()
  })

  it('refuses to record a required vocabulary entry as ignorable', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const attempt = (): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'work/created', { workItemId: 'wi:p:X' }, { ignorable: true, nowMs: 1 })
    expect(thrownEventError(attempt).code).toBe('required-event-not-ignorable')
    expect(thrownEventError(attempt).message)
      .toBe('project event "work/created" is a required vocabulary entry and is recorded as required; '
        + 'observational rows need an unregistered type')
    db.close()
  })

  it('requires the observational flag for unregistered types', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const unflagged = (): ProjectEventEnvelope =>
      appendProjectEvent(db, PROJECT, 'alien/spice-up', { note: 1 }, { nowMs: 1 })
    expect(thrownEventError(unflagged).code).toBe('unregistered-event-type')

    const observed = appendProjectEvent(db, PROJECT, 'alien/spice-up', { note: 1 }, { ignorable: true })
    expect(observed).toMatchObject({ eventType: 'alien/spice-up', ignorable: true, sequenceNo: 1 })
    expect(db.prepare('SELECT ignorable FROM project_events WHERE project_id = ? AND sequence_no = 1').get(PROJECT))
      .toEqual({ ignorable: 1 })
    db.close()
  })
})

describe('readProjectEvents', () => {
  it('returns the timeline in sequence order with decoded payloads', async () => {
    const db = await goldenLedger()
    const events = readProjectEvents(db, PROJECT)
    expect(events).toHaveLength(16)
    expect(events.map(event => event.sequenceNo)).toEqual([...events.keys()].map(offset => offset + 1))
    expect(events[0]).toMatchObject({
      sequenceNo: 1,
      eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION,
      eventType: 'plan/imported',
      ignorable: false,
      entityType: 'plan_version',
      entityId: 'plv:mini-dsh-v1.6a-ledger:v1',
      actorRef: DEFAULT_IMPORT_ACTOR_REF,
    })
    expect(events[0]!.payload).toEqual({
      planId: 'mini-dsh-v1.6a-ledger',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      versionNo: 1,
      sourceDocumentHash: GOLDEN_SOURCE_HASH,
    })
    db.close()
  })

  it('preserves unknown ignorable events in the read timeline', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/note', ignorable: 1, payloadJson: '{"note":"observed"}' })
    const events = readProjectEvents(db, PROJECT)
    expect(events).toHaveLength(17)
    expect(events[16]).toMatchObject({ eventType: 'alien/note', ignorable: true, payload: { note: 'observed' } })
    db.close()
  })

  it('fails closed on an unknown required event', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/rewrite', ignorable: 0 })
    expect(thrownEventError(() => readProjectEvents(db, PROJECT)).code).toBe('unknown-required-event')
    expect(thrownEventError(() => readProjectEvents(db, PROJECT)).message)
      .toBe('project event 17 of "mini-dsh" carries unknown required event "alien/rewrite"; '
        + 'a newer codec is required to read this ledger')
    db.close()
  })

  it('fails closed on an event format version newer than this build', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, eventFormatVersion: PROJECT_EVENT_FORMAT_VERSION + 1 })
    const thrown = thrownEventError(() => readProjectEvents(db, PROJECT))
    expect(thrown.code).toBe('event-format-unsupported')
    expect(thrown.message).toBe(
      `project event 17 of "mini-dsh" carries event format ${String(PROJECT_EVENT_FORMAT_VERSION + 1)}; `
      + `this build reads up to format ${String(PROJECT_EVENT_FORMAT_VERSION)}`,
    )
    db.close()
  })

  it('decodes rows stamped with an older adjacent event format', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, eventFormatVersion: 1 })
    const events = readProjectEvents(db, PROJECT)
    expect(events).toHaveLength(17)
    expect(events[16]).toMatchObject({ eventFormatVersion: 1, eventType: 'work/status-changed' })
    db.close()
  })

  it('fails closed on payload JSON that does not parse', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, payloadJson: '{oops' })
    const thrown = thrownEventError(() => readProjectEvents(db, PROJECT))
    expect(thrown.code).toBe('malformed-event-payload')
    expect(thrown.message).toContain('invalid payload JSON')
    db.close()
  })
})

describe('replayProjectEvents', () => {
  it('replays the golden import to the materialized projection', async () => {
    const db = await goldenLedger()
    const replayed = replayProjectEvents(db, PROJECT)

    expect(replayed.planVersions.size).toBe(1)
    expect(replayed.workItems.size).toBe(15)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.planVersions.get(brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1'))).toEqual({
      planId: 'mini-dsh-v1.6a-ledger',
      versionNo: 1,
      sourceDocumentHash: GOLDEN_SOURCE_HASH,
    })
    expect(replayed.workItems.get(brandString<WorkItemId>('wi:mini-dsh:IMPORT-001'))).toEqual({
      stableKey: 'IMPORT-001',
      title: 'Compile and transactionally import an immutable plan version',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      status: 'BLOCKED',
      criteria: new Map([
        [brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:IMPORT-001:AC-IMPORT-001'), {
          ordinal: 0,
          criterionKind: 'TEST',
          required: true,
          status: 'PENDING',
        }],
      ]),
    })
    db.close()
  })

  it('skips unknown ignorable rows and vocabulary types without a projection effect', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/note', ignorable: 1, payloadJson: '{"note":"observed"}' })
    appendProjectEvent(db, PROJECT, 'plan/version-activated', {
      activatedBy: 'owner',
    }, { entityType: 'plan_version', entityId: 'plv:mini-dsh-v1.6a-ledger:v1', nowMs: 2 })

    expect(readProjectEvents(db, PROJECT)).toHaveLength(18)
    expect(replayProjectEvents(db, PROJECT)).toEqual(materializedProjection(db))
    db.close()
  })

  it('applies work/status-changed to the replayed projection', async () => {
    const db = await goldenLedger()
    db.prepare("UPDATE work_items SET status = 'IN_PROGRESS' WHERE id = 'wi:mini-dsh:IMPORT-001'").run()
    appendProjectEvent(db, PROJECT, 'work/status-changed', {
      workItemId: 'wi:mini-dsh:IMPORT-001',
      fromStatus: 'BLOCKED',
      toStatus: 'IN_PROGRESS',
    }, { entityType: 'work_item', entityId: 'wi:mini-dsh:IMPORT-001', nowMs: 2 })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed.workItems.get(brandString<WorkItemId>('wi:mini-dsh:IMPORT-001'))?.status).toBe('IN_PROGRESS')
    expect(replayed).toEqual(materializedProjection(db))
    db.close()
  })

  it('fails replay on a status change naming an unknown work item', async () => {
    const db = await goldenLedger()
    appendProjectEvent(db, PROJECT, 'work/status-changed', {
      workItemId: 'wi:mini-dsh:GHOST',
      fromStatus: 'BLOCKED',
      toStatus: 'READY',
    }, { entityType: 'work_item', entityId: 'wi:mini-dsh:GHOST', nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "workItemId" names no replayed work item (wi:mini-dsh:GHOST)')
    db.close()
  })

  it('fails replay on an unknown required event', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/rewrite', ignorable: 0 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).code).toBe('unknown-required-event')
    db.close()
  })

  it('fails replay on applier payloads with missing, mistyped, or non-object fields', async () => {
    const db = await goldenLedger()
    const baseImported: Record<string, unknown> = {
      planId: 'mini-dsh-v1.6a-ledger',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      versionNo: 1,
      sourceDocumentHash: 'hash',
    }
    const baseCreated: Record<string, unknown> = {
      workItemId: 'wi:mini-dsh:EXTRA',
      stableKey: 'EXTRA',
      title: 'Extra item',
      planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
      status: 'READY',
      criteria: [{
        criterionId: 'ac:wi:mini-dsh:EXTRA:AC-EXTRA',
        ordinal: 0,
        criterionKind: 'TEST',
        required: true,
        status: 'PENDING',
      }],
    }
    const baseStatusChanged: Record<string, unknown> = {
      workItemId: 'wi:mini-dsh:IMPORT-001',
      fromStatus: 'BLOCKED',
      toStatus: 'READY',
    }
    const created = appendProjectEvent(db, PROJECT, 'work/created', baseCreated, {
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:EXTRA',
      nowMs: 2,
    })
    const statusChanged = appendProjectEvent(db, PROJECT, 'work/status-changed', baseStatusChanged, {
      entityType: 'work_item',
      entityId: 'wi:mini-dsh:IMPORT-001',
      nowMs: 3,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }

    for (const field of Object.keys(baseImported)) {
      const payload = Object.fromEntries(Object.entries(baseImported).filter(([key]) => key !== field))
      setPayload(1, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(1, { ...baseImported, versionNo: '1' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "versionNo" must be a number')
    setPayload(1, baseImported)

    for (const field of Object.keys(baseCreated)) {
      const payload = Object.fromEntries(Object.entries(baseCreated).filter(([key]) => key !== field))
      setPayload(created.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    for (const variant of [null, 'spice', [1, 2]]) {
      setPayload(created.sequenceNo, variant)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain('non-object payload')
    }
    setPayload(created.sequenceNo, baseCreated)

    const criterion = (baseCreated.criteria as Record<string, unknown>[])[0] as Record<string, unknown>
    const withCriteria = (criteria: unknown): Record<string, unknown> => ({ ...baseCreated, criteria })
    setPayload(created.sequenceNo, withCriteria('spice'))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria" must be an array')
    setPayload(created.sequenceNo, withCriteria([42]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0]" must be an object')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, ordinal: 'zero' }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].ordinal" must be a number')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, required: 1 }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].required" must be a boolean')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, criterionKind: 'TELEPORT' }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].criterionKind" is not an acceptance kind: "TELEPORT"')
    setPayload(created.sequenceNo, withCriteria([{ ...criterion, status: 'SPICED' }]))
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "criteria[0].status" is not an acceptance criterion status: "SPICED"')
    setPayload(created.sequenceNo, baseCreated)

    for (const field of Object.keys(baseStatusChanged)) {
      const payload = Object.fromEntries(Object.entries(baseStatusChanged).filter(([key]) => key !== field))
      setPayload(statusChanged.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(statusChanged.sequenceNo, { ...baseStatusChanged, fromStatus: 1 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "fromStatus" must be a string')
    setPayload(statusChanged.sequenceNo, { ...baseStatusChanged, toStatus: 'SPICED' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "toStatus" is not a work item status: "SPICED"')
    db.close()
  })

  it('replays a project without events to an empty projection', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    expect(replayProjectEvents(db, brandString<ProjectId>('fresh'))).toEqual({
      planVersions: new Map(),
      workItems: new Map(),
      leases: new Map(),
      workPackets: new Map(),
      decisionRequests: new Map(),
      decisions: new Map(),
    })
    db.close()
  })

  it('replays the decision domain to the materialized projection', async () => {
    const db = await goldenLedger()
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'v1.6b-entry',
      title: 'Enter v1.6b',
      question: 'Does the ledger carry real value?',
      context: '§33 evidence briefing',
      blockingLevel: 'BLOCKING',
      planVersionId: brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1'),
      raisedBy: 'owner',
      options: [
        { optionKey: 'enter', label: 'Enter v1.6b', recommended: true },
        { optionKey: 'wait', label: 'Keep accumulating' },
      ],
    }, { nowMs: 20, actorRef: 'tester' })
    recordDecision(db, request.requestId, {
      decidedBy: 'owner',
      selectedOptionKey: 'enter',
      decisionText: 'Enter v1.6b now.',
      rationale: '26 items, five versions, zero drift',
    }, { nowMs: 21, actorRef: 'tester' })

    const replayed = replayProjectEvents(db, PROJECT)
    expect(replayed).toEqual(materializedProjection(db))
    expect(replayed.decisionRequests.get(request.requestId)).toEqual({
      decisionKey: 'v1.6b-entry',
      optionKeys: new Set(['enter', 'wait']),
      status: 'RESOLVED',
    })
    expect([...replayed.decisions.values()]).toEqual([
      { requestId: request.requestId, decidedBy: 'owner' },
    ])
    db.close()
  })

  it('fails replay on a decision recorded for an unknown request', async () => {
    const db = await goldenLedger()
    const ghost = brandString<DecisionRequestId>('dr:mini-dsh:ghost')
    appendProjectEvent(db, PROJECT, 'decision/recorded', {
      requestId: ghost,
      decisionId: brandString<DecisionId>(`dc:${ghost}:1`),
      decidedBy: 'owner',
      decisionText: 'nothing to resolve',
      resolvedAtMs: 1,
    }, { entityType: 'decision_request', entityId: ghost, nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`payload field "requestId" names no replayed decision request (${ghost})`)
    db.close()
  })

  it('fails replay on a decision selecting an option the request does not carry', async () => {
    const db = await goldenLedger()
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'no-options',
      title: 'Open-ended',
      question: 'Free text?',
      blockingLevel: 'ADVISORY',
      options: [{ optionKey: 'a', label: 'A' }],
    }, { nowMs: 20, actorRef: 'tester' })
    appendProjectEvent(db, PROJECT, 'decision/recorded', {
      requestId: request.requestId,
      decisionId: brandString<DecisionId>(`dc:${request.requestId}:1`),
      decidedBy: 'owner',
      selectedOptionKey: 'alien',
      decisionText: 'picked nothing',
      resolvedAtMs: 1,
    }, { entityType: 'decision_request', entityId: request.requestId, nowMs: 2 })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "selectedOptionKey" names no option of decision request')
    db.close()
  })

  it('fails replay on a decision request resolved twice', async () => {
    const db = await goldenLedger()
    const request = openDecisionRequest(db, PROJECT, {
      decisionKey: 'once-only',
      title: 'Once',
      question: 'Resolved once?',
      blockingLevel: 'BLOCKING',
    }, { nowMs: 20, actorRef: 'tester' })
    for (const sequence of [1, 2]) {
      appendProjectEvent(db, PROJECT, 'decision/recorded', {
        requestId: request.requestId,
        decisionId: brandString<DecisionId>(`dc:${request.requestId}:${sequence}`),
        decidedBy: 'owner',
        decisionText: 'again',
        resolvedAtMs: sequence,
      }, { entityType: 'decision_request', entityId: request.requestId, nowMs: 2 + sequence })
    }
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain(`resolves decision request "${request.requestId}" twice in this timeline`)
    db.close()
  })

  it('fails replay on decision payloads with missing, mistyped, or invalid fields', async () => {
    const db = await goldenLedger()
    const baseRequested: Record<string, unknown> = {
      requestId: 'dr:mini-dsh:payload',
      decisionKey: 'payload',
      title: 'Payload probe',
      question: 'Which fields decode?',
      blockingLevel: 'BLOCKING',
      options: [{ optionKey: 'a', label: 'A', recommended: false, ordinal: 0 }],
    }
    const baseRecorded: Record<string, unknown> = {
      requestId: 'dr:mini-dsh:payload',
      decisionId: 'dc:dr:mini-dsh:payload:1',
      decidedBy: 'owner',
      decisionText: 'recorded',
      resolvedAtMs: 5,
    }
    const requested = appendProjectEvent(db, PROJECT, 'decision/requested', baseRequested, {
      entityType: 'decision_request',
      entityId: 'dr:mini-dsh:payload',
      nowMs: 2,
    })
    const recorded = appendProjectEvent(db, PROJECT, 'decision/recorded', baseRecorded, {
      entityType: 'decision_request',
      entityId: 'dr:mini-dsh:payload',
      nowMs: 3,
    })
    const setPayload = (sequenceNo: number, payload: unknown): void => {
      db.prepare('UPDATE project_events SET payload_json = ? WHERE project_id = ? AND sequence_no = ?')
        .run(JSON.stringify(payload), PROJECT, sequenceNo)
    }

    for (const field of ['requestId', 'decisionKey', 'title', 'question', 'blockingLevel', 'options']) {
      const payload = Object.fromEntries(Object.entries(baseRequested).filter(([key]) => key !== field))
      setPayload(requested.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(requested.sequenceNo, { ...baseRequested, blockingLevel: 'SUGGESTIVE' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "blockingLevel" is not a decision blocking level: "SUGGESTIVE"')
    setPayload(requested.sequenceNo, { ...baseRequested, options: 'spice' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "options" must be an array')
    setPayload(requested.sequenceNo, { ...baseRequested, options: [42] })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "options[0]" must be an object')
    const firstOption = (baseRequested.options as Record<string, unknown>[])[0] as Record<string, unknown>
    if (firstOption === undefined) throw new Error('test setup: the base payload carries no option')
    setPayload(requested.sequenceNo, { ...baseRequested, options: [{ ...firstOption, recommended: 1 }] })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "options[0].recommended" must be a boolean')
    setPayload(requested.sequenceNo, { ...baseRequested, planVersionId: 'plv:mini-dsh:ghost' })
    expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message)
      .toContain('payload field "planVersionId" names no replayed plan version (plv:mini-dsh:ghost)')
    setPayload(requested.sequenceNo, baseRequested)

    for (const field of ['requestId', 'decisionId', 'decidedBy', 'decisionText', 'resolvedAtMs']) {
      const payload = Object.fromEntries(Object.entries(baseRecorded).filter(([key]) => key !== field))
      setPayload(recorded.sequenceNo, payload)
      expect(thrownEventError(() => replayProjectEvents(db, PROJECT)).message).toContain(`payload field "${field}"`)
    }
    setPayload(recorded.sequenceNo, baseRecorded)
    db.close()
  })
})
