/** The /project command surface: todo views, doctor passes, and their resolution over the mounted ledger. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import {
  claimWorkItem,
  decideApproval,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  openDecisionRequest,
  recordDecision,
  requestApproval,
  openResourceRequirement,
  provideResourceInstance,
  verifyResourceInstance,
  type AcceptanceCriterionId,
  type DecisionRequestId,
  type ProjectId,
  type WorkItemId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import { DUAL_PLAN_TEXT, GOLDEN_PLAN_TEXT, SOLO_PLAN_TEXT, TINY_PLAN_TEXT, compilePlanText, seedActivePlan } from './plans.ts'
import * as miniProjectCommands from '../src/commands.ts'
import MiniProjectLedger from '../src/index.ts'

/** One mounted profile under test. */
interface Mounted {
  readonly ctx: Context
  readonly agent: Agent
  readonly root: string
}

/** Mount the command registry, the ledger, and the /project surface over one temporary database. */
async function mount(seed?: (db: DatabaseSync) => void): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mini-cmd-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(MiniProjectLedger, { ledgerPath: join(root, 'ledger.sqlite') })
  if (seed !== undefined) seed(ctx.projectLedger.db)
  await ctx.plugin(miniProjectCommands)
  const session = ctx.sessions.create(SessionId('spec'))
  const agent = { id: session.id, session } as Agent
  return { ctx, agent, root }
}

/** Dispose a mount and remove its temporary database. */
async function unmount(mounted: Mounted): Promise<void> {
  await mounted.ctx.fiber.dispose()
  rmSync(mounted.root, { recursive: true, force: true })
}

/** Execute one /project line and return the settled result. */
async function run(mounted: Mounted, line: string): Promise<CommandResult> {
  const execution = await mounted.ctx.commands.execute(mounted.agent, line, [], new AbortController().signal)
  expect(execution).toBeDefined()
  return execution!.result
}

