/** The model-facing project-work tools: agent todo listing, claim with packet delivery, and the held-claim lifecycle. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import {
  changeWorkStatus,
  evaluateAcceptanceCriterion,
  type AcceptanceCriterionId,
  type WorkItemId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import { GATED_PLAN_TEXT, GOLDEN_PLAN_TEXT, SOLO_PLAN_TEXT, TINY_PLAN_TEXT, seedActivePlan } from './plans.ts'
import * as miniProjectWork from '../src/project-work.ts'
import type { Config as ProjectWorkConfig } from '../src/project-work.ts'
import MiniProjectLedger from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** One mounted profile under test. */
interface Mounted {
  readonly ctx: Context
  readonly root: string
}


/** Mount the system prompt, tool registry, the ledger, and the project-work tools over one temporary database. */
async function mount(seed?: (db: DatabaseSync) => void, config?: ProjectWorkConfig): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mini-work-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MiniProjectLedger, { ledgerPath: join(root, 'ledger.sqlite') })
  if (seed !== undefined) seed(ctx.projectLedger.db)
  await ctx.plugin(miniProjectWork, config)
  return { ctx, root }
}

/** Dispose a mount and remove its temporary database. */
async function unmount(mounted: Mounted): Promise<void> {
  await mounted.ctx.fiber.dispose()
  rmSync(mounted.root, { recursive: true, force: true })
}

/** A stand-in calling agent; the tools read only `id` for the worker identity. */
function agent(id: string): Agent {
  return { id } as Agent
}

let callCounter = 0

/** Invoke one registered project-work tool, optionally as a given agent. */
async function run(mounted: Mounted, name: string, args: unknown, over: { agent?: Agent } = {}) {
  return await mounted.ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...('agent' in over ? { agent: over.agent } : {}),
  })
}

/** The model-facing text of one tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The registered JSON Schema of one tool's parameters. */
interface ToolParameterSchema {
  properties?: Record<string, { type: string; enum?: string[] }>
  required?: string[]
}

/** The registered JSON Schema of one tool's parameters. */
function parameterSchema(mounted: Mounted, name: string): ToolParameterSchema {
  const schema = mounted.ctx.tools.schemas().find(entry => entry.name === name)
  if (schema === undefined) throw new Error(`${name} is not registered`)
  return schema.parameters
}

/** Assert one result is an error carrying the given text fragment. */
async function expectError(result: { isError: boolean; content: { type: string; text?: string }[] }, fragment: string): Promise<void> {
  expect(result.isError).toBe(true)
  expect(text(result)).toContain(fragment)
}

