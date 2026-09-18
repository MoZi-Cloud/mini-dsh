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
  evaluateAcceptanceCriterion,
  importPlanVersion,
  type AcceptanceCriterionId,
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
          /\/project todo \[--agent\][\s\S]*doctor \[<plan-version-id>\][\s\S]*item <stable-key-or-id>[\s\S]*replay \[<project-id>\]/,
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
      await expect(run(mounted, '/project replay a b')).resolves.toEqual(usage)
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
      await expect(run(mounted, '/project replay')).resolves.toEqual(empty)
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
          + "VALUES ('tiny-proj', 99, 2, 'plan/imported', 0, '{}', 1)",
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