describe('/project', () => {
  it('answers bare /project with usage', async () => {
    const mounted = await mount()
    try {
      await expect(run(mounted, '/project')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringMatching(
          /todo \[--agent\][\s\S]*doctor[\s\S]*item[\s\S]*history[\s\S]*replay[\s\S]*digest[\s\S]*export[\s\S]*resources/u,
        ) as string,
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('rejects unknown input and overflowing arguments', async () => {
    const mounted = await mount()
    try {
      const usage = { kind: 'error', text: 'Unknown /project input. Run /project for usage.' }
      await expect(run(mounted, '/project bogus')).resolves.toEqual(usage)
      await expect(run(mounted, '/project todo a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project todo --agent a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project doctor a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project item')).resolves.toEqual(usage)
      await expect(run(mounted, '/project item a b c')).resolves.toEqual(usage)
      await expect(run(mounted, '/project history')).resolves.toEqual(usage)
      await expect(run(mounted, '/project history a b c')).resolves.toEqual(usage)
      await expect(run(mounted, '/project replay a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project digest a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project export a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project decisions a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project approvals a b')).resolves.toEqual(usage)
      await expect(run(mounted, '/project resources a b')).resolves.toEqual(usage)
    } finally {
      await unmount(mounted)
    }
  })

  it('fails every resolution over an empty ledger', async () => {
    const mounted = await mount()
    try {
      const empty = { kind: 'error', text: 'This ledger records no plan yet. Import a plan version first.' }
      await expect(run(mounted, '/project todo')).resolves.toEqual(empty)
      await expect(run(mounted, '/project doctor')).resolves.toEqual(empty)
      await expect(run(mounted, '/project item AGENT-FREE')).resolves.toEqual(empty)
      await expect(run(mounted, '/project history AGENT-FREE')).resolves.toEqual(empty)
      await expect(run(mounted, '/project replay')).resolves.toEqual(empty)
      await expect(run(mounted, '/project digest')).resolves.toEqual(empty)
      await expect(run(mounted, '/project export')).resolves.toEqual(empty)
      await expect(run(mounted, '/project decisions')).resolves.toEqual(empty)
      await expect(run(mounted, '/project approvals')).resolves.toEqual(empty)
      await expect(run(mounted, '/project resources')).resolves.toEqual(empty)
    } finally {
      await unmount(mounted)
    }
  })

  it('keeps implicit resolution ambiguous only across distinct projects', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, SOLO_PLAN_TEXT)
      importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
    })
    try {
      const ambiguous = {
        kind: 'error',
        text: 'This ledger records more than one project. Name one: mini-dsh, solo-proj.',
      }
      await expect(run(mounted, '/project todo')).resolves.toEqual(ambiguous)
      await expect(run(mounted, '/project digest')).resolves.toEqual(ambiguous)
      await expect(run(mounted, '/project decisions')).resolves.toEqual(ambiguous)
      await expect(run(mounted, '/project approvals')).resolves.toEqual(ambiguous)
      await expect(run(mounted, '/project resources')).resolves.toEqual(ambiguous)
    } finally {
      await unmount(mounted)
    }
  })

  it('lists the single project through the owner and agent views', async () => {
    const mounted = await mount((db) => {
      importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
    })
    try {
      await expect(run(mounted, '/project todo')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Project mini-dsh — owner todo, ') as string,
      })
      await expect(run(mounted, '/project todo')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('wi:mini-dsh:') as string,
      })
      await expect(run(mounted, '/project todo')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('not ready:') as string,
      })
      await expect(run(mounted, '/project todo --agent')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Project mini-dsh — agent todo, ') as string,
      })
      await expect(run(mounted, '/project todo mini-dsh')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Project mini-dsh — owner todo, ') as string,
      })
      await expect(run(mounted, '/project todo no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('runs the doctor on the named-current version and on an explicit id', async () => {
    const mounted = await mount((db) => {
      const { planVersionId } = importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
      // Naming the current version is an owner seam without an exported
      // writer (v1.6a §5); the command test sets the pointer the same way
      // the pinned-fixture generator does.
      db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run(planVersionId, 'mini-dsh-v1.6a-ledger')
    })
    try {
      await expect(run(mounted, '/project doctor')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Plan mini-dsh-v1.6a-ledger v1 (') as string,
      })
      await expect(run(mounted, '/project doctor')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('No issues found.') as string,
      })
      await expect(run(mounted, '/project doctor plv:mini-dsh-v1.6a-ledger:v1')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('No issues found.') as string,
      })
      await expect(run(mounted, '/project doctor plv:no-such:v9')).resolves.toMatchObject({
        kind: 'error',
        text: expect.stringContaining('The plan doctor rejected the request:') as string,
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('reports doctor issues and the unnamed-current rejection', async () => {
    const unnamed = await mount((db) => {
      importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
    })
    try {
      await expect(run(unnamed, '/project doctor')).resolves.toEqual({
        kind: 'error',
        text: 'The plan names no current version yet. Pass a plan version id: /project doctor <plan-version-id>.',
      })
    } finally {
      await unmount(unnamed)
    }

    const drifted = await mount((db) => {
      const { planVersionId } = importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
      db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run(planVersionId, 'mini-dsh-v1.6a-ledger')
      // An out-of-band status write is projection drift by construction;
      // the doctor must surface it through the command.
      db.prepare("UPDATE work_items SET status = 'DONE' WHERE id = ?").run('wi:mini-dsh:PRE-002')
    })
    try {
      await expect(run(drifted, '/project doctor')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('- [projection-drift]') as string,
      })
    } finally {
      await unmount(drifted)
    }
  })

  it('renders blocked readiness, live leases, empty views, and phase-less items', async () => {
    const mounted = await mount((db) => {
      importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
      seedActivePlan(db, TINY_PLAN_TEXT)
      claimWorkItem(db, brandString<WorkItemId>('wi:tiny-proj:AGENT-FREE'), 'spec-worker')
    })
    try {
      await expect(run(mounted, '/project todo')).resolves.toEqual({
        kind: 'error',
        text: 'This ledger records more than one project. Name one: mini-dsh, tiny-proj.',
      })
      await expect(run(mounted, '/project doctor')).resolves.toEqual({
        kind: 'error',
        text: 'This ledger records more than one plan. Pass a plan version id: /project doctor <plan-version-id>.',
      })

      await expect(run(mounted, '/project todo tiny-proj')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('READY wi:tiny-proj:OWNER-A — Review the first thing (phase P0, priority 50)') as string,
      })
      await expect(run(mounted, '/project todo tiny-proj')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringMatching(/wi:tiny-proj:OWNER-B[\s\S]*not ready:/) as string,
      })
      await expect(run(mounted, '/project todo --owner tiny-proj')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('owner todo, 2 items:') as string,
      })
      await expect(run(mounted, '/project todo --agent tiny-proj')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('IN_PROGRESS wi:tiny-proj:AGENT-FREE — Do the free work (phase P0, priority 30)') as string,
      })
      await expect(run(mounted, '/project todo --agent tiny-proj')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringMatching(/  lease ls:wi:tiny-proj:AGENT-FREE:\d+ held by spec-worker, expires /) as string,
      })
      await expect(run(mounted, '/project todo --agent')).resolves.toMatchObject({
        kind: 'error',
        text: expect.stringContaining('more than one project') as string,
      })
      await expect(run(mounted, '/project todo --owner')).resolves.toMatchObject({
        kind: 'error',
        text: expect.stringContaining('more than one project') as string,
      })
    } finally {
      await unmount(mounted)
    }

    const solo = await mount((db) => {
      importPlanVersion(db, compilePlanText(SOLO_PLAN_TEXT))
    })
    try {
      await expect(run(solo, '/project todo')).resolves.toEqual({
        kind: 'success',
        text: 'No outstanding owner work in project solo-proj.',
      })
      await expect(run(solo, '/project todo --agent')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('READY wi:solo-proj:AGENT-ONLY — Do the solo work (phase none, priority 20)') as string,
      })
    } finally {
      await unmount(solo)
    }
  })

  it('reviews one item with its criteria, latest evaluations, and observed evidence', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE'),
        'PASS',
        { evaluatedBy: 'spec-worker', observed: { exitCode: 0, outputTail: 'Test Files\n4 passed\n' } },
      )
    })
    try {
      await expect(run(mounted, '/project item AGENT-FREE')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining(
          'Work item wi:tiny-proj:AGENT-FREE "Do the free work" — READY (agent, priority 30, version plv:tiny-plan:v1)',
        ) as string,
      })
      await expect(run(mounted, '/project item AGENT-FREE')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringMatching(
          /ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE \(TEST, required\) PASSING — PASS by spec-worker at .*; exit 0/,
        ) as string,
      })
      // The observed tail is quoted as one collapsed excerpt line.
      await expect(run(mounted, '/project item AGENT-FREE')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('  Test Files 4 passed') as string,
      })
      await expect(run(mounted, '/project item wi:tiny-proj:AGENT-FREE')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Work item wi:tiny-proj:AGENT-FREE') as string,
      })
      await expect(run(mounted, '/project item NO-SUCH')).resolves.toEqual({
        kind: 'error',
        text: 'No work item "NO-SUCH" in project tiny-proj. Name a stable key or full id.',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('marks unevaluated criteria and truncates long observed tails in the review', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, DUAL_PLAN_TEXT)
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:dual-proj:AGENT-DUAL:AC-DUAL-A'),
        'PASS',
        { evaluatedBy: 'spec-worker', observed: { exitCode: 0, outputTail: `${'x'.repeat(400)}END-OF-OUTPUT` } },
      )
      // A tail without an exit code: the verdict line carries no exit fact.
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:dual-proj:AGENT-DUAL:AC-DUAL-B'),
        'PASS',
        { evaluatedBy: 'spec-worker', observed: { outputTail: 'tail without exit code' } },
      )
    })
    try {
      const result = await run(mounted, '/project item AGENT-DUAL')
      expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('AGENT-DUAL') as string })
      if (result.kind !== 'success' || result.text === undefined) return
      expect(result.text).toContain('(OWNER_CONFIRMATION, required) PENDING — no evaluation yet')
      expect(result.text).toMatch(/AC-DUAL-A \(TEST, required\) PASSING — PASS by spec-worker at .*; exit 0/)
      const lines = result.text.split('\n')
      const dualB = lines.find(line => line.includes('AC-DUAL-B'))
      expect(dualB).toMatch(/\(TEST, required\) PASSING — PASS by spec-worker at [^;]*$/u)
      // One whitespace-collapsed excerpt line: two indent spaces, the first
      // 160 characters of the tail, and the truncation mark.
      const excerptLine = lines.find(line => line.startsWith('  '))
      expect(excerptLine).toMatch(/^ {2}x{160}…$/u)
    } finally {
      await unmount(mounted)
    }
  })

  it('reviews backlog work that carries no plan version', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
      // Backlog rows have no writer yet (import always versions its items);
      // the out-of-band insert mirrors the ledger readiness spec's fixture.
      db.prepare(
        'INSERT INTO work_items '
          + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
          + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
          + "VALUES ('wi:tiny-proj:BACKLOG-1', 'tiny-proj', NULL, NULL, NULL, 'BACKLOG-1', 'RESEARCH', 'AGENT', "
          + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
      ).run()
    })
    try {
      await expect(run(mounted, '/project item BACKLOG-1')).resolves.toMatchObject({
        kind: 'success',
        text: 'Work item wi:tiny-proj:BACKLOG-1 "Discovered work" — READY (agent, priority 0, version none)',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('renders optional criteria and evaluations without observed payloads', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, SOLO_PLAN_TEXT)
      // One evaluation stores no observed payload at all; the other stores
      // an exit code with no output tail.
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:solo-proj:AGENT-ONLY:AC-AGENT-ONLY'),
        'FAIL',
        { evaluatedBy: 'owner' },
      )
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:solo-proj:AGENT-ONLY:AC-AGENT-ONLY-OPT'),
        'PASS',
        { evaluatedBy: 'spec-worker', observed: { exitCode: 2 } },
      )
    })
    try {
      const result = await run(mounted, '/project item AGENT-ONLY')
      expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('AGENT-ONLY') as string })
      if (result.kind !== 'success' || result.text === undefined) return
      expect(result.text).toMatch(/AC-AGENT-ONLY \(TEST, required\) FAILING — FAIL by owner at [^;]*$/mu)
      expect(result.text).toMatch(/AC-AGENT-ONLY-OPT \(TEST, optional\) PASSING — PASS by spec-worker at .*; exit 2$/mu)
      // No evaluation stored an output tail, so no excerpt line exists.
      expect(result.text.split('\n').every(line => !line.startsWith('  '))).toBe(true)
    } finally {
      await unmount(mounted)
    }
  })

  it('audits replay parity for the resolved project', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
      claimWorkItem(db, brandString<WorkItemId>('wi:tiny-proj:AGENT-FREE'), 'spec-worker')
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE'),
        'PASS',
        { evaluatedBy: 'spec-worker' },
      )
    })
    try {
      const expected = [
        'Project tiny-proj — replay audit over 6 events, last sequence 6.',
        'Replayed: 1 plan versions, 3 work items, 3 criteria, 1 leases, 0 work packets.',
        'Materialized: 1 plan versions, 3 work items, 3 criteria, 1 leases.',
        'Replay matches every materialized row.',
      ].join('\n')
      await expect(run(mounted, '/project replay')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project replay tiny-proj')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project replay no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('reports replay drift and an undecodable timeline', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
      // An out-of-band status write is projection drift by construction; the
      // audit must surface it through the command.
      db.prepare("UPDATE work_items SET status = 'DONE' WHERE id = ?").run('wi:tiny-proj:OWNER-A')
    })
    try {
      await expect(run(mounted, '/project replay')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Drift (1):') as string,
      })
      await expect(run(mounted, '/project replay')).resolves.toMatchObject({
        kind: 'success',
        text: expect.stringContaining(
          'work item "wi:tiny-proj:OWNER-A" has materialized status DONE but replays to READY',
        ) as string,
      })
      // A row this build's event format cannot interpret fails the whole
      // fold; the audit reports why instead of comparing parity.
      mounted.ctx.projectLedger.db.prepare(
        'INSERT INTO project_events '
          + '(project_id, sequence_no, event_format_version, event_type, ignorable, payload_json, created_at_ms) '
          + "VALUES ('tiny-proj', 99, 5, 'plan/imported', 0, '{}', 1)",
      ).run()
      const result = await run(mounted, '/project replay')
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind !== 'success' || result.text === undefined) return
      expect(result.text).toContain('Project tiny-proj — replay audit over 5 events, last sequence 99.')
      expect(result.text).toContain('The timeline cannot be decoded by this build:')
      expect(result.text).not.toContain('Replay matches')
    } finally {
      await unmount(mounted)
    }
  })

  it('digests plan versions, item completion, and verdicts for the resolved project', async () => {
    const mounted = await mount()
    try {
      const db = mounted.ctx.projectLedger.db
      seedActivePlan(db, TINY_PLAN_TEXT)
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE'),
        'PASS',
        { evaluatedBy: 'spec-worker', nowMs: 60_000 },
      )
      // Naming the current version is an owner seam without an exported
      // writer (v1.6a §5); the retire and baseline writes are display facts
      // the replay never projects, set the way the doctor test sets its facts.
      db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run('plv:tiny-plan:v1', 'tiny-plan')
      db.prepare(
        "UPDATE plan_versions SET status = 'SUPERSEDED', superseded_at_ms = 61_000, baseline_repo_head = 'repo-head-v1' "
          + "WHERE id = 'plv:tiny-plan:v1'",
      ).run()
      const expected = [
        'Project tiny-proj — evidence digest.',
        'Plan Tiny Proof Plan (tiny-plan) — current version plv:tiny-plan:v1.',
        '  v1 SUPERSEDED — baseline repo-head-v1, superseded 1970-01-01T00:01:01.000Z',
        'Items (3):',
        '- AGENT-FREE (agent, priority 30) READY — criteria 1/1 passing, verdicts PASS 1; last evidence 1970-01-01T00:01:00.000Z',
        '- OWNER-A (owner, priority 50) READY — criteria 0/1 passing, verdicts none',
        '- OWNER-B (owner, priority 40) READY — criteria 0/1 passing, verdicts none',
        'Replay audit: clean over 5 events (last sequence 5).',
      ].join('\n')
      await expect(run(mounted, '/project digest')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project digest tiny-proj')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project digest no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('lists one item\'s full evaluation timeline newest-first', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE'),
        'FAIL',
        { evaluatedBy: 'spec-worker', nowMs: 60_000, observed: { exitCode: 1, outputTail: 'first attempt failed' } },
      )
      // A blocked attempt records no observed payload: no exit fact, no excerpt.
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE'),
        'BLOCKED',
        { evaluatedBy: 'owner', nowMs: 61_000 },
      )
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE'),
        'PASS',
        { evaluatedBy: 'spec-worker', nowMs: 62_000, observed: { exitCode: 0 } },
      )
    })
    try {
      const expected = [
        'Work item wi:tiny-proj:AGENT-FREE "Do the free work" — READY '
          + '(agent, priority 30, version plv:tiny-plan:v1)',
        'Evaluation history (3), newest first:',
        '- ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE (TEST) PASS by spec-worker at 1970-01-01T00:01:02.000Z; exit 0',
        '- ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE (TEST) BLOCKED by owner at 1970-01-01T00:01:01.000Z',
        '- ac:wi:tiny-proj:AGENT-FREE:AC-AGENT-FREE (TEST) FAIL by spec-worker at 1970-01-01T00:01:00.000Z; exit 1',
        '  first attempt failed',
      ].join('\n')
      await expect(run(mounted, '/project history AGENT-FREE')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project history wi:tiny-proj:AGENT-FREE')).resolves.toEqual({
        kind: 'success',
        text: expected,
      })
      // An item nothing evaluated yet reads as an empty timeline.
      await expect(run(mounted, '/project history OWNER-A')).resolves.toEqual({
        kind: 'success',
        text: [
          'Work item wi:tiny-proj:OWNER-A "Review the first thing" — READY '
            + '(owner, priority 50, version plv:tiny-plan:v1)',
          'No evaluations recorded yet.',
        ].join('\n'),
      })
      await expect(run(mounted, '/project history NO-SUCH')).resolves.toEqual({
        kind: 'error',
        text: 'No work item "NO-SUCH" in project tiny-proj. Name a stable key or full id.',
      })
      // A backlog row has no plan version and nothing evaluated; the history
      // reads it the same way. The out-of-band insert mirrors the ledger
      // specs' fixtures.
      mounted.ctx.projectLedger.db.prepare(
        'INSERT INTO work_items '
          + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
          + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
          + "VALUES ('wi:tiny-proj:BACKLOG-1', 'tiny-proj', NULL, NULL, NULL, 'BACKLOG-1', 'RESEARCH', 'AGENT', "
          + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
      ).run()
      await expect(run(mounted, '/project history BACKLOG-1')).resolves.toEqual({
        kind: 'success',
        text: [
          'Work item wi:tiny-proj:BACKLOG-1 "Discovered work" — READY (agent, priority 0, version none)',
          'No evaluations recorded yet.',
        ].join('\n'),
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('exports the evidence record as one archival markdown block', async () => {
    const mounted = await mount()
    try {
      const db = mounted.ctx.projectLedger.db
      seedActivePlan(db, SOLO_PLAN_TEXT)
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:solo-proj:AGENT-ONLY:AC-AGENT-ONLY'),
        'FAIL',
        { evaluatedBy: 'owner', nowMs: 60_000, observed: { exitCode: 1, outputTail: '1 test failed' } },
      )
      // The optional criterion passes with a tail but no exit code, so its
      // verdict line carries evidence and no exit fact.
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>('ac:wi:solo-proj:AGENT-ONLY:AC-AGENT-ONLY-OPT'),
        'PASS',
        { evaluatedBy: 'spec-worker', nowMs: 61_000, observed: { outputTail: 'optional tail passes' } },
      )
      // Naming the current version is an owner seam without an exported
      // writer (v1.6a §5); the retire and baseline writes are display facts
      // the replay never projects, set the way the digest test sets its facts.
      db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run('plv:solo-plan:v1', 'solo-plan')
      db.prepare(
        "UPDATE plan_versions SET status = 'SUPERSEDED', superseded_at_ms = 61_500, baseline_repo_head = 'repo-head-v1' "
          + "WHERE id = 'plv:solo-plan:v1'",
      ).run()
      const expected = [
        '# Project solo-proj — evidence export',
        '',
        '## Plans',
        '',
        '- **Solo Proof Plan** (`solo-plan`) — current version `plv:solo-plan:v1`',
        '  - v1 SUPERSEDED — baseline `repo-head-v1`, superseded 1970-01-01T00:01:01.500Z',
        '',
        '## Work items (1)',
        '',
        '### AGENT-ONLY — Do the solo work',
        '',
        '`READY` · agent · priority 20 · version `plv:solo-plan:v1` · criteria 1/2 passing · last evidence 1970-01-01T00:01:01.000Z',
        '- `ac:wi:solo-proj:AGENT-ONLY:AC-AGENT-ONLY` (TEST, required) FAILING — FAIL by owner at 1970-01-01T00:01:00.000Z; exit 1',
        '  - evidence: 1 test failed',
        '- `ac:wi:solo-proj:AGENT-ONLY:AC-AGENT-ONLY-OPT` (TEST, optional) PASSING — PASS by spec-worker at 1970-01-01T00:01:01.000Z',
        '  - evidence: optional tail passes',
        '',
        '## Replay audit',
        '',
        'clean over 4 events (last sequence 4).',
      ].join('\n')
      await expect(run(mounted, '/project export')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project export solo-proj')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project export no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })

      // A backlog row has no plan version and carries an unevaluated optional
      // criterion; the out-of-band inserts mirror the ledger specs' fixtures.
      db.prepare(
        'INSERT INTO work_items '
          + '(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, '
          + 'title, description, priority, status, lock_version, created_at_ms, updated_at_ms) '
          + "VALUES ('wi:solo-proj:BACKLOG-1', 'solo-proj', NULL, NULL, NULL, 'BACKLOG-1', 'RESEARCH', 'AGENT', "
          + "'Discovered work', NULL, 0, 'READY', 0, 1, 1)",
      ).run()
      db.prepare(
        'INSERT INTO acceptance_criteria (id, work_item_id, ordinal, criterion_kind, description, required, status) '
          + "VALUES ('ac:wi:solo-proj:BACKLOG-1:AC-BACKLOG', 'wi:solo-proj:BACKLOG-1', 0, 'TEST', "
          + "'Some discovered check.', 0, 'PENDING')",
      ).run()
      const backlogExport = await run(mounted, '/project export solo-proj')
      expect(backlogExport).toMatchObject({ kind: 'success' })
      if (backlogExport.kind !== 'success' || backlogExport.text === undefined) return
      expect(backlogExport.text).toContain('### BACKLOG-1 — Discovered work')
      expect(backlogExport.text).toMatch(/`READY` · agent · priority 0 · version `none` · criteria 0\/1 passing\b/u)
      expect(backlogExport.text).toContain(
        '- `ac:wi:solo-proj:BACKLOG-1:AC-BACKLOG` (TEST, optional) PENDING — no evaluation yet',
      )
    } finally {
      await unmount(mounted)
    }
  })

  it('lists decision requests with options and resolving decisions', async () => {
    const mounted = await mount()
    try {
      const db = mounted.ctx.projectLedger.db
      seedActivePlan(db, SOLO_PLAN_TEXT)
      await expect(run(mounted, '/project decisions')).resolves.toEqual({
        kind: 'success',
        text: 'No decision requests in project solo-proj.',
      })

      const request = openDecisionRequest(db, brandString<ProjectId>('solo-proj'), {
        decisionKey: 'entry',
        title: 'Enter the next stage',
        question: 'Is the evidence sufficient?',
        blockingLevel: 'BLOCKING',
        raisedBy: 'owner',
        options: [
          { optionKey: 'enter', label: 'Enter v1.6b', recommended: true },
          { optionKey: 'wait', label: 'Keep accumulating' },
        ],
      }, { nowMs: 62_000, actorRef: 'spec-owner' })
      openDecisionRequest(db, brandString<ProjectId>('solo-proj'), {
        decisionKey: 'open-question',
        title: 'Free-form question',
        question: 'Anything else?',
        blockingLevel: 'ADVISORY',
      }, { nowMs: 63_000, actorRef: 'spec-owner' })
      recordDecision(db, request.requestId, {
        decidedBy: 'owner',
        selectedOptionKey: 'enter',
        decisionText: 'Go.',
        rationale: 'evidence',
      }, { nowMs: 64_000, actorRef: 'spec-owner' })

      const expected = [
        'Project solo-proj — decision requests, 2:',
        '- open-question (ADVISORY) OPEN — Free-form question',
        '- entry (BLOCKING) RESOLVED — Enter the next stage',
        '  options: enter (Enter v1.6b, recommended), wait (Keep accumulating)',
        '  decided by owner at 1970-01-01T00:01:04.000Z: enter — Go. (rationale: evidence)',
      ].join('\n')
      await expect(run(mounted, '/project decisions')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project decisions solo-proj')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project decisions no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })

      // A free-text decision names no option and carries no rationale, so its
      // line renders the decision text alone.
      recordDecision(db, brandString<DecisionRequestId>('dr:solo-proj:open-question'), {
        decidedBy: 'owner',
        decisionText: 'Noted; nothing to choose.',
      }, { nowMs: 65_000, actorRef: 'spec-owner' })
      const freeText = [
        'Project solo-proj — decision requests, 2:',
        '- open-question (ADVISORY) RESOLVED — Free-form question',
        '  decided by owner at 1970-01-01T00:01:05.000Z: Noted; nothing to choose.',
        '- entry (BLOCKING) RESOLVED — Enter the next stage',
        '  options: enter (Enter v1.6b, recommended), wait (Keep accumulating)',
        '  decided by owner at 1970-01-01T00:01:04.000Z: enter — Go. (rationale: evidence)',
      ].join('\n')
      await expect(run(mounted, '/project decisions')).resolves.toEqual({ kind: 'success', text: freeText })
    } finally {
      await unmount(mounted)
    }
  })

  it('lists approvals over their typed subjects with the decisions that answered them', async () => {
    const mounted = await mount()
    try {
      const db = mounted.ctx.projectLedger.db
      seedActivePlan(db, SOLO_PLAN_TEXT)
      await expect(run(mounted, '/project approvals')).resolves.toEqual({
        kind: 'success',
        text: 'No approvals in project solo-proj.',
      })

      const decided = requestApproval(db, brandString<ProjectId>('solo-proj'), {
        subjectType: 'plan-version',
        subjectId: 'plv:solo-plan:v1',
        requiredRole: 'owner',
        requestedBy: 'owner',
      }, { nowMs: 70_000, actorRef: 'spec-owner' })
      decideApproval(db, decided.approvalId, {
        outcome: 'APPROVED',
        decidedBy: 'owner',
        decisionText: 'The solo plan runs.',
      }, { nowMs: 71_000, actorRef: 'spec-owner' })
      requestApproval(db, brandString<ProjectId>('solo-proj'), {
        subjectType: 'work-item',
        subjectId: 'wi:solo-proj:AGENT-ONLY',
      }, { nowMs: 72_000, actorRef: 'spec-owner' })

      const expected = [
        'Project solo-proj — approvals, 2:',
        '- work-item wi:solo-proj:AGENT-ONLY PENDING — requested by unknown at 1970-01-01T00:01:12.000Z',
        '- plan-version plv:solo-plan:v1 APPROVED (requires owner) — requested by owner at 1970-01-01T00:01:10.000Z',
        '  decided by owner at 1970-01-01T00:01:11.000Z: The solo plan runs.',
      ].join('\n')
      await expect(run(mounted, '/project approvals')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project approvals solo-proj')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project approvals no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('lists resource requirements with instances and verification verdicts', async () => {
    const mounted = await mount()
    try {
      const db = mounted.ctx.projectLedger.db
      seedActivePlan(db, SOLO_PLAN_TEXT)
      await expect(run(mounted, '/project resources')).resolves.toEqual({
        kind: 'success',
        text: 'No resource requirements in project solo-proj.',
      })

      const requirement = openResourceRequirement(db, brandString<ProjectId>('solo-proj'), {
        requirementKey: 'persistent-ledger',
        requirementKind: 'ENVIRONMENT',
        name: 'Persistent ledger file',
        constraintsJson: '{"journal":"wal"}',
        requestedFrom: 'owner',
      }, { nowMs: 80_000, actorRef: 'spec-owner' })
      const instance = provideResourceInstance(db, {
        requirementId: requirement.requirementId,
        label: 'ledger.sqlite',
        provider: 'host',
      }, { nowMs: 81_000, actorRef: 'spec-owner' })
      verifyResourceInstance(db, instance.instanceId, {
        verifierKind: 'TEST',
        verifier: 'lane',
        verificationSpec: 'replay audit reports zero drift',
        observedJson: '{"drift":0}',
        result: 'PASS',
      }, { nowMs: 82_000, actorRef: 'spec-owner' })

      // Absent optionals render as their bare fallbacks.
      const bare = openResourceRequirement(db, brandString<ProjectId>('solo-proj'), {
        requirementKey: 'bare',
        requirementKind: 'TOOL',
        name: 'Bare requirement',
        constraintsJson: '{}',
      }, { nowMs: 83_000, actorRef: 'spec-owner' })
      const bareInstance = provideResourceInstance(db, {
        requirementId: bare.requirementId,
        label: 'bare-instance',
      }, { nowMs: 84_000, actorRef: 'spec-owner' })
      verifyResourceInstance(db, bareInstance.instanceId, {
        verifierKind: 'COMMAND',
        verificationSpec: 'the command exits 0',
        result: 'FAIL',
      }, { nowMs: 85_000, actorRef: 'spec-owner' })

      const expected = [
        'Project solo-proj — resource requirements, 2:',
        '- bare (TOOL) OPEN — Bare requirement (requested from unknown)',
        '  constraints: {}',
        '  instance bare-instance AVAILABLE — provided by unknown',
        '    at 1970-01-01T00:01:24.000Z',
        '    verified FAIL (COMMAND) at 1970-01-01T00:01:25.000Z:',
        '- persistent-ledger (ENVIRONMENT) OPEN — Persistent ledger file (requested from owner)',
        '  constraints: {"journal":"wal"}',
        '  instance ledger.sqlite AVAILABLE — provided by host',
        '    at 1970-01-01T00:01:21.000Z',
        '    verified PASS (TEST) at 1970-01-01T00:01:22.000Z: observed {"drift":0}',
      ].join('\n')
      await expect(run(mounted, '/project resources')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project resources solo-proj')).resolves.toEqual({ kind: 'success', text: expected })
      await expect(run(mounted, '/project resources no-such-project')).resolves.toEqual({
        kind: 'error',
        text: 'No plan in this ledger records project "no-such-project".',
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('digests a versionless plan, drift findings, and an undecodable timeline', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
    })
    try {
      // A plans row without versions has no writer — import always lands a
      // version beside it; the out-of-band insert mirrors the ledger specs.
      mounted.ctx.projectLedger.db.prepare(
        'INSERT INTO plans (id, project_id, name, current_version_id, created_at_ms) '
          + "VALUES ('side-plan', 'tiny-proj', 'Side Plan', NULL, 1)",
      ).run()
      // Two plans of one project leave the implicit resolution unambiguous:
      // the resolver deduplicates plan ids into project ids and picks the one.
      const bare = await run(mounted, '/project digest')
      expect(bare).toMatchObject({ kind: 'success' })
      // The digest names the project the way the resolution seam requires when
      // a second project joins the ledger.
      const first = await run(mounted, '/project digest tiny-proj')
      expect(first).toMatchObject({ kind: 'success' })
      if (first.kind !== 'success' || first.text === undefined) return
      expect(first.text).toContain('Plan Side Plan (side-plan) — current version none.')
      expect(first.text).toContain('  No plan versions recorded.')

      // An out-of-band status write is projection drift by construction; the
      // digest carries both the DONE display fact and the audit finding.
      mounted.ctx.projectLedger.db.prepare("UPDATE work_items SET status = 'DONE' WHERE id = 'wi:tiny-proj:OWNER-A'").run()
      const drifted = await run(mounted, '/project digest tiny-proj')
      expect(drifted).toMatchObject({ kind: 'success' })
      if (drifted.kind !== 'success' || drifted.text === undefined) return
      expect(drifted.text).toContain('- OWNER-A (owner, priority 50) DONE — criteria 0/1 passing, verdicts none')
      expect(drifted.text).toContain('Replay audit: 1 drift finding over 4 events:')
      expect(drifted.text).toContain(
        'work item "wi:tiny-proj:OWNER-A" has materialized status DONE but replays to READY',
      )

      // A second out-of-band write makes the drift list plural.
      mounted.ctx.projectLedger.db.prepare(
        "UPDATE acceptance_criteria SET status = 'WAIVED' WHERE id = 'ac:wi:tiny-proj:OWNER-B:AC-OWNER-B'",
      ).run()
      const plural = await run(mounted, '/project digest tiny-proj')
      expect(plural).toMatchObject({ kind: 'success' })
      if (plural.kind !== 'success' || plural.text === undefined) return
      expect(plural.text).toContain('2 drift findings over 4 events:')

      // The export renders the drift state as markdown: the versionless plan
      // line, the per-finding drift list, and the DONE display fact.
      const driftedExport = await run(mounted, '/project export tiny-proj')
      expect(driftedExport).toMatchObject({ kind: 'success' })
      if (driftedExport.kind !== 'success' || driftedExport.text === undefined) return
      expect(driftedExport.text).toContain('- **Side Plan** (`side-plan`) — current version `none`')
      expect(driftedExport.text).toContain('  - (no plan versions recorded)')
      expect(driftedExport.text).toContain('## Replay audit')
      expect(driftedExport.text).toContain('2 drift findings over 4 events:')
      expect(driftedExport.text).toContain('has materialized status WAIVED but replays to PENDING')
      expect(driftedExport.text).toContain(
        'work item "wi:tiny-proj:OWNER-A" has materialized status DONE but replays to READY',
      )
      expect(driftedExport.text).not.toContain('Replay audit: clean')

      // A row this build's event format cannot interpret fails the whole
      // fold; the digest reports why instead of a parity verdict.
      mounted.ctx.projectLedger.db.prepare(
        'INSERT INTO project_events '
          + '(project_id, sequence_no, event_format_version, event_type, ignorable, payload_json, created_at_ms) '
          + "VALUES ('tiny-proj', 99, 5, 'plan/imported', 0, '{}', 1)",
      ).run()
      const broken = await run(mounted, '/project digest tiny-proj')
      expect(broken).toMatchObject({ kind: 'success' })
      if (broken.kind !== 'success' || broken.text === undefined) return
      expect(broken.text).toContain('Replay audit: the timeline cannot be decoded by this build — ')
      expect(broken.text).toContain('carries event format 5; this build reads up to format 4')
      expect(broken.text).not.toContain('Replay audit: clean')

      // The export's replay section reports the decode failure, not parity.
      const brokenExport = await run(mounted, '/project export tiny-proj')
      expect(brokenExport).toMatchObject({ kind: 'success' })
      if (brokenExport.kind !== 'success' || brokenExport.text === undefined) return
      expect(brokenExport.text).toContain('the timeline cannot be decoded by this build — ')
      expect(brokenExport.text).toContain('carries event format 5; this build reads up to format 4')
      expect(brokenExport.text).not.toContain('clean over')
    } finally {
      await unmount(mounted)
    }
  })

  it('logs the command lifecycle and rethrows non-domain failures', async () => {
    const mounted = await mount((db) => {
      importPlanVersion(db, compilePlanText(GOLDEN_PLAN_TEXT))
    })
    try {
      await run(mounted, '/project todo')
      const lifecycle = mounted.agent.session.snapshotEvents()
        .filter(event => event.type === 'command/run' || event.type === 'command/done')
      expect(lifecycle.map(event => event.type)).toEqual(['command/run', 'command/done'])

      // A closed handle fails outside the command's domain errors; the
      // handler must let the failure reach the executor, not mask it.
      mounted.ctx.projectLedger.db.close()
      const execution = mounted.ctx.commands.execute(mounted.agent, '/project todo', [], new AbortController().signal)
      await expect(execution).rejects.toThrow()
    } finally {
      await unmount(mounted)
    }
  })
})
