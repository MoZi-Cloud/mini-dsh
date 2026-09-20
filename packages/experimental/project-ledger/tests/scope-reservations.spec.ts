/** Scope-reservation seam tests: reserve, release, reap, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_SCOPE_RESERVATION_ACTOR_REF,
  ScopeReservationError,
  compilePlan,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  readProjectReplay,
  readProjectScopeReservations,
  registerActor,
  releaseScopeReservation,
  reapExpiredScopeReservations,
  reserveScope,
  validatePlanSchema,
  type ActorId,
  type PlanVersionId,
  type ProjectId,
  type ScopeReservationId,
  type ScopeReservationKind,
  type WorkItemId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)
const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_VERSION = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1')
const ITEM = brandString<WorkItemId>('wi:mini-dsh:DB-001')

/** Parse, validate, and compile the golden plan document. */
function compileGolden(): ReturnType<typeof compilePlan> {
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
 * Call a thunk and return the ScopeReservationError it threw; any other
 * outcome fails the test through the instance assertion or the unreachable
 * marker.
 */
function thrownReservationError(call: () => unknown): ScopeReservationError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ScopeReservationError)
    return error as ScopeReservationError
  }
  expect.unreachable('expected the call to throw ScopeReservationError')
}

describe('reserveScope', () => {
  it('records the reservation and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const reservation = reserveScope(db, {
        workItemId: ITEM,
        actorId: lane.actorId,
        scopeKind: 'PATH',
        scopeValue: 'packages/ledger/src',
        expiresAtMs: 900,
      }, { nowMs: 12, actorRef: 'tester' })
      expect(reservation).toEqual({
        reservationId: brandString<ScopeReservationId>('sr:mini-dsh:18'),
        projectId: PROJECT,
        workItemId: ITEM,
        stableKey: 'DB-001',
        actorId: lane.actorId,
        actorKey: 'lane',
        scopeKind: 'PATH',
        scopeValue: 'packages/ledger/src',
        status: 'ACTIVE',
        acquiredAtMs: 12,
        expiresAtMs: 900,
        releasedAtMs: undefined,
      })
      const row = db.prepare(
        'SELECT id, project_id, released_at_ms, status FROM scope_reservations',
      ).get() as { id: string; project_id: string; released_at_ms: number | null; status: string }
      expect(row).toEqual({
        id: 'sr:mini-dsh:18',
        project_id: 'mini-dsh',
        released_at_ms: null,
        status: 'ACTIVE',
      })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 18').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('scope/reserved')
      expect(event.entity_id).toBe('sr:mini-dsh:18')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        reservationId: 'sr:mini-dsh:18',
        workItemId: 'wi:mini-dsh:DB-001',
        actorId: lane.actorId,
        scopeKind: 'PATH',
        scopeValue: 'packages/ledger/src',
        expiresAtMs: 900,
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor when the caller names none', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10 })
      // No options: the defaults for the stamp and the event actor both apply.
      const reservation = reserveScope(db, {
        workItemId: ITEM,
        actorId: lane.actorId,
        scopeKind: 'PATH',
        scopeValue: 'src/one.ts',
        expiresAtMs: 9_000_000_000_000,
      })
      expect(reservation.acquiredAtMs).toBeGreaterThan(0)
      expect(reservation.reservationId).toEqual(brandString<ScopeReservationId>('sr:mini-dsh:18'))
      const event = db.prepare('SELECT actor_ref FROM project_events WHERE sequence_no = 18').get() as {
        actor_ref: string
      }
      expect(event.actor_ref).toBe(DEFAULT_SCOPE_RESERVATION_ACTOR_REF)
    } finally {
      db.close()
    }
  })

  it('rejects bad scopes, unknown referents, and a held scope without writing', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const at = { nowMs: 14, actorRef: 'tester' }
      expect(thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId,
        scopeKind: 'HOST' as ScopeReservationKind, scopeValue: 'db', expiresAtMs: 900,
      }, at)).code).toBe('invalid-argument')
      expect(thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: '', expiresAtMs: 900,
      }, at)).code).toBe('invalid-argument')
      expect(thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/x.ts', expiresAtMs: 9,
      }, at)).message).toContain('expiresAtMs must be an integer after now')
      expect(thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/x.ts', expiresAtMs: 900.5,
      }, at)).code).toBe('invalid-argument')
      expect(thrownReservationError(() => reserveScope(db, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:ghost'),
        actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/x.ts', expiresAtMs: 900,
      }, at)).code).toBe('unknown-work-item')
      expect(thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: brandString<ActorId>('actor:mini-dsh:ghost'),
        scopeKind: 'PATH', scopeValue: 'src/x.ts', expiresAtMs: 900,
      }, at)).code).toBe('unknown-actor')

      const foreignActor = registerActor(db, brandString<ProjectId>('other'), {
        actorKey: 'foreign', actorKind: 'AGENT', displayName: 'Foreign',
      }, { nowMs: 13, actorRef: 'tester' })
      const foreignError = thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: foreignActor.actorId,
        scopeKind: 'PATH', scopeValue: 'src/x.ts', expiresAtMs: 900,
      }, at))
      expect(foreignError.code).toBe('unknown-actor')
      expect(foreignError.message).toContain('not registered in project "mini-dsh"')

      reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/held.ts', expiresAtMs: 900,
      }, { nowMs: 14, actorRef: 'tester' })
      const duplicate = thrownReservationError(() => reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/held.ts', expiresAtMs: 900,
      }, { nowMs: 15, actorRef: 'tester' }))
      expect(duplicate.code).toBe('duplicate-reservation')
      expect(duplicate.message).toContain('is already reserved in project "mini-dsh"')

      expect((db.prepare('SELECT COUNT(*) AS n FROM scope_reservations').get() as { n: number }).n).toBe(1)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(19)
    } finally {
      db.close()
    }
  })

  it('expires a stale reservation holding the scope and lets the new claim take it', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const stale = reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/stale.ts', expiresAtMs: 20,
      }, { nowMs: 12, actorRef: 'tester' })
      const replacement = reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/stale.ts', expiresAtMs: 900,
      }, { nowMs: 30, actorRef: 'tester' })
      expect(replacement.reservationId).toEqual(brandString<ScopeReservationId>('sr:mini-dsh:20'))
      const staleRow = db.prepare('SELECT status FROM scope_reservations WHERE id = ?').get(stale.reservationId) as {
        status: string
      }
      expect(staleRow.status).toBe('EXPIRED')
      const expiryEvent = db.prepare(
        "SELECT event_type FROM project_events WHERE sequence_no = 19 AND event_type = 'scope/expired'",
      ).get()
      expect(expiryEvent).toBeDefined()
    } finally {
      db.close()
    }
  })
})