describe('project-work tools', () => {
  it('registers the three tools with closed parameter shapes', async () => {
    const mounted = await mount()
    try {
      const next = parameterSchema(mounted, 'project_work_next')
      expect(Object.keys(next.properties ?? {})).toEqual(['projectId'])
      expect((next.properties ?? {}).projectId?.type).toBe('string')
      expect(next.required ?? []).toEqual([])

      const claim = parameterSchema(mounted, 'project_work_claim')
      expect(Object.keys(claim.properties ?? {})).toEqual(['workItemId'])
      expect(claim.required).toEqual(['workItemId'])

      const update = parameterSchema(mounted, 'project_work_update')
      const updateProperties = update.properties ?? {}
      expect(Object.keys(updateProperties).sort()).toEqual(['action', 'exitCode', 'result'])
      expect(update.required).toEqual(['action'])
      expect(updateProperties.action?.enum).toEqual(['heartbeat', 'release', 'report'])
      expect(updateProperties.result?.enum).toEqual(['PASS', 'FAIL'])
      expect(updateProperties.exitCode?.type).toBe('integer')
    } finally {
      await unmount(mounted)
    }
  })

  it('presents pending calls as pure generic views over the args', async () => {
    const mounted = await mount()
    try {
      const next = mounted.ctx.tools.get('project_work_next')
      expect(next?.presentCall?.({})).toEqual({ card: 'generic', title: 'List next project tasks', kind: 'search' })
      expect(next?.presentCall?.({ projectId: 'tiny-proj' }))
        .toEqual({ card: 'generic', title: 'List next project tasks', kind: 'search', rawInput: 'tiny-proj' })
      expect(next?.presentCall?.({ projectId: 42 })).toBeUndefined()

      const claim = mounted.ctx.tools.get('project_work_claim')
      expect(claim?.presentCall?.({ workItemId: 'wi:1' }))
        .toEqual({ card: 'generic', title: 'Claim project task', kind: 'other', rawInput: 'wi:1' })
      expect(claim?.presentCall?.({})).toBeUndefined()

      const update = mounted.ctx.tools.get('project_work_update')
      expect(update?.presentCall?.({ action: 'report', result: 'PASS', exitCode: 0 })).toEqual({
        card: 'generic', title: 'Report verification outcome', kind: 'other', rawInput: { result: 'PASS', exitCode: 0 },
      })
      expect(update?.presentCall?.({ action: 'report', result: 'FAIL' })).toEqual({
        card: 'generic', title: 'Report verification outcome', kind: 'other', rawInput: { result: 'FAIL' },
      })
      expect(update?.presentCall?.({ action: 'heartbeat' }))
        .toEqual({ card: 'generic', title: 'Extend work lease', kind: 'other' })
      expect(update?.presentCall?.({ action: 'release' }))
        .toEqual({ card: 'generic', title: 'Release work claim', kind: 'other' })
      expect(update?.presentCall?.({ action: 'bogus' })).toBeUndefined()
    } finally {
      await unmount(mounted)
    }
  })

  it('fails next loud over an empty ledger', async () => {
    const mounted = await mount()
    try {
      await expectError(await run(mounted, 'project_work_next', {}), 'This ledger records no plan yet.')
    } finally {
      await unmount(mounted)
    }
  })

  it('lists golden agent work with recomputed blockers', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, GOLDEN_PLAN_TEXT)
    })
    try {
      const result = await run(mounted, 'project_work_next', {})
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ projectId: 'mini-dsh' })
      const items = (result.value as { items: { workItemId: string; ready: boolean; blockers: { message: string }[] }[] }).items
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.workItemId.startsWith('wi:mini-dsh:')).toBe(true)
      }
      const blocked = items.find(item => !item.ready)
      expect(blocked).toBeDefined()
      if (blocked !== undefined) expect(blocked.blockers.length).toBeGreaterThan(0)
      expect(text(result)).toContain('Project mini-dsh — ')
      expect(text(result)).toContain('agent work item')
    } finally {
      await unmount(mounted)
    }
  })

  it('resolves next through an explicit project id when the ledger is ambiguous', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, GOLDEN_PLAN_TEXT)
      seedActivePlan(db, TINY_PLAN_TEXT)
    })
    try {
      await expectError(await run(mounted, 'project_work_next', {}), 'more than one project. Name one: mini-dsh, tiny-proj.')
      const result = await run(mounted, 'project_work_next', { projectId: 'tiny-proj' })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ projectId: 'tiny-proj' })
      const missing = await run(mounted, 'project_work_next', { projectId: 'no-such' })
      await expectError(missing, 'No plan in this ledger records project "no-such".')
    } finally {
      await unmount(mounted)
    }
  })

  it('claim requires an owning agent and rejects a contested item', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
    })
    try {
      await expectError(
        await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }),
        'project_work_claim requires an owning agent session',
      )
      const claimed = await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }, { agent: agent('agent-1') })
      expect(claimed.isError).toBe(false)
      await expectError(
        await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }, { agent: agent('agent-2') }),
        'is not ready to claim',
      )
      // The live lease the claim holds is part of the next listing, both as
      // canonical data and in the model-facing text.
      const next = await run(mounted, 'project_work_next', {})
      expect(next.value).toMatchObject({
        items: [{ workItemId: 'wi:tiny-proj:AGENT-FREE', activeLease: { workerIdentity: 'agent:agent-1' } }],
      })
      expect(text(next)).toContain('(held by agent:agent-1)')
    } finally {
      await unmount(mounted)
    }
  })

  it('claim delivers the configured lease and the bounded packet, never the bearer token', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
    }, { leaseTtlMs: 600_000, leaseHeartbeatIntervalMs: 120_000 })
    try {
      const result = await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }, { agent: agent('agent-1') })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        workItemId: 'wi:tiny-proj:AGENT-FREE',
        title: 'Do the free work',
        lease: {
          leaseId: expect.stringMatching(/^ls:wi:tiny-proj:AGENT-FREE:\d+$/) as string,
        },
        packet: {
          objective: { stableKey: 'AGENT-FREE', executorKind: 'AGENT' },
          verifierSpecs: [{ commandText: 'pnpm test' }],
        },
      })
      const value = result.value as {
        lease: { expiresAtMs: number }
        packetId: string
        packetHash: string
        serializedBytes: number
      }
      expect(value.lease.expiresAtMs).toBeGreaterThan(Date.now() + 590_000)
      expect(value.packetId).toMatch(/^wp:wi:tiny-proj:AGENT-FREE:\d+$/)
      expect(value.packetHash).toMatch(/^[0-9a-f]{64}$/)
      expect(value.serializedBytes).toBeGreaterThan(0)
      expect(JSON.stringify(result.value)).not.toContain('leaseToken')
      expect(text(result)).not.toContain('leaseToken')
      expect(text(result)).toContain('Claimed wi:tiny-proj:AGENT-FREE')
    } finally {
      await unmount(mounted)
    }
  })

  it('heartbeat extends the held lease; a report without an exit code still records the verdict', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }, { agent: agent('agent-1') })
      const result = await run(mounted, 'project_work_update', { action: 'heartbeat' }, { agent: agent('agent-1') })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'heartbeat',
        workItemId: 'wi:tiny-proj:AGENT-FREE',
        leaseId: expect.stringMatching(/^ls:wi:tiny-proj:AGENT-FREE:\d+$/) as string,
      })
      expect(JSON.stringify(result.value)).not.toContain('leaseToken')
      expect(text(result)).toMatch(/Lease ls:wi:tiny-proj:AGENT-FREE:\d+ extended to /)

      const reported = await run(
        mounted,
        'project_work_update',
        { action: 'report', result: 'PASS' },
        { agent: agent('agent-1') },
      )
      expect(reported.isError).toBe(false)
      expect(reported.value).toMatchObject({
        action: 'report',
        itemStatus: 'DONE',
        evaluatedCriteria: [{ result: 'PASS', status: 'PASSING' }],
        pendingCriteria: [],
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('report PASS completes an agent-verifiable item end to end', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }, { agent: agent('agent-1') })
      const result = await run(
        mounted,
        'project_work_update',
        { action: 'report', result: 'PASS', exitCode: 0 },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'report',
        workItemId: 'wi:tiny-proj:AGENT-FREE',
        itemStatus: 'DONE',
        evaluatedCriteria: [{
          criterionId: expect.stringContaining('AC-AGENT-FREE') as string,
          result: 'PASS',
          status: 'PASSING',
        }],
        pendingCriteria: [],
      })
      expect(text(result)).toContain('work item wi:tiny-proj:AGENT-FREE is DONE')

      const next = await run(mounted, 'project_work_next', {})
      expect(next.isError).toBe(false)
      expect(text(next)).toBe('No outstanding agent work in project tiny-proj.')

      // The claim concluded with the report; nothing is held to advance.
      await expectError(
        await run(mounted, 'project_work_update', { action: 'heartbeat' }, { agent: agent('agent-1') }),
        'requires a held claim',
      )
    } finally {
      await unmount(mounted)
    }
  })

  it('report never writes an owner confirmation and waits in VERIFYING', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, GATED_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:gated-proj:AGENT-GATED' }, { agent: agent('agent-1') })
      const result = await run(
        mounted,
        'project_work_update',
        { action: 'report', result: 'PASS' },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'report',
        itemStatus: 'VERIFYING',
        evaluatedCriteria: [],
        pendingCriteria: [expect.stringContaining('AC-GATED-OWNER') as string],
      })
      expect(text(result)).toContain('Awaiting: ')

      const db = mounted.ctx.projectLedger.db
      const criterionId = (db.prepare(
        "SELECT id FROM acceptance_criteria WHERE work_item_id = 'wi:gated-proj:AGENT-GATED'",
      ).get() as { id: string }).id
      // The owner confirmation is the owner's write; the item completes only
      // through the acceptance seam the tool never bypasses.
      evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(criterionId), 'PASS', { evaluatedBy: 'owner' })
      changeWorkStatus(db, brandString<WorkItemId>('wi:gated-proj:AGENT-GATED'), 'DONE')
      const status = (db.prepare("SELECT status FROM work_items WHERE id = 'wi:gated-proj:AGENT-GATED'")
        .get() as { status: string }).status
      expect(status).toBe('DONE')
    } finally {
      await unmount(mounted)
    }
  })

  it('report FAIL fails the claimed item', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, SOLO_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:solo-proj:AGENT-ONLY' }, { agent: agent('agent-1') })
      const result = await run(
        mounted,
        'project_work_update',
        { action: 'report', result: 'FAIL', exitCode: 1 },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'report',
        workItemId: 'wi:solo-proj:AGENT-ONLY',
        itemStatus: 'FAILED',
        evaluatedCriteria: [{ result: 'FAIL', status: 'FAILING' }],
        pendingCriteria: [expect.stringContaining('AC-AGENT-ONLY') as string],
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('release returns the item and clears the hold for the next claimer', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, GATED_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:gated-proj:AGENT-GATED' }, { agent: agent('agent-1') })
      const result = await run(mounted, 'project_work_update', { action: 'release' }, { agent: agent('agent-1') })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'release',
        workItemId: 'wi:gated-proj:AGENT-GATED',
        itemStatus: 'READY',
      })
      expect(text(result)).toContain('work item wi:gated-proj:AGENT-GATED is READY')

      const reclaimed = await run(
        mounted,
        'project_work_claim',
        { workItemId: 'wi:gated-proj:AGENT-GATED' },
        { agent: agent('agent-2') },
      )
      expect(reclaimed.isError).toBe(false)
    } finally {
      await unmount(mounted)
    }
  })

  it('validates the update grammar and the holder identity', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, GATED_PLAN_TEXT)
    })
    try {
      await expectError(
        await run(mounted, 'project_work_update', { action: 'heartbeat' }),
        'project_work_update requires an owning agent session',
      )
      await expectError(
        await run(mounted, 'project_work_update', { action: 'heartbeat' }, { agent: agent('agent-1') }),
        'requires a held claim',
      )
      await run(mounted, 'project_work_claim', { workItemId: 'wi:gated-proj:AGENT-GATED' }, { agent: agent('agent-1') })
      await expectError(
        await run(mounted, 'project_work_update', { action: 'report' }, { agent: agent('agent-1') }),
        'action "report" requires result: PASS or FAIL',
      )
      await expectError(
        await run(mounted, 'project_work_update', { action: 'heartbeat', result: 'PASS' }, { agent: agent('agent-1') }),
        'accepts result or exitCode only with action "report"',
      )
    } finally {
      await unmount(mounted)
    }
  })

  it('fails the plugin load on a lease policy the ledger seams would reject', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mini-work-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(MiniProjectLedger, { ledgerPath: join(root, 'ledger.sqlite') })
      await expect(ctx.plugin(miniProjectWork, { leaseTtlMs: 100_000 }))
        .rejects.toThrow('heartbeatIntervalMs < ttlMs / 2')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
