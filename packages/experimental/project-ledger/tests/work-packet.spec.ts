import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  WORK_PACKET_BUILDER_VERSION,
  WORK_PACKET_FORMAT_VERSION,
  WorkPacketError,
  buildWorkPacket,
  compilePlan,
  decodeWorkPacketPreparedPayload,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  readWorkPacketEvent,
  rebuildWorkPacket,
  replayProjectEvents,
  serializeWorkPacket,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type PlanWorkItemStatus,
  type ProjectId,
  type WorkItemId,
  type WorkPacketId,
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

/**
 * A fresh golden ledger with one prepared SCHEMA-001 packet (event 17); each
 * replay-rejection case rewrites payload 17 on its own ledger so
 * contradictions never mask each other.
 */
async function packetLedger(): Promise<{ db: DatabaseSync; base: Record<string, unknown> }> {
  const db = await goldenLedger()
  buildWorkPacket(db, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), { nowMs: 5 })
  return { db, base: eventPayload(db, 17) }
}

/** The ledger row id of a golden work item. */
function itemId(stableKey: string): WorkItemId {
  return brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`)
}

/** The ledger row id of a golden acceptance criterion. */
function criterionId(stableKey: string, criterion: string): AcceptanceCriterionId {
  return brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`)
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

/** Overwrite a work item status directly — the seam of writers this package does not own. */
function setItemStatus(db: DatabaseSync, stableKey: string, status: PlanWorkItemStatus): void {
  db.prepare('UPDATE work_items SET status = ? WHERE stable_key = ?').run(status, stableKey)
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

describe('buildWorkPacket', () => {
  it('records the recipe event and rebuilds the identical packet from durable state alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-work-packet-'))
    const path = join(dir, 'ledger.sqlite')
    try {
      const db = await openProjectLedgerDatabase(path)
      importPlanVersion(db, compileGolden())
      const packet = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      expect(eventCount(db)).toBe(17)
      expect(eventPayload(db, 17)).toEqual({
        packetId: 'wp:wi:mini-dsh:SCHEMA-001:17',
        packetFormatVersion: WORK_PACKET_FORMAT_VERSION,
        builderVersion: WORK_PACKET_BUILDER_VERSION,
        workItemId: 'wi:mini-dsh:SCHEMA-001',
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        repoSnapshotId: 'rs:plv:mini-dsh-v1.6a-ledger:v1',
        references: packet.references,
        packetHash: packet.packetHash,
        serializedBytes: packet.serializedBytes,
      })
      const envelope = readWorkPacketEvent(db, packet.packetId)
      expect(envelope).toMatchObject({
        sequenceNo: 17,
        eventType: 'project/work-packet-prepared',
        entityType: 'work_packet',
        entityId: 'wp:wi:mini-dsh:SCHEMA-001:17',
      })
      db.close()

      // The reconstruction uses only the reopened database and the packet
      // id; the plan document is never an input to the rebuild.
      const reopened = await openProjectLedgerDatabase(path)
      try {
        const rebuild = rebuildWorkPacket(reopened, packet.packetId)
        expect(rebuild.matchesRecordedHash).toBe(true)
        expect(rebuild.driftedReferenceIds).toEqual([])
        expect(rebuild.packet).toEqual(packet)
        expect(rebuild.recorded.packetHash).toBe(packet.packetHash)
        const found = readWorkPacketEvent(reopened, packet.packetId)
        if (found === undefined) throw new Error('expected the recorded packet event on reopen')
        expect(decodeWorkPacketPreparedPayload(found).packetId).toBe(packet.packetId)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads only the §17 inputs and pins each with the recorded hash formula', async () => {
    const db = await goldenLedger()
    try {
      const packet = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      expect(packet.references.map(reference => [reference.kind, reference.refId])).toEqual([
        ['plan-version', 'plv:mini-dsh-v1.6a-ledger:v1'],
        ['repo-snapshot', 'rs:plv:mini-dsh-v1.6a-ledger:v1'],
        ['work-item', 'wi:mini-dsh:SCHEMA-001'],
        ['phase', 'ph:plv:mini-dsh-v1.6a-ledger:v1:W01'],
        ['blocking-relation', 'rel:wi:mini-dsh:OWNER-REVIEW-001:wi:mini-dsh:SCHEMA-001:BLOCKS'],
        ['blocking-relation', 'rel:wi:mini-dsh:PRE-001:wi:mini-dsh:SCHEMA-001:BLOCKS'],
        ['acceptance-criterion', 'ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001'],
        ['verification-spec', 'vs:ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001'],
      ])
      expect(packet.objective).toEqual({
        stableKey: 'SCHEMA-001',
        workType: 'IMPLEMENTATION',
        executorKind: 'AGENT',
        title: 'Implement strict Plan v1.1 schema and parser',
        description: null,
      })
      expect(packet.phase).toEqual({
        phaseId: 'ph:plv:mini-dsh-v1.6a-ledger:v1:W01',
        stableKey: 'W01',
        title: 'Strict plan schema and parser',
        description: null,
      })
      expect(packet.relationReceipts).toEqual([
        {
          relationId: 'rel:wi:mini-dsh:OWNER-REVIEW-001:wi:mini-dsh:SCHEMA-001:BLOCKS',
          fromWorkItemId: 'wi:mini-dsh:OWNER-REVIEW-001',
          relationKind: 'BLOCKS',
          fromStatus: 'READY',
        },
        {
          relationId: 'rel:wi:mini-dsh:PRE-001:wi:mini-dsh:SCHEMA-001:BLOCKS',
          fromWorkItemId: 'wi:mini-dsh:PRE-001',
          relationKind: 'BLOCKS',
          fromStatus: 'READY',
        },
      ])
      expect(packet.acceptance).toEqual([{
        criterionId: 'ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001',
        ordinal: 0,
        criterionKind: 'TEST',
        description: 'Unknown fields, duplicate keys, unknown enums, and malformed verifier variants fail closed.',
        required: true,
        status: 'PENDING',
      }])
      expect(packet.verifierSpecs).toEqual([{
        specId: 'vs:ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001',
        criterionId: 'ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001',
        verifierKind: 'TEST',
        commandText: 'pnpm exec vitest run packages/experimental/project-ledger/tests/plan-schema.spec.ts',
        expectedExitCode: 0,
        queryText: null,
        expectedJson: null,
        ownerInstruction: null,
        sandboxRequired: true,
        approvalRequired: false,
      }])
      expect(packet.repoSnapshot).toEqual({ repoHead: null, worktreeHash: null })

      // The hash formulas are pinned independently of the implementation:
      // each reference hashes its document section, and the packet hash
      // covers identity plus the ordered references.
      expect(packet.references[2]?.contentHash).toBe(createHash('sha256').update(JSON.stringify({
        stableKey: 'SCHEMA-001',
        workType: 'IMPLEMENTATION',
        executorKind: 'AGENT',
        title: 'Implement strict Plan v1.1 schema and parser',
        description: null,
      })).digest('hex'))
      expect(packet.packetHash).toBe(createHash('sha256').update(JSON.stringify({
        packetFormatVersion: WORK_PACKET_FORMAT_VERSION,
        builderVersion: WORK_PACKET_BUILDER_VERSION,
        workItemId: 'wi:mini-dsh:SCHEMA-001',
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        repoSnapshotId: 'rs:plv:mini-dsh-v1.6a-ledger:v1',
        references: packet.references,
      })).digest('hex'))

      const serialized = serializeWorkPacket(packet)
      expect(serialized).toContain('Implement strict Plan v1.1 schema and parser')
      expect(serialized).toContain('pnpm exec vitest run packages/experimental/project-ledger/tests/plan-schema.spec.ts')
      expect(serialized).not.toContain('Real 4K vertical slice')
      expect(serialized).not.toContain('Expose distinct Owner and Agent project todo queries')
    } finally {
      db.close()
    }
  })

  it('is deterministic for identical rows while each preparation records its own event', async () => {
    const db = await goldenLedger()
    try {
      const first = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      const second = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 9 })
      expect(second.packetHash).toBe(first.packetHash)
      expect(serializeWorkPacket(second)).toBe(serializeWorkPacket(first))
      expect(second.serializedBytes).toBe(first.serializedBytes)
      expect(second.packetId).toBe('wp:wi:mini-dsh:SCHEMA-001:18')
      expect(second.sequenceNo).toBe(18)
      expect(eventCount(db)).toBe(18)
    } finally {
      db.close()
    }
  })

  it('composes a packet without phase, receipts, criteria, or specs for an ad hoc item', async () => {
    const db = await goldenLedger()
    try {
      db.prepare(
        'INSERT INTO work_items (id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, '
        + 'work_type, executor_kind, title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:mini-dsh:ADHOC-1', 'mini-dsh', 'plv:mini-dsh-v1.6a-ledger:v1', NULL, NULL, 'ADHOC-1', "
        + "'IMPLEMENTATION', 'AGENT', 'Ad hoc objective', NULL, 0, 'READY', 0, 5, 5)",
      ).run()
      const packet = buildWorkPacket(db, brandString<WorkItemId>('wi:mini-dsh:ADHOC-1'), { nowMs: 5 })
      expect(packet.references.map(reference => [reference.kind, reference.refId])).toEqual([
        ['plan-version', 'plv:mini-dsh-v1.6a-ledger:v1'],
        ['repo-snapshot', 'rs:plv:mini-dsh-v1.6a-ledger:v1'],
        ['work-item', 'wi:mini-dsh:ADHOC-1'],
      ])
      expect(packet.phase).toBe(null)
      expect(packet.relationReceipts).toEqual([])
      expect(packet.acceptance).toEqual([])
      expect(packet.verifierSpecs).toEqual([])
      expect(serializeWorkPacket(packet)).toContain('"phase":null')
      expect(rebuildWorkPacket(db, packet.packetId).matchesRecordedHash).toBe(true)
    } finally {
      db.close()
    }
  })

  it('refuses unrecorded, unplanned, and misconfigured builds', async () => {
    const db = await goldenLedger()
    try {
      const unknown = thrownError(WorkPacketError, () =>
        buildWorkPacket(db, brandString<WorkItemId>('wi:mini-dsh:NOPE')))
      expect(unknown.code).toBe('unknown-work-item')
      expect(unknown.message).toContain('work item "wi:mini-dsh:NOPE" is not recorded in this ledger')

      db.prepare('UPDATE work_items SET plan_version_id = NULL WHERE stable_key = ?').run('SCHEMA-001')
      const unplanned = thrownError(WorkPacketError, () => buildWorkPacket(db, itemId('SCHEMA-001')))
      expect(unplanned.code).toBe('work-item-unplanned')
      expect(unplanned.message).toContain('records no plan version')

      const misconfigured = thrownError(WorkPacketError, () =>
        buildWorkPacket(db, itemId('DB-001'), { maxSerializedBytes: 0 }))
      expect(misconfigured.code).toBe('invalid-packet-config')
      expect(misconfigured.message).toContain('maxSerializedBytes must be a positive integer, got 0')
      expect(eventCount(db)).toBe(16)
    } finally {
      db.close()
    }
  })

  it('refuses to record a packet above the serialized byte ceiling', async () => {
    const db = await goldenLedger()
    try {
      const error = thrownError(WorkPacketError, () =>
        buildWorkPacket(db, itemId('SCHEMA-001'), { maxSerializedBytes: 16 }))
      expect(error.code).toBe('packet-too-large')
      expect(error.message).toMatch(/is \d+ bytes, above the 16-byte bound/)
      expect(eventCount(db)).toBe(16)
    } finally {
      db.close()
    }
  })
})

