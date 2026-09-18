/** The /project command surface: todo views, doctor passes, and their resolution over the mounted ledger. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import {
  claimWorkItem,
  compilePlan,
  importPlanVersion,
  parsePlanDocument,
  validatePlanSchema,
  type WorkItemId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import * as miniProjectCommands from '../src/commands.ts'
import MiniProjectLedger from '../src/index.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/**
 * A second project whose owner work carries a blocking relation and whose
 * one agent item is claimable, so the command's rendering covers blocked
 * readiness and live leases through real writers.
 */
const TINY_PLAN_TEXT = `schemaVersion: 1
project:
  id: tiny-proj
  name: Tiny Proof
plan:
  id: tiny-plan
  name: Tiny Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: OWNER-A
    phaseId: P0
    type: REVIEW
    executorKind: OWNER
    title: Review the first thing
    priority: 50
    status: READY
    acceptance:
      - id: AC-OWNER-A
        kind: OWNER_CONFIRMATION
        description: Owner accepts the first thing.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm the first thing.
  - id: OWNER-B
    phaseId: P0
    type: REVIEW
    executorKind: OWNER
    title: Review the second thing
    priority: 40
    status: READY
    acceptance:
      - id: AC-OWNER-B
        kind: OWNER_CONFIRMATION
        description: Owner accepts the second thing.
        required: true
        verifier:
          kind: OWNER_CONFIRMATION
          instruction: Confirm the second thing.
  - id: AGENT-FREE
    phaseId: P0
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the free work
    priority: 30
    status: READY
    acceptance:
      - id: AC-AGENT-FREE
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations:
  - from: OWNER-A
    to: OWNER-B
    kind: BLOCKS
`

/** A single-project plan with only unphased agent work, covering the empty owner view and phase-less rendering. */
const SOLO_PLAN_TEXT = `schemaVersion: 1
project:
  id: solo-proj
  name: Solo Proof
plan:
  id: solo-plan
  name: Solo Proof Plan
  version: 1
phases:
  - id: P0
    title: One phase
    ordinal: 0
    status: ACTIVE
workItems:
  - id: AGENT-ONLY
    type: IMPLEMENTATION
    executorKind: AGENT
    title: Do the solo work
    priority: 20
    status: READY
    acceptance:
      - id: AC-AGENT-ONLY
        kind: TEST
        description: It works.
        required: true
        verifier:
          kind: TEST
          command: pnpm test
          expectedExitCode: 0
          sandboxRequired: true
          approvalRequired: false
relations: []
`

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

/** Parse, validate, and compile a plan document. */
function compilePlanText(text: string): ReturnType<typeof compilePlan> {
  const { value } = parsePlanDocument(text)
  return compilePlan(validatePlanSchema(value), { sourceText: text })
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
        text: expect.stringMatching(/\/project todo \[--agent\] \[<project-id>\][\s\S]*\/project doctor \[<plan-version-id>\]/) as string,
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
      const { planVersionId } = importPlanVersion(db, compilePlanText(TINY_PLAN_TEXT))
      // Activation is an owner seam without an exported writer (v1.6a §5);
      // the claim below requires an ACTIVE version, so the test activates
      // the tiny plan the same way the pinned-fixture generator does.
      db.prepare("UPDATE plan_versions SET status = 'ACTIVE', activated_at_ms = ? WHERE id = ?").run(1_000, planVersionId)
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
