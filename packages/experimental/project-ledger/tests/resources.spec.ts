/** Resource-domain seam tests: open, provide, verify, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_RESOURCE_ACTOR_REF,
  ResourceError,
  compilePlan,
  importPlanVersion,
  openResourceRequirement,
  parsePlanDocument,
  planDoctor,
  provideResourceInstance,
  readProjectReplay,
  readProjectResources,
  validatePlanSchema,
  verifyResourceInstance,
  type PlanVersionId,
  type ProjectId,
  type ResourceInstanceId,
  type ResourceRequirementId,
  type ResourceVerifierKind,
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
 * Call a thunk and return the ResourceError it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownResourceError(call: () => unknown): ResourceError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResourceError)
    return error as ResourceError
  }
  expect.unreachable('expected the call to throw ResourceError')
}

/** One full open→provide→verify loop through the shipped seams. */
function driveRequirement(db: DatabaseSync, requirementKey: string, nowMs: number): ResourceRequirementId {
  const requirement = openResourceRequirement(db, PROJECT, {
    requirementKey,
    requirementKind: 'ENVIRONMENT',
    name: `Requirement ${requirementKey}`,
    constraintsJson: '{"region":"host"}',
    planVersionId: GOLDEN_VERSION,
  }, { nowMs, actorRef: 'tester' })
  const instance = provideResourceInstance(db, {
    requirementId: requirement.requirementId,
    label: `${requirementKey}-instance`,
    provider: 'spec-provider',
  }, { nowMs: nowMs + 1, actorRef: 'tester' })
  verifyResourceInstance(db, instance.instanceId, {
    verifierKind: 'TEST',
    verifier: 'spec-verifier',
    verificationSpec: 'the instance answers',
    observedJson: '{"answer":true}',
    result: 'PASS',
  }, { nowMs: nowMs + 2, actorRef: 'tester' })
  return requirement.requirementId
}

describe('openResourceRequirement', () => {
  it('records the requirement and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const requirement = openResourceRequirement(db, PROJECT, {
        requirementKey: 'persistent-ledger',
        requirementKind: 'ENVIRONMENT',
        name: 'Persistent ledger file',
        constraintsJson: '{"journal":"wal"}',
        requestedFrom: 'owner',
        planVersionId: GOLDEN_VERSION,
      }, { nowMs: 100, actorRef: 'tester' })
      expect(requirement).toEqual({
        requirementId: brandString<ResourceRequirementId>('rr:mini-dsh:persistent-ledger'),
        projectId: PROJECT,
        planVersionId: GOLDEN_VERSION,
        requirementKey: 'persistent-ledger',
        requirementKind: 'ENVIRONMENT',
        name: 'Persistent ledger file',
        constraintsJson: '{"journal":"wal"}',
        status: 'OPEN',
        requestedFrom: 'owner',
        createdAtMs: 100,
        instances: [],
      })
      const row = db.prepare('SELECT id, status, created_at_ms FROM resource_requirements').get() as {
        id: string
        status: string
        created_at_ms: number
      }
      expect(row).toEqual({ id: 'rr:mini-dsh:persistent-ledger', status: 'OPEN', created_at_ms: 100 })
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 17').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('resource/required')
      expect(event.entity_id).toBe('rr:mini-dsh:persistent-ledger')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        requirementId: 'rr:mini-dsh:persistent-ledger',
        requirementKey: 'persistent-ledger',
        requirementKind: 'ENVIRONMENT',
        name: 'Persistent ledger file',
        constraintsJson: '{"journal":"wal"}',
        requestedFrom: 'owner',
        planVersionId: GOLDEN_VERSION,
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor on the event', async () => {
    const db = await goldenLedger()
    try {
      openResourceRequirement(db, PROJECT, {
        requirementKey: 'actor', requirementKind: 'TOOL', name: 'Actor', constraintsJson: '{}',
      }, { nowMs: 1 })
      const event = db.prepare('SELECT actor_ref FROM project_events WHERE sequence_no = 17').get() as { actor_ref: string }
      expect(event.actor_ref).toBe(DEFAULT_RESOURCE_ACTOR_REF)
    } finally {
      db.close()
    }
  })

  it('rejects empty fields, non-object JSON, duplicates, and foreign plan versions without writing', async () => {
    const db = await goldenLedger()
    try {
      for (const broken of [
        { requirementKey: '', requirementKind: 'K', name: 'N', constraintsJson: '{}' },
        { requirementKey: 'k', requirementKind: '', name: 'N', constraintsJson: '{}' },
        { requirementKey: 'k', requirementKind: 'K', name: '', constraintsJson: '{}' },
        { requirementKey: 'k', requirementKind: 'K', name: 'N', constraintsJson: '' },
        { requirementKey: 'k', requirementKind: 'K', name: 'N', constraintsJson: '[1]' },
        { requirementKey: 'k', requirementKind: 'K', name: 'N', constraintsJson: 'nope' },
      ]) {
        expect(thrownResourceError(() => openResourceRequirement(db, PROJECT, broken)).code).toBe('invalid-argument')
      }
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)

      openResourceRequirement(db, PROJECT, {
        requirementKey: 'once', requirementKind: 'K', name: 'N', constraintsJson: '{}',
      }, { nowMs: 1 })
      const duplicate = thrownResourceError(() => openResourceRequirement(db, PROJECT, {
        requirementKey: 'once', requirementKind: 'K', name: 'N', constraintsJson: '{}',
      }, { nowMs: 2 }))
      expect(duplicate.code).toBe('duplicate-requirement-key')
      expect(duplicate.message).toContain('rr:mini-dsh:once')

      expect(thrownResourceError(() => openResourceRequirement(db, PROJECT, {
        requirementKey: 'foreign', requirementKind: 'K', name: 'N', constraintsJson: '{}',
        planVersionId: brandString<PlanVersionId>('plv:elsewhere:v1'),
      })).code).toBe('unknown-plan-version')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(17)
    } finally {
      db.close()
    }
  })
})