describe('releaseScopeReservation', () => {
  it('releases the active reservation and refuses a second release', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const reservation = reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/one.ts', expiresAtMs: 900,
      }, { nowMs: 12, actorRef: 'tester' })
      const released = releaseScopeReservation(db, reservation.reservationId, { nowMs: 20, actorRef: 'tester' })
      expect(released).toEqual({ reservationId: reservation.reservationId, releasedAtMs: 20 })
      const row = db.prepare('SELECT status, released_at_ms FROM scope_reservations WHERE id = ?')
        .get(reservation.reservationId) as { status: string; released_at_ms: number }
      expect(row.status).toBe('RELEASED')
      expect(row.released_at_ms).toBe(20)

      expect(thrownReservationError(() => releaseScopeReservation(db, reservation.reservationId, { nowMs: 21 })).code)
        .toBe('reservation-not-active')
      expect(thrownReservationError(() => releaseScopeReservation(
        db,
        brandString<ScopeReservationId>('sr:mini-dsh:ghost'),
      )).code).toBe('unknown-reservation')

      // The released scope accepts a new reservation, and the fold replays the
      // whole lifecycle.
      const again = reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/one.ts', expiresAtMs: 900,
      }, { nowMs: 22, actorRef: 'tester' })
      expect(again.status).toBe('ACTIVE')
    } finally {
      db.close()
    }
  })
})

