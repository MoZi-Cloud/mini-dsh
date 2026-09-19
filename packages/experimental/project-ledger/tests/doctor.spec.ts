import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  PlanDoctorError,
  assignRole,
  assignWorkItem,
  claimWorkItem,
  compilePlan,
  decideApproval,
  defineRole,
  evaluateAcceptanceCriterion,
  changeWorkStatus,
  importPlanVersion,
  openDecisionRequest,
  parsePlanDocument,
  planDoctor,
  recordDecision,
  openResourceRequirement,
  provideResourceInstance,
  registerActor,
  releaseWorkLease,
  requestApproval,
  validatePlanSchema,
  verifyResourceInstance,
  type AcceptanceCriterionId,
  type CompiledPlan,
  type PlanVersionId,
  type ProjectId,
  type WorkItemId,
  type WorkLeaseClaim,
} from '../src/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

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
 * Open the golden ledger, drive its W01 entry items DONE through the real
 * writers — releasing each claim, as the shipped tools do around delivery —
 * and claim SCHEMA-001, the item their completion readies.
 */
async function claimGoldenSchemaItem(): Promise<{ db: DatabaseSync; claim: WorkLeaseClaim }> {
  const db = await goldenLedger()
  // Activation and phase state have no writers; the DONE moves go
  // through the real writers so replay parity holds.
  db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
  db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W01')
  for (const [stableKey, criterion] of [['OWNER-REVIEW-001', 'AC-OWNER-001'], ['PRE-001', 'AC-PRE-001']] as const) {
    const id = brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`)
    const claim = claimWorkItem(db, id, 'doctor/agent', { nowMs: 30 })
    changeWorkStatus(db, id, 'VERIFYING', { nowMs: 32, actorRef: 'doctor/agent' })
    releaseWorkLease(db, claim.leaseId, claim.leaseToken, { nowMs: 33, actorRef: 'doctor/agent' })
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`),
      'WAIVED',
      { nowMs: 34, evaluatedBy: 'doctor/agent' },
    )
    changeWorkStatus(db, id, 'DONE', { nowMs: 36, actorRef: 'doctor/agent' })
  }
  const claim = claimWorkItem(db, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'doctor/agent', { nowMs: 40 })
  return { db, claim }
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