describe('provideResourceInstance', () => {
  it('records the instance against the requirement with a timeline-derived id', async () => {
    const db = await goldenLedger()
    try {
      const requirement = openResourceRequirement(db, PROJECT, {
        requirementKey: 'ledger-file', requirementKind: 'ENVIRONMENT', name: 'Ledger file', constraintsJson: '{}',
      }, { nowMs: 10, actorRef: 'tester' })
      const instance = provideResourceInstance(db, {
        requirementId: requirement.requirementId,
        label: 'ledger.sqlite',
        provider: 'host',
        metadataJson: '{"path":"~/.dsh/project-ledger/ledger.sqlite"}',
      }, { nowMs: 11, actorRef: 'tester' })
      expect(instance).toEqual({
        instanceId: brandString<ResourceInstanceId>('ri:mini-dsh:18'),
        requirementId: requirement.requirementId,
        label: 'ledger.sqlite',
        provider: 'host',
        metadataJson: '{"path":"~/.dsh/project-ledger/ledger.sqlite"}',
        status: 'AVAILABLE',
        providedAtMs: 11,
        verifications: [],
      })
      const event = db.prepare('SELECT event_type, payload_json FROM project_events WHERE sequence_no = 18').get() as {
        event_type: string
        payload_json: string
      }
      expect(event.event_type).toBe('resource/provided')
      expect(JSON.parse(event.payload_json)).toEqual({
        instanceId: 'ri:mini-dsh:18',
        requirementId: requirement.requirementId,
        label: 'ledger.sqlite',
        provider: 'host',
        metadataJson: '{"path":"~/.dsh/project-ledger/ledger.sqlite"}',
      })
    } finally {
      db.close()
    }
  })

  it('rejects unknown requirements, closed requirements, and bad fields, writing nothing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownResourceError(() => provideResourceInstance(db, {
        requirementId: brandString<ResourceRequirementId>('rr:mini-dsh:ghost'), label: 'x',
      })).code).toBe('unknown-resource-requirement')

      const requirement = openResourceRequirement(db, PROJECT, {
        requirementKey: 'k', requirementKind: 'K', name: 'N', constraintsJson: '{}',
      }, { nowMs: 10, actorRef: 'tester' })
      expect(thrownResourceError(() => provideResourceInstance(db, {
        requirementId: requirement.requirementId, label: '',
      })).code).toBe('invalid-argument')
      expect(thrownResourceError(() => provideResourceInstance(db, {
        requirementId: requirement.requirementId, label: 'x', metadataJson: 'nope',
      })).code).toBe('invalid-argument')
      expect((db.prepare('SELECT COUNT(*) AS n FROM resource_instances').get() as { n: number }).n).toBe(0)

      db.prepare("UPDATE resource_requirements SET status = 'FULFILLED' WHERE id = ?").run(requirement.requirementId)
      const closed = thrownResourceError(() => provideResourceInstance(db, {
        requirementId: requirement.requirementId, label: 'late',
      }))
      expect(closed.code).toBe('unknown-resource-requirement')
      expect(closed.message).toContain('is FULFILLED')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(17)
    } finally {
      db.close()
    }
  })
})