describe('rebuildWorkPacket', () => {
  it('names the acceptance reference whose row moved after preparation', async () => {
    const db = await goldenLedger()
    try {
      const packet = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      evaluateAcceptanceCriterion(
        db,
        criterionId('SCHEMA-001', 'AC-SCHEMA-001'),
        'PASS',
        { nowMs: 7 },
      )
      const drift = rebuildWorkPacket(db, packet.packetId)
      expect(drift.matchesRecordedHash).toBe(false)
      expect(drift.driftedReferenceIds).toEqual(['ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001'])
      expect(drift.packet.acceptance[0]?.status).toBe('PASSING')
    } finally {
      db.close()
    }
  })

  it('names the blocking-relation reference whose source item moved after preparation', async () => {
    const db = await goldenLedger()
    try {
      const packet = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      setItemStatus(db, 'PRE-001', 'DONE')
      const drift = rebuildWorkPacket(db, packet.packetId)
      expect(drift.matchesRecordedHash).toBe(false)
      expect(drift.driftedReferenceIds).toEqual(['rel:wi:mini-dsh:PRE-001:wi:mini-dsh:SCHEMA-001:BLOCKS'])
    } finally {
      db.close()
    }
  })

  it('fails closed on a packet id no event records', async () => {
    const db = await goldenLedger()
    try {
      const error = thrownError(WorkPacketError, () =>
        rebuildWorkPacket(db, brandString<WorkPacketId>('wp:wi:mini-dsh:SCHEMA-001:999')))
      expect(error.code).toBe('unknown-work-packet')
      expect(error.message).toContain('work packet "wp:wi:mini-dsh:SCHEMA-001:999" is not recorded in this ledger')
    } finally {
      db.close()
    }
  })
})

