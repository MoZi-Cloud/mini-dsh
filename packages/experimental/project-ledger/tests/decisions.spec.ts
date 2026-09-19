/** Decision-domain seam tests: open, record, list, and their rejections over the golden import. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  DEFAULT_DECISION_ACTOR_REF,
  DecisionError,
  compilePlan,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  planDoctor,
  readProjectDecisions,
  readProjectReplay,
  recordDecision,
  validatePlanSchema,
  type CompiledPlan,
  type DecisionId,
  type DecisionRequestId,
  type PlanVersionId,
  type ProjectId,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)
const PROJECT = brandString<ProjectId>('mini-dsh')
const GOLDEN_VERSION = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1')

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
 * Call a thunk and return the DecisionError it threw; any other outcome fails
 * the test through the instance assertion or the unreachable marker.
 */
function thrownDecisionError(call: () => unknown): DecisionError {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DecisionError)
    return error as DecisionError
  }
  expect.unreachable('expected the call to throw DecisionError')
}

/** One full open→record loop through the shipped seams; `selected === null` records a free-text decision. */
function driveDecision(
  db: DatabaseSync,
  decisionKey: string,
  nowMs: number,
  selected: string | null = 'enter',
): DecisionRequestId {
  const request = openDecisionRequest(db, PROJECT, {
    decisionKey,
    title: `Decision ${decisionKey}`,
    question: `Should ${decisionKey} proceed?`,
    context: 'decisions.spec',
    blockingLevel: 'BLOCKING',
    planVersionId: GOLDEN_VERSION,
    raisedBy: 'tester',
    options: [
      { optionKey: 'enter', label: 'Enter', recommended: true },
      { optionKey: 'wait', label: 'Wait' },
    ],
  }, { nowMs, actorRef: 'tester' })
  recordDecision(db, request.requestId, {
    decidedBy: 'owner',
    ...(selected === null ? {} : { selectedOptionKey: selected }),
    decisionText: `${decisionKey}: recorded`,
    rationale: 'decisions.spec rationale',
  }, { nowMs: nowMs + 1, actorRef: 'tester' })
  return request.requestId
}

describe('openDecisionRequest', () => {
  it('records the request, its options, and one required event atomically', async () => {
    const db = await goldenLedger()
    try {
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'v1.6b-entry',
        title: 'Enter v1.6b',
        question: 'Does the §33 evidence carry?',
        blockingLevel: 'ADVISORY',
        options: [
          { optionKey: 'enter', label: 'Enter', description: 'Start the next stage', recommended: true },
          { optionKey: 'wait', label: 'Wait' },
        ],
      }, { nowMs: 100, actorRef: 'tester' })
      expect(request).toEqual({
        requestId: brandString<DecisionRequestId>('dr:mini-dsh:v1.6b-entry'),
        projectId: PROJECT,
        planVersionId: undefined,
        decisionKey: 'v1.6b-entry',
        title: 'Enter v1.6b',
        question: 'Does the §33 evidence carry?',
        context: undefined,
        blockingLevel: 'ADVISORY',
        status: 'OPEN',
        raisedBy: undefined,
        createdAtMs: 100,
        resolvedAtMs: undefined,
        options: [
          { optionId: 'do:dr:mini-dsh:v1.6b-entry:enter', optionKey: 'enter', label: 'Enter', description: 'Start the next stage', recommended: true, ordinal: 0 },
          { optionId: 'do:dr:mini-dsh:v1.6b-entry:wait', optionKey: 'wait', label: 'Wait', description: undefined, recommended: false, ordinal: 1 },
        ],
        decision: undefined,
      })
      const row = db.prepare('SELECT id, status, created_at_ms FROM decision_requests').get() as { id: string; status: string; created_at_ms: number }
      expect(row).toEqual({ id: 'dr:mini-dsh:v1.6b-entry', status: 'OPEN', created_at_ms: 100 })
      expect((db.prepare('SELECT COUNT(*) AS n FROM decision_options').get() as { n: number }).n).toBe(2)
      const event = db.prepare('SELECT event_type, entity_id, actor_ref, payload_json FROM project_events WHERE sequence_no = 17').get() as {
        event_type: string
        entity_id: string
        actor_ref: string
        payload_json: string
      }
      expect(event.event_type).toBe('decision/requested')
      expect(event.entity_id).toBe('dr:mini-dsh:v1.6b-entry')
      expect(event.actor_ref).toBe('tester')
      expect(JSON.parse(event.payload_json)).toEqual({
        requestId: 'dr:mini-dsh:v1.6b-entry',
        decisionKey: 'v1.6b-entry',
        title: 'Enter v1.6b',
        question: 'Does the §33 evidence carry?',
        blockingLevel: 'ADVISORY',
        options: [
          { optionKey: 'enter', label: 'Enter', description: 'Start the next stage', recommended: true, ordinal: 0 },
          { optionKey: 'wait', label: 'Wait', recommended: false, ordinal: 1 },
        ],
      })
    } finally {
      db.close()
    }
  })

  it('stamps the default actor on the event', async () => {
    const db = await goldenLedger()
    try {
      openDecisionRequest(db, PROJECT, { decisionKey: 'actor', title: 'Actor', question: 'Who?', blockingLevel: 'ADVISORY' }, { nowMs: 1 })
      const event = db.prepare('SELECT actor_ref FROM project_events WHERE sequence_no = 17').get() as { actor_ref: string }
      expect(event.actor_ref).toBe(DEFAULT_DECISION_ACTOR_REF)
    } finally {
      db.close()
    }
  })

  it('rejects empty identity fields and unknown blocking levels without writing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: '', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
      })).code).toBe('invalid-argument')
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'k', title: '', question: 'Q', blockingLevel: 'ADVISORY',
      })).code).toBe('invalid-argument')
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'k', title: 'T', question: '', blockingLevel: 'ADVISORY',
      })).code).toBe('invalid-argument')
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'k', title: 'T', question: 'Q', blockingLevel: 'SUGGESTIVE' as 'ADVISORY',
      })).code).toBe('invalid-argument')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)
    } finally {
      db.close()
    }
  })

  it('rejects repeated option keys and more than one recommended option', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'dup-options', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
        options: [{ optionKey: 'a', label: 'A' }, { optionKey: 'a', label: 'A again' }],
      })).code).toBe('invalid-argument')
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'two-recommended', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
        options: [{ optionKey: 'a', label: 'A', recommended: true }, { optionKey: 'b', label: 'B', recommended: true }],
      })).code).toBe('invalid-argument')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)
    } finally {
      db.close()
    }
  })

  it('rejects a decision key the project already records', async () => {
    const db = await goldenLedger()
    try {
      openDecisionRequest(db, PROJECT, { decisionKey: 'once', title: 'T', question: 'Q', blockingLevel: 'ADVISORY' }, { nowMs: 1 })
      const duplicate = thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'once', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
      }, { nowMs: 2 }))
      expect(duplicate.code).toBe('duplicate-decision-key')
      expect(duplicate.message).toContain('dr:mini-dsh:once')
    } finally {
      db.close()
    }
  })

  it('rejects a plan version of another project or none at all', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownDecisionError(() => openDecisionRequest(db, PROJECT, {
        decisionKey: 'foreign', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
        planVersionId: brandString<PlanVersionId>('plv:elsewhere:v1'),
      })).code).toBe('unknown-plan-version')
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(16)
    } finally {
      db.close()
    }
  })
})

