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
  parsePlanDocument,
  readProjectEvents,
  replayProjectEvents,
  validatePlanSchema,
  type CompiledPlan,
  type PlanId,
  type PlanVersionId,
  type PlanWorkItemStatus,
  type ProjectEventEnvelope,
  type ProjectId,
  type ReplayedPlanVersion,
  type ReplayedProjectProjection,
  type ReplayedWorkItem,
  type SourceDocumentHash,
  type WorkItemId,
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
  const workItems = new Map<WorkItemId, ReplayedWorkItem>()
  const itemRows = db.prepare('SELECT id, stable_key, title, plan_version_id, status FROM work_items')
    .all() as { id: string; stable_key: string; title: string; plan_version_id: string | null; status: string }[]
  for (const row of itemRows) {
    workItems.set(brandString<WorkItemId>(row.id), {
      stableKey: row.stable_key,
      title: row.title,
      planVersionId: brandString<PlanVersionId>(row.plan_version_id!),
      status: row.status as PlanWorkItemStatus,
    })
  }
  return { planVersions, workItems }
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

  it('fails closed on a foreign event format version', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'work/status-changed', ignorable: 0, eventFormatVersion: 2 })
    const thrown = thrownEventError(() => readProjectEvents(db, PROJECT))
    expect(thrown.code).toBe('event-format-unsupported')
    expect(thrown.message).toBe('project event 17 of "mini-dsh" carries event format 2; this build reads format 1')
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
    })
    db.close()
  })

  it('skips unknown ignorable rows and vocabulary types without a projection effect', async () => {
    const db = await goldenLedger()
    insertRawEvent(db, { eventType: 'alien/note', ignorable: 1, payloadJson: '{"note":"observed"}' })
    appendProjectEvent(db, PROJECT, 'work/claimed', {
      workItemId: 'wi:mini-dsh:IMPORT-001',
      leaseId: 'lease:1',
      workerIdentity: 'agent/a',
    }, { entityType: 'work_item', entityId: 'wi:mini-dsh:IMPORT-001', nowMs: 2 })

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
    })
    db.close()
  })
})