describe('replaying project/work-packet-prepared', () => {
  it('carries the recorded recipe in the replayed projection', async () => {
    const db = await goldenLedger()
    try {
      const packet = buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      const projection = replayProjectEvents(db, PROJECT)
      expect(projection.workPackets.size).toBe(1)
      expect(projection.workPackets.get(packet.packetId)).toEqual({
        packetId: 'wp:wi:mini-dsh:SCHEMA-001:17',
        packetFormatVersion: WORK_PACKET_FORMAT_VERSION,
        builderVersion: WORK_PACKET_BUILDER_VERSION,
        workItemId: 'wi:mini-dsh:SCHEMA-001',
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        repoSnapshotId: 'rs:plv:mini-dsh-v1.6a-ledger:v1',
        references: packet.references,
        packetHash: packet.packetHash,
        serializedBytes: packet.serializedBytes,
      })
    } finally {
      db.close()
    }
  })

  it('rejects a recipe naming no replayed work item', async () => {
    const { db, base } = await packetLedger()
    try {
      rewritePayload(db, 17, { ...base, workItemId: 'wi:mini-dsh:GONE' })
      expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message)
        .toContain('names no replayed work item (wi:mini-dsh:GONE)')
    } finally {
      db.close()
    }
  })

  it('rejects a non-array, non-object, or unknown-kind references list', async () => {
    const first = await packetLedger()
    try {
      rewritePayload(first.db, 17, { ...first.base, references: 'nope' })
      expect(thrownError(Error, () => replayProjectEvents(first.db, PROJECT)).message)
        .toContain('payload field "references" must be an array')
    } finally {
      first.db.close()
    }

    const second = await packetLedger()
    try {
      rewritePayload(second.db, 17, { ...second.base, references: [3] })
      expect(thrownError(Error, () => replayProjectEvents(second.db, PROJECT)).message)
        .toContain('payload field "references[0]" must be an object')
    } finally {
      second.db.close()
    }

    const third = await packetLedger()
    try {
      const [recorded] = first.base.references as Record<string, unknown>[]
      if (recorded === undefined) throw new Error('expected a recorded reference')
      rewritePayload(third.db, 17, {
        ...third.base,
        references: [{ ...recorded, kind: 'side-quest' }],
      })
      expect(thrownError(Error, () => replayProjectEvents(third.db, PROJECT)).message)
        .toContain('payload field "references[0].kind" is not a work packet reference kind: "side-quest"')
    } finally {
      third.db.close()
    }
  })

  it('rejects a recipe without the serialized size', async () => {
    const { db, base } = await packetLedger()
    try {
      const withoutSize = { ...base }
      delete withoutSize.serializedBytes
      rewritePayload(db, 17, withoutSize)
      expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message)
        .toContain('payload field "serializedBytes" must be a number')
    } finally {
      db.close()
    }
  })

  it('rejects a recipe re-using an already replayed packet id', async () => {
    const db = await goldenLedger()
    try {
      buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 5 })
      buildWorkPacket(db, itemId('SCHEMA-001'), { nowMs: 6 })
      rewritePayload(db, 18, { ...eventPayload(db, 18), packetId: 'wp:wi:mini-dsh:SCHEMA-001:17' })
      expect(thrownError(Error, () => replayProjectEvents(db, PROJECT)).message)
        .toContain('names an already replayed work packet (wp:wi:mini-dsh:SCHEMA-001:17)')
    } finally {
      db.close()
    }
  })
})