describe('recordDecision', () => {
  it('resolves the request exactly once with the selected option', async () => {
    const db = await goldenLedger()
    try {
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'entry',
        title: 'T',
        question: 'Q',
        blockingLevel: 'BLOCKING',
        options: [{ optionKey: 'go', label: 'Go', recommended: true }, { optionKey: 'stay', label: 'Stay' }],
      }, { nowMs: 10, actorRef: 'tester' })
      const decision = recordDecision(db, request.requestId, {
        decidedBy: 'owner',
        selectedOptionKey: 'go',
        decisionText: 'Go.',
        rationale: 'evidence',
      }, { nowMs: 11, actorRef: 'tester' })
      expect(decision).toEqual({
        decisionId: brandString<DecisionId>('dc:dr:mini-dsh:entry:18'),
        requestId: request.requestId,
        decidedBy: 'owner',
        selectedOptionId: 'do:dr:mini-dsh:entry:go',
        selectedOptionKey: 'go',
        decisionText: 'Go.',
        rationale: 'evidence',
        decidedAtMs: 11,
      })
      const requestRow = db.prepare('SELECT status, resolved_at_ms FROM decision_requests').get() as { status: string; resolved_at_ms: number }
      expect(requestRow).toEqual({ status: 'RESOLVED', resolved_at_ms: 11 })
      const event = db.prepare('SELECT event_type, payload_json FROM project_events WHERE sequence_no = 18').get() as { event_type: string; payload_json: string }
      expect(event.event_type).toBe('decision/recorded')
      expect(JSON.parse(event.payload_json)).toEqual({
        requestId: 'dr:mini-dsh:entry',
        decisionId: 'dc:dr:mini-dsh:entry:18',
        decidedBy: 'owner',
        selectedOptionKey: 'go',
        decisionText: 'Go.',
        rationale: 'evidence',
        resolvedAtMs: 11,
      })
    } finally {
      db.close()
    }
  })

  it('rejects unknown requests, resolved requests, unknown options, and empty fields, writing nothing', async () => {
    const db = await goldenLedger()
    try {
      expect(thrownDecisionError(() => recordDecision(db, brandString<DecisionRequestId>('dr:mini-dsh:ghost'), {
        decidedBy: 'owner', decisionText: 'x',
      })).code).toBe('unknown-decision-request')

      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'once', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
        options: [{ optionKey: 'a', label: 'A' }],
      }, { nowMs: 10, actorRef: 'tester' })
      expect(thrownDecisionError(() => recordDecision(db, request.requestId, {
        decidedBy: 'owner', decisionText: '',
      })).code).toBe('invalid-argument')
      expect(thrownDecisionError(() => recordDecision(db, request.requestId, {
        decidedBy: '', decisionText: 'x',
      })).code).toBe('invalid-argument')
      expect(thrownDecisionError(() => recordDecision(db, request.requestId, {
        decidedBy: 'owner', selectedOptionKey: 'alien', decisionText: 'x',
      })).code).toBe('unknown-decision-option')
      expect((db.prepare('SELECT status FROM decision_requests').get() as { status: string }).status).toBe('OPEN')
      expect((db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }).n).toBe(17)

      recordDecision(db, request.requestId, { decidedBy: 'owner', decisionText: 'resolved' }, { nowMs: 11, actorRef: 'tester' })
      expect(thrownDecisionError(() => recordDecision(db, request.requestId, {
        decidedBy: 'owner', decisionText: 'again',
      })).code).toBe('decision-request-resolved')
      expect((db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe('readProjectDecisions', () => {
  it('lists requests newest-first with options and resolving decisions', async () => {
    const db = await goldenLedger()
    try {
      driveDecision(db, 'first', 20)
      driveDecision(db, 'second', 30, null)
      openDecisionRequest(db, PROJECT, {
        decisionKey: 'open', title: 'Still open', question: 'Q', blockingLevel: 'ADVISORY',
      }, { nowMs: 40, actorRef: 'tester' })

      const requests = readProjectDecisions(db, PROJECT)
      expect(requests.map(request => request.decisionKey)).toEqual(['open', 'second', 'first'])
      const open = requests[0]
      expect(open?.status).toBe('OPEN')
      expect(open?.decision).toBeUndefined()
      expect(open?.options).toEqual([])
      const freeText = requests[1]
      expect(freeText?.status).toBe('RESOLVED')
      expect(freeText?.resolvedAtMs).toBe(31)
      expect(freeText?.decision?.selectedOptionKey).toBeUndefined()
      expect(freeText?.decision?.decisionText).toBe('second: recorded')
      const selected = requests[2]
      expect(selected?.decision?.selectedOptionKey).toBe('enter')
      expect(selected?.options.map(option => option.optionKey)).toEqual(['enter', 'wait'])
      expect(readProjectDecisions(db, brandString<ProjectId>('empty-project'))).toEqual([])
    } finally {
      db.close()
    }
  })

  it('leaves the selected option key undefined when the stored option id names no option of this request', async () => {
    const db = await goldenLedger()
    try {
      const other = openDecisionRequest(db, PROJECT, {
        decisionKey: 'other', title: 'Other', question: 'Q', blockingLevel: 'ADVISORY',
        options: [{ optionKey: 'a', label: 'A' }],
      }, { nowMs: 10, actorRef: 'tester' })
      const request = openDecisionRequest(db, PROJECT, {
        decisionKey: 'dangling', title: 'T', question: 'Q', blockingLevel: 'ADVISORY',
        options: [{ optionKey: 'a', label: 'A' }],
      }, { nowMs: 12, actorRef: 'tester' })
      recordDecision(db, request.requestId, {
        decidedBy: 'owner', selectedOptionKey: 'a', decisionText: 'picked a',
      }, { nowMs: 13, actorRef: 'tester' })
      // The foreign option id satisfies the schema's foreign key but names no
      // option of this request, so the read cannot resolve it to a key.
      db.prepare('UPDATE decisions SET selected_option_id = ? WHERE decision_request_id = ?')
        .run('do:dr:mini-dsh:other:a', request.requestId)
      const listed = readProjectDecisions(db, PROJECT)
      expect(listed[0]?.decision?.selectedOptionId).toBe('do:dr:mini-dsh:other:a')
      expect(listed[0]?.decision?.selectedOptionKey).toBeUndefined()
      expect(other.status).toBe('OPEN')
    } finally {
      db.close()
    }
  })

  it('keeps the replay audit and the doctor clean across a full decision loop', async () => {
    const db = await goldenLedger()
    try {
      driveDecision(db, 'parity', 20)
      const audit = readProjectReplay(db, PROJECT)
      expect(audit.outcome).toBe('compared')
      if (audit.outcome === 'compared') {
        expect(audit.drift).toEqual([])
        expect(audit.replayed.decisionRequests).toBe(1)
        expect(audit.replayed.decisions).toBe(1)
        expect(audit.materialized.decisionRequests).toBe(1)
        expect(audit.materialized.decisions).toBe(1)
      }
      expect(planDoctor(db, GOLDEN_VERSION).issues).toEqual([])
    } finally {
      db.close()
    }
  })
})