describe('reapExpiredScopeReservations', () => {
  it('moves exactly the expired reservations and records one event each', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 10, actorRef: 'tester' })
      const live = reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/live.ts', expiresAtMs: 9_000,
      }, { nowMs: 12, actorRef: 'tester' })
      const stale = reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/stale.ts', expiresAtMs: 40,
      }, { nowMs: 13, actorRef: 'tester' })
      const reaped = reapExpiredScopeReservations(db, { nowMs: 50, actorRef: 'tester' })
      expect(reaped.map(entry => entry.reservationId)).toEqual([stale.reservationId])
      expect(reaped[0]?.sequenceNo).toBe(20)
      const staleRow = db.prepare('SELECT status FROM scope_reservations WHERE id = ?').get(stale.reservationId) as {
        status: string
      }
      const liveRow = db.prepare('SELECT status FROM scope_reservations WHERE id = ?').get(live.reservationId) as {
        status: string
      }
      expect(staleRow.status).toBe('EXPIRED')
      expect(liveRow.status).toBe('ACTIVE')
      expect(reapExpiredScopeReservations(db, { nowMs: 50 })).toEqual([])
      expect(thrownReservationError(() => reapExpiredScopeReservations(db, { limit: 0 })).code).toBe('invalid-argument')

      // A trigger-forced event insert rolls the whole batch back: no row moves.
      db.prepare(
        'INSERT INTO scope_reservations '
        + '(id, project_id, work_item_id, actor_id, scope_kind, scope_value, acquired_at_ms, expires_at_ms, status) '
        + "VALUES ('sr:mini-dsh:later', 'mini-dsh', 'wi:mini-dsh:DB-001', ?, 'PATH', 'src/later.ts', 60, 70, 'ACTIVE')",
      ).run(lane.actorId)
      db.exec('CREATE TRIGGER forced_event_reject BEFORE INSERT ON project_events '
        + "BEGIN SELECT RAISE(ABORT, 'forced event rejection'); END")
      expect(() => reapExpiredScopeReservations(db, { nowMs: 80 })).toThrow('forced event rejection')
      const laterRow = db.prepare('SELECT status FROM scope_reservations WHERE id = ?')
        .get(brandString<ScopeReservationId>('sr:mini-dsh:later')) as { status: string }
      expect(laterRow.status).toBe('ACTIVE')
      db.exec('DROP TRIGGER forced_event_reject')
    } finally {
      db.close()
    }
  })
})

describe('readProjectScopeReservations', () => {
  it('lists reservations newest-first with item and actor labels resolved', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      const second = registerActor(db, PROJECT, {
        actorKey: 'second', actorKind: 'AGENT', displayName: 'Second',
      }, { nowMs: 21, actorRef: 'tester' })
      reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/first.ts', expiresAtMs: 900,
      }, { nowMs: 30, actorRef: 'tester' })
      const secondReservation = reserveScope(db, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'),
        actorId: second.actorId, scopeKind: 'PATH', scopeValue: 'src/second.ts', expiresAtMs: 900,
      }, { nowMs: 40, actorRef: 'tester' })
      releaseScopeReservation(db, secondReservation.reservationId, { nowMs: 41, actorRef: 'tester' })

      const reservations = readProjectScopeReservations(db, PROJECT)
      expect(reservations.map(reservation => reservation.reservationId)).toEqual([
        secondReservation.reservationId,
        brandString<ScopeReservationId>('sr:mini-dsh:19'),
      ])
      expect(reservations[0]?.stableKey).toBe('SCHEMA-001')
      expect(reservations[0]?.actorKey).toBe('second')
      expect(reservations[0]?.status).toBe('RELEASED')
      expect(reservations[0]?.releasedAtMs).toBe(41)
      expect(reservations[1]?.status).toBe('ACTIVE')
      expect(reservations[1]?.releasedAtMs).toBeUndefined()
      expect(readProjectScopeReservations(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across the reservation lifecycle', async () => {
    const db = await goldenLedger()
    try {
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 20, actorRef: 'tester' })
      reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/one.ts', expiresAtMs: 900,
      }, { nowMs: 22, actorRef: 'tester' })
      reserveScope(db, {
        workItemId: ITEM, actorId: lane.actorId, scopeKind: 'PATH', scopeValue: 'src/two.ts', expiresAtMs: 40,
      }, { nowMs: 23, actorRef: 'tester' })
      reapExpiredScopeReservations(db, { nowMs: 50, actorRef: 'tester' })
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.scopeReservations).toBe(2)
        expect(audit.materialized.scopeReservations).toBe(2)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