describe('planDoctor', () => {
  it('reports zero issues for the golden import, before and after activation (BOOT-01)', async () => {
    const db = await goldenLedger()
    try {
      const expected = {
        planVersionId: 'plv:mini-dsh-v1.6a-ledger:v1',
        planId: 'mini-dsh-v1.6a-ledger',
        versionNo: 1,
        status: 'DRAFT',
        projectId: 'mini-dsh',
        databaseUserVersion: 6,
        eventFormatVersion: 6,
        baselineRepoHead: null,
        baselineWorktreeHash: null,
        counts: { phases: 13, workItems: 15, relations: 14, criteria: 16, events: 16 },
        issues: [],
      }
      expect(planDoctor(db, GOLDEN_VERSION)).toEqual(expected)
      db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
      expect(planDoctor(db, GOLDEN_VERSION)).toEqual({ ...expected, status: 'ACTIVE' })
    } finally {
      db.close()
    }
  })

  it('stays clean across a full real work loop and fails loud on an unknown version', async () => {
    const { db, claim } = await claimGoldenSchemaItem()
    try {
      const id = brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001')
      changeWorkStatus(db, id, 'VERIFYING', { nowMs: 45, actorRef: 'doctor/agent' })
      releaseWorkLease(db, claim.leaseId, claim.leaseToken, { nowMs: 46, actorRef: 'doctor/agent' })
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001'),
        'PASS',
        { nowMs: 50, evaluatedBy: 'doctor/agent' },
      )
      changeWorkStatus(db, id, 'DONE', { nowMs: 55, actorRef: 'doctor/agent' })
      const report = planDoctor(db, GOLDEN_VERSION)
      expect(report.issues).toEqual([])
      expect(report.counts).toEqual({ phases: 13, workItems: 15, relations: 14, criteria: 16, events: 31 })
      expect(report.status).toBe('ACTIVE')

      const error = thrownError(PlanDoctorError, () =>
        planDoctor(db, brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v9')))
      expect(error.code).toBe('unknown-plan-version')
      expect(error.message).toContain('is not recorded in this ledger')
    } finally {
      db.close()
    }
  })

  it('flags leases still ACTIVE past their expiry on the reading clock', async () => {
    const { db, claim } = await claimGoldenSchemaItem()
    try {
      // Before the horizon the pass stays clean; the reading clock is the
      // check's only input, and the released predecessor leases prove a
      // row past its old expiry never trips it once it is no longer ACTIVE.
      expect(planDoctor(db, GOLDEN_VERSION, { nowMs: claim.expiresAtMs - 1 }).issues).toEqual([])
      expect(planDoctor(db, GOLDEN_VERSION, { nowMs: claim.expiresAtMs }).issues).toEqual([
        {
          code: 'stale-active-lease',
          refId: claim.leaseId,
          message: `work lease "${claim.leaseId}" is still ACTIVE past its expiry at ${claim.expiresAtMs}; `
            + 'the reaper owns its recovery',
        },
      ])
    } finally {
      db.close()
    }
  })

  it('flags items without acceptance and criteria without verifiers', async () => {
    const db = await goldenLedger()
    try {
      db.prepare(
        'INSERT INTO work_items (id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, '
        + 'work_type, executor_kind, title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:mini-dsh:ADHOC-9', 'mini-dsh', 'plv:mini-dsh-v1.6a-ledger:v1', NULL, NULL, 'ADHOC-9', "
        + "'IMPLEMENTATION', 'AGENT', 'Unchecked item', NULL, 0, 'READY', 0, 5, 5)",
      ).run()
      db.prepare('DELETE FROM verification_specs WHERE criterion_id = ?')
        .run('ac:wi:mini-dsh:DB-001:AC-DB-001')
      const issues = planDoctor(db, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'work-item-without-acceptance',
          refId: 'wi:mini-dsh:ADHOC-9',
          message: 'work item "wi:mini-dsh:ADHOC-9" records no acceptance criterion; a completable item owes at least one',
        },
        {
          code: 'criterion-without-verifier',
          refId: 'ac:wi:mini-dsh:DB-001:AC-DB-001',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-DB-001" records no verification spec; its outcome would be unverifiable',
        },
        {
          code: 'projection-drift',
          refId: 'wi:mini-dsh:ADHOC-9',
          message: 'work item "wi:mini-dsh:ADHOC-9" has materialized status READY but no replayed work/created event',
        },
      ])
    } finally {
      db.close()
    }
  })

  it('flags hierarchy and ordering cycles and cross-project relations', async () => {
    const db = await goldenLedger()
    try {
      db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE stable_key = ?')
        .run('wi:mini-dsh:DB-001', 'SCHEMA-001')
      db.prepare('UPDATE work_items SET parent_work_item_id = ? WHERE stable_key = ?')
        .run('wi:mini-dsh:SCHEMA-001', 'DB-001')
      db.prepare(
        'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
        + "VALUES ('rel:cycle:1', 'wi:mini-dsh:DB-001', 'wi:mini-dsh:SCHEMA-001', 'BLOCKS', 5)",
      ).run()
      db.prepare(
        'INSERT INTO work_items (id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, '
        + 'work_type, executor_kind, title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
        + "VALUES ('wi:other:ITEM-1', 'other-project', NULL, NULL, NULL, 'ITEM-1', "
        + "'IMPLEMENTATION', 'AGENT', 'Other project item', NULL, 0, 'READY', 0, 5, 5)",
      ).run()
      db.prepare(
        'INSERT INTO work_item_relations (id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) '
        + "VALUES ('rel:cross:1', 'wi:mini-dsh:SCHEMA-001', 'wi:other:ITEM-1', 'RELATES_TO', 5)",
      ).run()
      const issues = planDoctor(db, GOLDEN_VERSION).issues
      const codes = issues.map(issue => issue.code)
      expect(codes.filter(code => code === 'hierarchy-cycle')).toHaveLength(1)
      expect(codes.filter(code => code === 'ordering-cycle')).toHaveLength(1)
      expect(codes).toContain('relation-crosses-projects')
      const ordering = issues.find(issue => issue.code === 'ordering-cycle')
      expect(ordering?.message).toContain('wi:mini-dsh:DB-001')
      expect(ordering?.message).toContain('wi:mini-dsh:SCHEMA-001')
      expect(issues.find(issue => issue.code === 'relation-crosses-projects')?.message)
        .toContain('crosses projects (mini-dsh -> other-project)')
    } finally {
      db.close()
    }
  })

  it('flags projection drift and unreadable timelines instead of throwing', async () => {
    const drift = await goldenLedger()
    try {
      drift.prepare('UPDATE work_items SET status = ? WHERE stable_key = ?').run('IN_PROGRESS', 'DB-001')
      drift.prepare('UPDATE acceptance_criteria SET status = ? WHERE id = ?')
        .run('FAILING', 'ac:wi:mini-dsh:DB-001:AC-DB-001')
      const issues = planDoctor(drift, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'wi:mini-dsh:DB-001',
          message: 'work item "wi:mini-dsh:DB-001" has materialized status IN_PROGRESS but replays to BLOCKED',
        },
        {
          code: 'projection-drift',
          refId: 'ac:wi:mini-dsh:DB-001:AC-DB-001',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-DB-001" has materialized status FAILING but replays to PENDING',
        },
      ])
    } finally {
      drift.close()
    }

    const unreadable = await goldenLedger()
    try {
      unreadable.prepare("UPDATE project_events SET payload_json = '{' WHERE sequence_no = 3")
        .run()
      const issues = planDoctor(unreadable, GOLDEN_VERSION).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]?.code).toBe('event-timeline-unreadable')
      expect(issues[0]?.message).toContain('the project event timeline cannot be decoded by event format 6')
    } finally {
      unreadable.close()
    }

    const decisionDrift = await goldenLedger()
    try {
      const resolved = openDecisionRequest(decisionDrift, brandString<ProjectId>('mini-dsh'), {
        decisionKey: 'resolved', title: 'Resolved', question: 'Q?', blockingLevel: 'BLOCKING',
        options: [{ optionKey: 'go', label: 'Go' }],
      }, { nowMs: 40, actorRef: 'doctor/agent' })
      recordDecision(decisionDrift, resolved.requestId, {
        decidedBy: 'owner', selectedOptionKey: 'go', decisionText: 'go',
      }, { nowMs: 41, actorRef: 'doctor/agent' })
      const open = openDecisionRequest(decisionDrift, brandString<ProjectId>('mini-dsh'), {
        decisionKey: 'open', title: 'Open', question: 'Q?', blockingLevel: 'ADVISORY',
      }, { nowMs: 42, actorRef: 'doctor/agent' })
      decisionDrift.prepare("UPDATE decision_requests SET status = 'OPEN' WHERE id = ?").run(resolved.requestId)
      decisionDrift.prepare(
        'INSERT INTO decision_requests '
        + '(id, project_id, plan_version_id, decision_key, title, question, blocking_level, status, created_at_ms) '
        + "VALUES ('dr:mini-dsh:hand', 'mini-dsh', NULL, 'hand', 'Hand row', 'Q?', 'ADVISORY', 'OPEN', 43)",
      ).run()
      decisionDrift.prepare(
        'INSERT INTO decisions '
        + '(id, decision_request_id, decided_by, selected_option_id, decision_text, decided_at_ms) '
        + "VALUES ('dc:dr:mini-dsh:open:hand', ?, 'owner', NULL, 'decided out of band', 44)",
      ).run(open.requestId)
      decisionDrift.prepare("UPDATE decisions SET decided_by = 'impostor' WHERE decision_request_id = ?").run(resolved.requestId)
      const resolvedDecisionId = (decisionDrift.prepare('SELECT id FROM decisions WHERE decision_request_id = ?')
        .get(resolved.requestId) as { id: string }).id
      const issues = planDoctor(decisionDrift, GOLDEN_VERSION, { nowMs: 45 }).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'dr:mini-dsh:hand',
          message: 'decision request "dr:mini-dsh:hand" has materialized status OPEN but no replayed decision/requested event',
        },
        {
          code: 'projection-drift',
          refId: resolved.requestId,
          message: `decision request "${resolved.requestId}" has materialized status OPEN but replays to RESOLVED`,
        },
        {
          code: 'projection-drift',
          refId: 'dc:dr:mini-dsh:open:hand',
          message: `decision "dc:dr:mini-dsh:open:hand" is materialized for "${open.requestId}" but no replayed decision/recorded event`,
        },
        {
          code: 'projection-drift',
          refId: resolvedDecisionId,
          message: `decision "${resolvedDecisionId}" materializes for "dr:mini-dsh:resolved" by impostor `
            + 'but replays for "dr:mini-dsh:resolved" by owner',
        },
      ])
    } finally {
      decisionDrift.close()
    }

    const approvalDrift = await goldenLedger()
    try {
      const approved = requestApproval(approvalDrift, brandString<ProjectId>('mini-dsh'), {
        subjectType: 'plan-version', subjectId: 'plv:mini-dsh-v1.6a-ledger:v1', requestedBy: 'doctor/agent',
      }, { nowMs: 40, actorRef: 'doctor/agent' })
      decideApproval(approvalDrift, approved.approvalId, {
        outcome: 'APPROVED', decidedBy: 'owner', decisionText: 'approved',
      }, { nowMs: 41, actorRef: 'doctor/agent' })
      // The CHECKs couple the deciding columns to the non-PENDING status, so
      // tampering moves each column set whole.
      const wiped = requestApproval(approvalDrift, brandString<ProjectId>('mini-dsh'), {
        subjectType: 'work-item', subjectId: 'wi:mini-dsh:SCHEMA-001',
      }, { nowMs: 42, actorRef: 'doctor/agent' })
      decideApproval(approvalDrift, wiped.approvalId, {
        outcome: 'REJECTED', decidedBy: 'owner', decisionText: 'wiped after the fact',
      }, { nowMs: 43, actorRef: 'doctor/agent' })
      approvalDrift.prepare(
        "UPDATE approvals SET status = 'PENDING', decision_text = NULL, decided_by = NULL, decided_at_ms = NULL WHERE id = ?",
      ).run(wiped.approvalId)
      const promoted = requestApproval(approvalDrift, brandString<ProjectId>('mini-dsh'), {
        subjectType: 'work-item', subjectId: 'wi:mini-dsh:SCHEMA-001',
      }, { nowMs: 44, actorRef: 'doctor/agent' })
      approvalDrift.prepare(
        "UPDATE approvals SET status = 'APPROVED', decision_text = 'decided out of band', decided_by = 'owner', decided_at_ms = 5 WHERE id = ?",
      ).run(promoted.approvalId)
      const retargeted = requestApproval(approvalDrift, brandString<ProjectId>('mini-dsh'), {
        subjectType: 'plan-version', subjectId: 'plv:mini-dsh-v1.6a-ledger:v1',
      }, { nowMs: 45, actorRef: 'doctor/agent' })
      approvalDrift.prepare("UPDATE approvals SET subject_type = 'work-item' WHERE id = ?").run(retargeted.approvalId)
      approvalDrift.prepare(
        'INSERT INTO approvals '
        + '(id, project_id, subject_type, subject_id, required_role, requested_by, status, requested_at_ms) '
        + "VALUES ('ap:mini-dsh:hand', 'mini-dsh', 'plan-version', 'plv:mini-dsh-v1.6a-ledger:v1', NULL, 'owner', 'PENDING', 46)",
      ).run()
      approvalDrift.prepare("UPDATE approvals SET decided_by = 'impostor' WHERE id = ?").run(approved.approvalId)
      const issues = planDoctor(approvalDrift, GOLDEN_VERSION, { nowMs: 47 }).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: approved.approvalId,
          message: `approval "${approved.approvalId}" materializes decided by impostor but replays decided by owner`,
        },
        {
          code: 'projection-drift',
          refId: wiped.approvalId,
          message: `approval "${wiped.approvalId}" has materialized status PENDING but replays to REJECTED`,
        },
        {
          code: 'projection-drift',
          refId: wiped.approvalId,
          message: `approval "${wiped.approvalId}" materializes decided by nobody but replays decided by owner`,
        },
        {
          code: 'projection-drift',
          refId: promoted.approvalId,
          message: `approval "${promoted.approvalId}" has materialized status APPROVED but replays to PENDING`,
        },
        {
          code: 'projection-drift',
          refId: promoted.approvalId,
          message: `approval "${promoted.approvalId}" materializes decided by owner but replays decided by nobody`,
        },
        {
          code: 'projection-drift',
          refId: retargeted.approvalId,
          message: `approval "${retargeted.approvalId}" materializes over work-item "plv:mini-dsh-v1.6a-ledger:v1" `
            + 'but replays over plan-version "plv:mini-dsh-v1.6a-ledger:v1"',
        },
        {
          code: 'projection-drift',
          refId: 'ap:mini-dsh:hand',
          message: 'approval "ap:mini-dsh:hand" has materialized status PENDING but no replayed approval/requested event',
        },
      ])
    } finally {
      approvalDrift.close()
    }

    const resourceDrift = await goldenLedger()
    try {
      const requirement = openResourceRequirement(resourceDrift, brandString<ProjectId>('mini-dsh'), {
        requirementKey: 'parity', requirementKind: 'ENVIRONMENT', name: 'Parity', constraintsJson: '{}',
      }, { nowMs: 40, actorRef: 'doctor/agent' })
      const instance = provideResourceInstance(resourceDrift, {
        requirementId: requirement.requirementId, label: 'inst',
      }, { nowMs: 41, actorRef: 'doctor/agent' })
      const verification = verifyResourceInstance(resourceDrift, instance.instanceId, {
        verifierKind: 'TEST', verificationSpec: 'x', result: 'PASS',
      }, { nowMs: 42, actorRef: 'doctor/agent' })
      resourceDrift.prepare('UPDATE resource_requirements SET name = ?, status = ? WHERE id = ?')
        .run('Tampered', 'CANCELLED', requirement.requirementId)
      resourceDrift.prepare(
        'INSERT INTO resource_requirements '
        + '(id, project_id, plan_version_id, requirement_key, requirement_kind, name, constraints_json, status, created_at_ms) '
        + "VALUES ('rr:mini-dsh:hand', 'mini-dsh', NULL, 'hand', 'K', 'Hand row', '{}', 'OPEN', 43)",
      ).run()
      resourceDrift.prepare("UPDATE resource_verifications SET result = 'FAIL' WHERE id = ?")
        .run(verification.verificationId)
      resourceDrift.prepare(
        'INSERT INTO resource_instances '
        + '(id, requirement_id, provider, label, metadata_json, status, provided_at_ms) '
        + "VALUES ('ri:mini-dsh:hand', 'rr:mini-dsh:hand', NULL, 'Hand instance', NULL, 'AVAILABLE', 44)",
      ).run()
      resourceDrift.prepare("UPDATE resource_instances SET requirement_id = 'rr:mini-dsh:hand', status = 'RETIRED' WHERE id = ?")
        .run(instance.instanceId)
      resourceDrift.prepare(
        'INSERT INTO resource_verifications '
        + '(id, resource_instance_id, verifier, verifier_kind, verification_spec, observed_json, result, verified_at_ms) '
        + "VALUES ('rv:mini-dsh:hand', 'ri:mini-dsh:hand', NULL, 'TEST', 'spec', NULL, 'PASS', 45)",
      ).run()
      const issues = planDoctor(resourceDrift, GOLDEN_VERSION, { nowMs: 46 }).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'rr:mini-dsh:hand',
          message: 'resource requirement "rr:mini-dsh:hand" has materialized status OPEN but no replayed resource/required event',
        },
        {
          code: 'projection-drift',
          refId: requirement.requirementId,
          message: `resource requirement "${requirement.requirementId}" materializes as ENVIRONMENT "parity" (Tampered) `
            + 'but replays as ENVIRONMENT "parity" (Parity)',
        },
        {
          code: 'projection-drift',
          refId: requirement.requirementId,
          message: `resource requirement "${requirement.requirementId}" has materialized status CANCELLED but replays to OPEN`,
        },
        {
          code: 'projection-drift',
          refId: instance.instanceId,
          message: `resource instance "${instance.instanceId}" materializes for "rr:mini-dsh:hand" `
            + `but replays for "${requirement.requirementId}"`,
        },
        {
          code: 'projection-drift',
          refId: instance.instanceId,
          message: `resource instance "${instance.instanceId}" has materialized status RETIRED but replays to AVAILABLE`,
        },
        {
          code: 'projection-drift',
          refId: 'ri:mini-dsh:hand',
          message: 'resource instance "ri:mini-dsh:hand" has materialized status AVAILABLE but no replayed resource/provided event',
        },
        {
          code: 'projection-drift',
          refId: 'rv:mini-dsh:hand',
          message: 'resource verification "rv:mini-dsh:hand" has materialized result PASS but no replayed resource/verified event',
        },
        {
          code: 'projection-drift',
          refId: verification.verificationId,
          message: `resource verification "${verification.verificationId}" materializes FAIL for "${instance.instanceId}" `
            + `but replays PASS for "${instance.instanceId}"`,
        },
      ])
    } finally {
      resourceDrift.close()
    }

    const actorDrift = await goldenLedger()
    try {
      const owner = registerActor(actorDrift, brandString<ProjectId>('mini-dsh'), {
        actorKey: 'owner', actorKind: 'HUMAN', displayName: 'Owner',
      }, { nowMs: 40, actorRef: 'doctor/agent' })
      const role = defineRole(actorDrift, brandString<ProjectId>('mini-dsh'), {
        roleName: 'owner', roleKind: 'GOVERNANCE',
      }, { nowMs: 41, actorRef: 'doctor/agent' })
      assignRole(actorDrift, { actorId: owner.actorId, roleId: role.roleId }, { nowMs: 42, actorRef: 'doctor/agent' })
      actorDrift.prepare('UPDATE actors SET display_name = ?, status = ? WHERE id = ?')
        .run('Tampered', 'INACTIVE', owner.actorId)
      actorDrift.prepare(
        'INSERT INTO actors '
        + '(id, project_id, actor_key, actor_kind, display_name, external_identity, metadata_json, status, created_at_ms) '
        + "VALUES ('actor:mini-dsh:hand', 'mini-dsh', 'hand', 'SERVICE', 'Hand row', NULL, NULL, 'ACTIVE', 43)",
      ).run()
      actorDrift.prepare('UPDATE roles SET role_kind = ? WHERE id = ?').run('EXECUTION', role.roleId)
      actorDrift.prepare(
        'INSERT INTO roles (id, project_id, role_name, role_kind, description, created_at_ms) '
        + "VALUES ('role:mini-dsh:hand', 'mini-dsh', 'hand', 'GOVERNANCE', NULL, 44)",
      ).run()
      actorDrift.prepare(
        'INSERT INTO actor_roles (id, actor_id, role_id, valid_from_ms, valid_to_ms) '
        + "VALUES ('asg:mini-dsh:hand', 'actor:mini-dsh:hand', 'role:mini-dsh:hand', 45, NULL)",
      ).run()
      actorDrift.prepare('UPDATE actor_roles SET role_id = ? WHERE actor_id = ?').run('role:mini-dsh:hand', owner.actorId)
      actorDrift.prepare('UPDATE actor_roles SET valid_to_ms = 5 WHERE actor_id = ?').run(owner.actorId)
      const issues = planDoctor(actorDrift, GOLDEN_VERSION, { nowMs: 46 }).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'actor:mini-dsh:hand',
          message: 'actor "actor:mini-dsh:hand" has materialized status ACTIVE but no replayed actor/registered event',
        },
        {
          code: 'projection-drift',
          refId: owner.actorId,
          message: `actor "${owner.actorId}" materializes as HUMAN "owner" (Tampered) but replays as HUMAN "owner" (Owner)`,
        },
        {
          code: 'projection-drift',
          refId: owner.actorId,
          message: `actor "${owner.actorId}" has materialized status INACTIVE but replays to ACTIVE`,
        },
        {
          code: 'projection-drift',
          refId: 'role:mini-dsh:hand',
          message: 'role "role:mini-dsh:hand" materializes GOVERNANCE "hand" but no replayed role/defined event',
        },
        {
          code: 'projection-drift',
          refId: role.roleId,
          message: `role "${role.roleId}" materializes as EXECUTION "owner" but replays as GOVERNANCE "owner"`,
        },
        {
          code: 'projection-drift',
          refId: 'asg:mini-dsh:19',
          message: 'actor role "asg:mini-dsh:19" materializes actor "actor:mini-dsh:owner" over role "role:mini-dsh:hand" '
            + `but replays actor "actor:mini-dsh:owner" over role "${role.roleId}"`,
        },
        {
          code: 'projection-drift',
          refId: 'asg:mini-dsh:19',
          message: 'actor role "asg:mini-dsh:19" materializes valid until 5 but replays valid until now',
        },
        {
          code: 'projection-drift',
          refId: 'asg:mini-dsh:hand',
          message: 'actor role "asg:mini-dsh:hand" is materialized but no replayed role/assigned event',
        },
      ])
    } finally {
      actorDrift.close()
    }

    const workAssignmentDrift = await goldenLedger()
    try {
      const actor = registerActor(workAssignmentDrift, brandString<ProjectId>('mini-dsh'), {
        actorKey: 'lane', actorKind: 'AGENT', displayName: 'Lane',
      }, { nowMs: 40, actorRef: 'doctor/agent' })
      const reviewerRole = defineRole(workAssignmentDrift, brandString<ProjectId>('mini-dsh'), {
        roleName: 'reviewer', roleKind: 'GOVERNANCE',
      }, { nowMs: 41, actorRef: 'doctor/agent' })
      const assignment = assignWorkItem(workAssignmentDrift, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:DB-001'),
        actorId: actor.actorId,
        assignmentKind: 'PRIMARY',
        roleId: reviewerRole.roleId,
      }, { nowMs: 42, actorRef: 'doctor/agent' })
      const handActor = registerActor(workAssignmentDrift, brandString<ProjectId>('mini-dsh'), {
        actorKey: 'hand', actorKind: 'SERVICE', displayName: 'Hand row',
      }, { nowMs: 43, actorRef: 'doctor/agent' })
      const secondAssignment = assignWorkItem(workAssignmentDrift, {
        workItemId: brandString<WorkItemId>('wi:mini-dsh:DB-001'),
        actorId: actor.actorId,
        assignmentKind: 'COLLABORATOR',
      }, { nowMs: 44, actorRef: 'doctor/agent' })
      workAssignmentDrift.prepare('UPDATE work_assignments SET actor_id = ?, assignment_kind = ?, role_id = NULL, status = ? WHERE id = ?')
        .run(handActor.actorId, 'TESTER', 'ENDED', assignment.assignmentId)
      workAssignmentDrift.prepare('UPDATE work_assignments SET role_id = ? WHERE id = ?')
        .run(reviewerRole.roleId, secondAssignment.assignmentId)
      workAssignmentDrift.prepare(
        'INSERT INTO work_assignments '
        + '(id, work_item_id, actor_id, role_id, assignment_kind, status, assigned_at_ms) '
        + "VALUES ('wa:mini-dsh:hand', 'wi:mini-dsh:DB-001', ?, NULL, 'OBSERVER', 'ACTIVE', 45)",
      ).run(handActor.actorId)
      const issues = planDoctor(workAssignmentDrift, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: assignment.assignmentId,
          message: `work assignment "${assignment.assignmentId}" materializes actor "actor:mini-dsh:hand" over item "wi:mini-dsh:DB-001" `
            + `but replays actor "${actor.actorId}" over item "wi:mini-dsh:DB-001"`,
        },
        {
          code: 'projection-drift',
          refId: assignment.assignmentId,
          message: `work assignment "${assignment.assignmentId}" materializes with role none `
            + `but replays with role "${reviewerRole.roleId}"`,
        },
        {
          code: 'projection-drift',
          refId: assignment.assignmentId,
          message: `work assignment "${assignment.assignmentId}" materializes TESTER but replays PRIMARY`,
        },
        {
          code: 'projection-drift',
          refId: assignment.assignmentId,
          message: `work assignment "${assignment.assignmentId}" has materialized status ENDED but replays to ACTIVE`,
        },
        {
          code: 'projection-drift',
          refId: secondAssignment.assignmentId,
          message: `work assignment "${secondAssignment.assignmentId}" materializes with role "${reviewerRole.roleId}" `
            + 'but replays with role none',
        },
        {
          code: 'projection-drift',
          refId: 'wa:mini-dsh:hand',
          message: 'work assignment "wa:mini-dsh:hand" is materialized but no replayed work/assigned event',
        },
      ])
    } finally {
      workAssignmentDrift.close()
    }

    const rawCriterion = await goldenLedger()
    try {
      rawCriterion.prepare(
        'INSERT INTO acceptance_criteria (id, work_item_id, ordinal, criterion_kind, description, required, status) '
        + "VALUES ('ac:wi:mini-dsh:DB-001:AC-RAW', 'wi:mini-dsh:DB-001', 9, 'TEST', 'Raw criterion', 1, 'PENDING')",
      ).run()
      const issues = planDoctor(rawCriterion, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'criterion-without-verifier',
          refId: 'ac:wi:mini-dsh:DB-001:AC-RAW',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-RAW" records no verification spec; its outcome would be unverifiable',
        },
        {
          code: 'projection-drift',
          refId: 'ac:wi:mini-dsh:DB-001:AC-RAW',
          message: 'acceptance criterion "ac:wi:mini-dsh:DB-001:AC-RAW" has materialized status PENDING but no replayed status',
        },
      ])
    } finally {
      rawCriterion.close()
    }

    const revoked = await goldenLedger()
    try {
      revoked.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
      revoked.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W01')
      revoked.prepare('UPDATE work_items SET status = ? WHERE stable_key IN (?, ?)').run('DONE', 'OWNER-REVIEW-001', 'PRE-001')
      const claim = claimWorkItem(revoked, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'doctor/agent', { nowMs: 40 })
      revoked.prepare("UPDATE work_leases SET status = 'REVOKED' WHERE work_item_id = 'wi:mini-dsh:SCHEMA-001'").run()
      // The pinned clock keeps this scenario about the revoked row: the claim
      // expired in 1970, so the default wall clock would also flag it stale.
      const issues = planDoctor(revoked, GOLDEN_VERSION, { nowMs: 41 }).issues
      expect(issues.filter(issue => issue.code === 'projection-drift').map(issue => issue.message)).toContain(
        `work lease "${claim.leaseId}" has materialized status REVOKED but replays to ACTIVE`,
      )
      // The raw seam also moved the two DONE items without events; those
      // drifts are the seam's, and the lease mismatch is still found.
      expect(issues).toHaveLength(3)
    } finally {
      revoked.close()
    }

    const leaseless = await goldenLedger()
    try {
      leaseless.prepare(
        'INSERT INTO work_leases (id, work_item_id, worker_identity, lease_token_hash, status, '
        + 'acquired_at_ms, heartbeat_at_ms, expires_at_ms) '
        + "VALUES ('ls:orphan:1', 'wi:mini-dsh:SCHEMA-001', 'ghost', 'hash', 'ACTIVE', 5, 5, 9999999999999)",
      ).run()
      const issues = planDoctor(leaseless, GOLDEN_VERSION).issues
      expect(issues).toEqual([
        {
          code: 'projection-drift',
          refId: 'ls:orphan:1',
          message: 'work lease "ls:orphan:1" has materialized status ACTIVE but no replayed claim event',
        },
      ])
    } finally {
      leaseless.close()
    }
  })
})
