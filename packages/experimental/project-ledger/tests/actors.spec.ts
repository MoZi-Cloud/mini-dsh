/** Actor/role-domain seam tests: register, define, assign, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_ACTOR_ACTOR_REF,
  ActorError,
  assignRole,
  compilePlan,
  defineRole,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  readProjectActors,
  readProjectReplay,
  registerActor,
  validatePlanSchema,
  type ActorId,
  type ActorKind,
  type ActorRoleId,
  type PlanVersionId,
  type ProjectId,
  type RoleId,
  type RegisterActorInput,
  type RoleKind,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)
const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_VERSION = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1')

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
 * Call a thunk and return the ActorError it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownActorError(call: () => unknown): ActorError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ActorError)
    return error as ActorError
  }
  expect.unreachable('expected the call to throw ActorError')
}

describe('registerActor', () => {
  it('records the actor and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const actor = registerActor(db, PROJECT, {
        actorKey: 'owner',
        actorKind: 'HUMAN',
        displayName: 'Owner',
        externalIdentity: 'lincoln@local',
        metadataJson: '{"gate":"go"}',
      }, { nowMs: 100, actorRef: 'tester' })
      expect(actor).toEqual({
        actorId: brandString<ActorId>('actor:mini-dsh:owner'),
        projectId: PROJECT,
        actorKey: 'owner',
        actorKind: 'HUMAN',
        displayName: 'Owner',
        externalIdentity: 'lincoln@local',
        metadataJson: '{"gate":"go"}',
        status: 'ACTIVE',
        createdAtMs: 100,
      })
      const row = db.prepare('SELECT id, status, created_at_ms FROM actors').get() as {
        id: string
        status: string
        created_at_ms: number
      }
      expect(row).toEqual({ id: 'actor:mini-dsh:owner', status: 'ACTIVE', created_at_ms: 100 })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 17').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('actor/registered')
      expect(event.entity_id).toBe('actor:mini-dsh:owner')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        actorId: 'actor:mini-dsh:owner',
        actorKey: 'owner',
        actorKind: 'HUMAN',
        displayName: 'Owner',
        externalIdentity: 'lincoln@local',
        metadataJson: '{"gate":"go"}',
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor and omits absent optionals', async () => {
    const db = await goldenLedger()
    try {
      registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 1 })
      const event = db.prepare('SELECT actor_ref, payload_json FROM project_events WHERE sequence_no = 17').get() as {
        actor_ref: string
        payload_json: string
      }
      expect(event.actor_ref).toBe(DEFAULT_ACTOR_ACTOR_REF)
      expect(JSON.parse(event.payload_json)).toEqual({
        actorId: 'actor:mini-dsh:lane',
        actorKey: 'lane',
        actorKind: 'AGENT',
        displayName: 'Lane',
      })
    } finally {
      db.close()
    }
  })

  it('rejects empty fields, bad kinds, non-object JSON, and duplicates without writing', async () => {
    const db = await goldenLedger()
    try {
      const brokenInputs: RegisterActorInput[] = [
        { actorKey: '', actorKind: 'HUMAN', displayName: 'N' },
        { actorKey: 'k', actorKind: 'HUMAN', displayName: '' },
        { actorKey: 'k', actorKind: 'TELEPORT' as ActorKind, displayName: 'N' },
        { actorKey: 'k', actorKind: 'HUMAN', displayName: 'N', metadataJson: '' },
        { actorKey: 'k', actorKind: 'HUMAN', displayName: 'N', metadataJson: '[1]' },
        { actorKey: 'k', actorKind: 'HUMAN', displayName: 'N', metadataJson: 'nope' },
      ]
      for (const broken of brokenInputs) {
        expect(thrownActorError(() => registerActor(db, PROJECT, broken)).code).toBe('invalid-argument')
      }
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)

      registerActor(db, PROJECT, { actorKey: 'once', actorKind: 'SYSTEM', displayName: 'Once' }, { nowMs: 1 })
      const duplicate = thrownActorError(() => registerActor(db, PROJECT, {
        actorKey: 'once', actorKind: 'SYSTEM', displayName: 'Once',
      }, { nowMs: 2 }))
      expect(duplicate.code).toBe('duplicate-actor-key')
      expect(duplicate.message).toContain('actor:mini-dsh:once')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(17)
    } finally {
      db.close()
    }
  })
})

describe('defineRole', () => {
  it('records the role and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const role = defineRole(db, PROJECT, {
        roleName: 'owner',
        roleKind: 'GOVERNANCE',
        description: 'gates decisions and approvals',
      }, { nowMs: 100, actorRef: 'tester' })
      expect(role).toEqual({
        roleId: brandString<RoleId>('role:mini-dsh:owner'),
        projectId: PROJECT,
        roleName: 'owner',
        roleKind: 'GOVERNANCE',
        description: 'gates decisions and approvals',
        createdAtMs: 100,
      })
      const event = db.prepare('SELECT event_type, payload_json FROM project_events WHERE sequence_no = 17').get() as {
        event_type: string
        payload_json: string
      }
      expect(event.event_type).toBe('role/defined')
      expect(JSON.parse(event.payload_json)).toEqual({
        roleId: 'role:mini-dsh:owner',
        roleName: 'owner',
        roleKind: 'GOVERNANCE',
        description: 'gates decisions and approvals',
      })
    } finally {
      db.close()
    }
  })

  it('rejects empty names, bad kinds, and duplicate names without writing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownActorError(() => defineRole(db, PROJECT, {
        roleName: '', roleKind: 'GOVERNANCE',
      })).code).toBe('invalid-argument')
      expect(thrownActorError(() => defineRole(db, PROJECT, {
        roleName: 'r', roleKind: 'TELEPORT' as RoleKind,
      })).code).toBe('invalid-argument')
      defineRole(db, PROJECT, { roleName: 'once', roleKind: 'EXECUTION' }, { nowMs: 1 })
      const duplicate = thrownActorError(() => defineRole(db, PROJECT, {
        roleName: 'once', roleKind: 'EXECUTION',
      }, { nowMs: 2 }))
      expect(duplicate.code).toBe('duplicate-role-name')
      expect(duplicate.message).toContain('role:mini-dsh:once')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(17)
    } finally {
      db.close()
    }
  })
})

describe('assignRole', () => {
  it('records the live assignment with a timeline-derived id', async () => {
    const db = await goldenLedger()
    try {
      const actor = registerActor(db, PROJECT, {
        actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
      }, { nowMs: 10, actorRef: 'tester' })
      const role = defineRole(db, PROJECT, { roleName: 'owner', roleKind: 'GOVERNANCE' }, { nowMs: 11, actorRef: 'tester' })
      const assignment = assignRole(db, {
        actorId: actor.actorId, roleId: role.roleId,
      }, { nowMs: 12, actorRef: 'tester' })
      expect(assignment).toEqual({
        assignmentId: brandString<ActorRoleId>('asg:mini-dsh:19'),
        actorId: actor.actorId,
        roleId: role.roleId,
        actorKey: 'owner',
        roleName: 'owner',
        validFromMs: 12,
        validToMs: undefined,
      })
      const event = db.prepare('SELECT event_type, payload_json FROM project_events WHERE sequence_no = 19').get() as {
        event_type: string
        payload_json: string
      }
      expect(event.event_type).toBe('role/assigned')
      expect(JSON.parse(event.payload_json)).toEqual({
        assignmentId: 'asg:mini-dsh:19',
        actorId: actor.actorId,
        roleId: role.roleId,
      })
    } finally {
      db.close()
    }
  })

  it('rejects unknown actors, foreign roles, and duplicate live assignments without writing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownActorError(() => assignRole(db, {
        actorId: brandString<ActorId>('actor:mini-dsh:ghost'),
        roleId: brandString<RoleId>('role:mini-dsh:ghost'),
      })).code).toBe('unknown-actor')

      const actor = registerActor(db, PROJECT, {
        actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
      }, { nowMs: 10, actorRef: 'tester' })
      expect(thrownActorError(() => assignRole(db, {
        actorId: actor.actorId, roleId: brandString<RoleId>('role:mini-dsh:ghost'),
      })).code).toBe('unknown-role')

      const foreignRole = defineRole(db, brandString<ProjectId>('other'), {
        roleName: 'ops', roleKind: 'EXECUTION',
      }, { nowMs: 11, actorRef: 'tester' })
      const foreign = thrownActorError(() => assignRole(db, {
        actorId: actor.actorId, roleId: foreignRole.roleId,
      }))
      expect(foreign.code).toBe('unknown-role')
      expect(foreign.message).toContain('not defined for project "mini-dsh"')

      const role = defineRole(db, PROJECT, { roleName: 'owner', roleKind: 'GOVERNANCE' }, { nowMs: 12, actorRef: 'tester' })
      assignRole(db, { actorId: actor.actorId, roleId: role.roleId }, { nowMs: 13, actorRef: 'tester' })
      const duplicate = thrownActorError(() => assignRole(db, {
        actorId: actor.actorId, roleId: role.roleId,
      }, { nowMs: 14, actorRef: 'tester' }))
      expect(duplicate.code).toBe('duplicate-assignment')
      expect((db.prepare('SELECT COUNT(*) AS n FROM actor_roles').get() as { n: number }).n).toBe(1)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(20)
    } finally {
      db.close()
    }
  })
})

describe('readProjectActors', () => {
  it('lists actors and roles newest-first with assignments in assignment order', async () => {
    const db = await goldenLedger()
    try {
      const owner = registerActor(db, PROJECT, {
        actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner', externalIdentity: 'lincoln@local',
      }, { nowMs: 20, actorRef: 'tester' })
      const lane = registerActor(db, PROJECT, {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane', metadataJson: '{"kind":"ci"}',
      }, { nowMs: 30, actorRef: 'tester' })
      const ownerRole = defineRole(db, PROJECT, {
        roleName: 'owner', roleKind: 'GOVERNANCE', description: 'gates the ledger',
      }, { nowMs: 40, actorRef: 'tester' })
      const executorRole = defineRole(db, PROJECT, { roleName: 'executor', roleKind: 'EXECUTION' }, { nowMs: 50, actorRef: 'tester' })
      assignRole(db, { actorId: owner.actorId, roleId: ownerRole.roleId }, { nowMs: 60, actorRef: 'tester' })
      assignRole(db, { actorId: lane.actorId, roleId: executorRole.roleId }, { nowMs: 70, actorRef: 'tester' })

      const directory = readProjectActors(db, PROJECT)
      expect(directory.projectId).toBe(PROJECT)
      expect(directory.actors.map(actor => actor.actorKey)).toEqual(['lane', 'owner'])
      const laneRow = directory.actors[0]
      expect(laneRow?.status).toBe('ACTIVE')
      expect(laneRow?.metadataJson).toBe('{"kind":"ci"}')
      const ownerRow = directory.actors[1]
      expect(ownerRow?.externalIdentity).toBe('lincoln@local')
      expect(directory.roles.map(role => role.roleName)).toEqual(['executor', 'owner'])
      const executorRow = directory.roles[0]
      expect(executorRow?.description).toBeUndefined()
      expect(directory.assignments.map(assignment => assignment.assignmentId)).toEqual([
        brandString<ActorRoleId>('asg:mini-dsh:21'),
        brandString<ActorRoleId>('asg:mini-dsh:22'),
      ])
      expect(directory.assignments[0]?.validToMs).toBeUndefined()
      expect(directory.assignments[0]?.actorKey).toBe('owner')
      expect(directory.assignments[0]?.roleName).toBe('owner')
      expect(directory.assignments[1]?.actorKey).toBe('lane')
      expect(directory.assignments[1]?.roleName).toBe('executor')
      expect(readProjectActors(db, brandString<ProjectId>('empty-project'))).toEqual({
        projectId: brandString<ProjectId>('empty-project'),
        actors: [],
        roles: [],
        assignments: [],
      })
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across a full directory', async () => {
    const db = await goldenLedger()
    try {
      const owner = registerActor(db, PROJECT, {
        actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
      }, { nowMs: 20, actorRef: 'tester' })
      const role = defineRole(db, PROJECT, { roleName: 'owner', roleKind: 'GOVERNANCE' }, { nowMs: 21, actorRef: 'tester' })
      assignRole(db, { actorId: owner.actorId, roleId: role.roleId }, { nowMs: 22, actorRef: 'tester' })
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.actors).toBe(1)
        expect(audit.replayed.roles).toBe(1)
        expect(audit.replayed.actorRoles).toBe(1)
        expect(audit.materialized.actors).toBe(1)
        expect(audit.materialized.roles).toBe(1)
        expect(audit.materialized.actorRoles).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