describe('verifyResourceInstance', () => {
  it('records the verification with the stored spec and observed facts', async () => {
    const db = await goldenLedger()
    try {
      const requirement = openResourceRequirement(db, PROJECT, {
        requirementKey: 'k', requirementKind: 'K', name: 'N', constraintsJson: '{}',
      }, { nowMs: 10, actorRef: 'tester' })
      const instance = provideResourceInstance(db, {
        requirementId: requirement.requirementId, label: 'inst',
      }, { nowMs: 11, actorRef: 'tester' })
      const verification = verifyResourceInstance(db, instance.instanceId, {
        verifierKind: 'COMMAND',
        verifier: 'lane',
        verificationSpec: 'the command exits 0',
        observedJson: '{"exitCode":0}',
        result: 'PASS',
      }, { nowMs: 12, actorRef: 'tester' })
      expect(verification).toEqual({
        verificationId: `rv:${instance.instanceId}:19`,
        instanceId: instance.instanceId,
        verifierKind: 'COMMAND',
        verifier: 'lane',
        verificationSpec: 'the command exits 0',
        observedJson: '{"exitCode":0}',
        result: 'PASS',
        verifiedAtMs: 12,
      })
      const event = db.prepare('SELECT event_type, payload_json FROM project_events WHERE sequence_no = 19').get() as {
        event_type: string
        payload_json: string
      }
      expect(event.event_type).toBe('resource/verified')
      expect(JSON.parse(event.payload_json)).toEqual({
        verificationId: `rv:${instance.instanceId}:19`,
        instanceId: instance.instanceId,
        verifierKind: 'COMMAND',
        verifier: 'lane',
        verificationSpec: 'the command exits 0',
        observedJson: '{"exitCode":0}',
        result: 'PASS',
        verifiedAtMs: 12,
      })
    } finally {
      db.close()
    }
  })

  it('rejects unknown instances, invalid kinds and results, and bad fields, writing nothing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownResourceError(() => verifyResourceInstance(db, brandString<ResourceInstanceId>('ri:mini-dsh:ghost'), {
        verifierKind: 'TEST', verificationSpec: 'x', result: 'PASS',
      })).code).toBe('unknown-resource-instance')

      const requirement = openResourceRequirement(db, PROJECT, {
        requirementKey: 'k', requirementKind: 'K', name: 'N', constraintsJson: '{}',
      }, { nowMs: 10, actorRef: 'tester' })
      const instance = provideResourceInstance(db, {
        requirementId: requirement.requirementId, label: 'inst',
      }, { nowMs: 11, actorRef: 'tester' })
      expect(thrownResourceError(() => verifyResourceInstance(db, instance.instanceId, {
        verifierKind: 'TELEPORT' as ResourceVerifierKind, verificationSpec: 'x', result: 'PASS',
      })).code).toBe('invalid-argument')
      expect(thrownResourceError(() => verifyResourceInstance(db, instance.instanceId, {
        verifierKind: 'TEST', verificationSpec: 'x', result: 'SO_PASS' as 'PASS',
      })).code).toBe('invalid-argument')
      expect(thrownResourceError(() => verifyResourceInstance(db, instance.instanceId, {
        verifierKind: 'TEST', verificationSpec: '', result: 'PASS',
      })).code).toBe('invalid-argument')
      expect(thrownResourceError(() => verifyResourceInstance(db, instance.instanceId, {
        verifierKind: 'TEST', verificationSpec: 'x', observedJson: '[1]', result: 'PASS',
      })).code).toBe('invalid-argument')
      expect((db.prepare('SELECT COUNT(*) AS n FROM resource_verifications').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(18)
    } finally {
      db.close()
    }
  })
})

describe('readProjectResources', () => {
  it('lists requirements newest-first with instances and verifications nested', async () => {
    const db = await goldenLedger()
    try {
      driveRequirement(db, 'first', 20)
      driveRequirement(db, 'second', 30)

      // An instance nobody verified and a requirement naming no plan version
      // or requester exercise the read's absent-side branches.
      const bare = openResourceRequirement(db, PROJECT, {
        requirementKey: 'bare', requirementKind: 'TOOL', name: 'Bare', constraintsJson: '{}',
      }, { nowMs: 40, actorRef: 'tester' })
      provideResourceInstance(db, {
        requirementId: bare.requirementId, label: 'bare-instance',
      }, { nowMs: 41, actorRef: 'tester' })
      openResourceRequirement(db, PROJECT, {
        requirementKey: 'lonely', requirementKind: 'TOOL', name: 'Lonely', constraintsJson: '{}',
      }, { nowMs: 42, actorRef: 'tester' })

      const requirements = readProjectResources(db, PROJECT)
      expect(requirements.map(requirement => requirement.requirementKey)).toEqual(['lonely', 'bare', 'second', 'first'])
      expect(requirements[0]?.instances).toEqual([])
      const lonely = requirements[0]
      expect(lonely?.instances).toEqual([])
      const bareListed = requirements[1]
      expect(bareListed?.planVersionId).toBeUndefined()
      expect(bareListed?.requestedFrom).toBeUndefined()
      expect(bareListed?.instances[0]?.verifications).toEqual([])
      const requirement = requirements[2]
      expect(requirement?.planVersionId).toBe(GOLDEN_VERSION)
      expect(requirement?.status).toBe('OPEN')
      expect(requirement?.instances).toHaveLength(1)
      const instance = requirement?.instances[0]
      expect(instance?.status).toBe('AVAILABLE')
      expect(instance?.verifications).toHaveLength(1)
      expect(instance?.verifications[0]?.result).toBe('PASS')
      expect(instance?.verifications[0]?.observedJson).toBe('{"answer":true}')
      expect(readProjectResources(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across full resource loops', async () => {
    const db = await goldenLedger()
    try {
      driveRequirement(db, 'parity', 20)
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.resourceRequirements).toBe(1)
        expect(audit.replayed.resourceInstances).toBe(1)
        expect(audit.replayed.resourceVerifications).toBe(1)
        expect(audit.materialized.resourceRequirements).toBe(1)
        expect(audit.materialized.resourceInstances).toBe(1)
        expect(audit.materialized.resourceVerifications).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
