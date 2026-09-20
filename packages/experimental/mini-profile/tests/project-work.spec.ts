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
import { DUAL_PLAN_TEXT, GATED_PLAN_TEXT, GOLDEN_PLAN_TEXT, SOLO_PLAN_TEXT, TINY_PLAN_TEXT, seedActivePlan } from './plans.ts'
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

/** The ledger criterion id carrying the given stable-key fragment, as the packet and report name it. */
function criterionId(mounted: Mounted, workItemId: string, fragment: string): string {
  const rows = mounted.ctx.projectLedger.db
    .prepare('SELECT id FROM acceptance_criteria WHERE work_item_id = ?')
    .all(workItemId) as { id: string }[]
  const found = rows.map(row => row.id).find(id => id.includes(fragment))
  if (found === undefined) throw new Error(`no criterion id containing "${fragment}" on ${workItemId}`)
  return found
}

/** The registered JSON Schema of one tool's parameters. */
interface ToolParameterSchema {
  properties?: Record<string, {
    type: string
    enum?: string[]
    items?: { properties?: Record<string, { type: string; enum?: string[] }> }
  }>
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
      expect(Object.keys(updateProperties).sort()).toEqual(['action', 'criteria'])
      expect(update.required).toEqual(['action'])
      expect(updateProperties.action?.enum).toEqual(['heartbeat', 'release', 'report'])
      expect(updateProperties.criteria?.type).toBe('array')
      const verdictEntry = updateProperties.criteria?.items?.properties ?? {}
      expect(Object.keys(verdictEntry).sort()).toEqual(['criterionId', 'exitCode', 'outputTail', 'result'])
      expect(verdictEntry.criterionId?.type).toBe('string')
      expect(verdictEntry.result?.enum).toEqual(['PASS', 'FAIL'])
      expect(verdictEntry.exitCode?.type).toBe('integer')
      expect(verdictEntry.outputTail?.type).toBe('string')
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
      const verdicts = [{ criterionId: 'ac:1', result: 'PASS', exitCode: 0 }]
      expect(update?.presentCall?.({ action: 'report', criteria: verdicts })).toEqual({
        card: 'generic', title: 'Report verification outcome', kind: 'other', rawInput: verdicts,
      })
      expect(update?.presentCall?.({ action: 'report', criteria: [{ criterionId: 'ac:1', result: 'FAIL' }] })).toEqual({
        card: 'generic', title: 'Report verification outcome', kind: 'other',
        rawInput: [{ criterionId: 'ac:1', result: 'FAIL' }],
      })
      expect(update?.presentCall?.({ action: 'report' }))
        .toEqual({ card: 'generic', title: 'Report verification outcome', kind: 'other' })
      expect(update?.presentCall?.({ action: 'report', criteria: 'PASS' })).toBeUndefined()
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

  it('next shows each agent its own queue: another holder\'s live claim drops out', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, TINY_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:tiny-proj:AGENT-FREE' }, { agent: agent('agent-1') })

      const other = await run(mounted, 'project_work_next', {}, { agent: agent('agent-2') })
      expect(other.isError).toBe(false)
      expect(other.value).toMatchObject({ items: [] })
      expect(text(other)).toBe('No outstanding agent work in project tiny-proj.')

      const holder = await run(mounted, 'project_work_next', {}, { agent: agent('agent-1') })
      expect(holder.value).toMatchObject({
        items: [{ workItemId: 'wi:tiny-proj:AGENT-FREE', activeLease: { workerIdentity: 'agent:agent-1' } }],
      })
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
        { action: 'report', criteria: [{ criterionId: criterionId(mounted, 'wi:tiny-proj:AGENT-FREE', 'AC-AGENT-FREE'), result: 'PASS' }] },
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
        {
          action: 'report',
          criteria: [{
            criterionId: criterionId(mounted, 'wi:tiny-proj:AGENT-FREE', 'AC-AGENT-FREE'),
            result: 'PASS',
            exitCode: 0,
          }],
        },
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
        { action: 'report', criteria: [] },
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
      const gatedCriterionId = (db.prepare(
        "SELECT id FROM acceptance_criteria WHERE work_item_id = 'wi:gated-proj:AGENT-GATED'",
      ).get() as { id: string }).id
      // The owner confirmation is the owner's write; the item completes only
      // through the acceptance seam the tool never bypasses.
      evaluateAcceptanceCriterion(db, brandString<AcceptanceCriterionId>(gatedCriterionId), 'PASS', { evaluatedBy: 'owner' })
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
      const failing = criterionId(mounted, 'wi:solo-proj:AGENT-ONLY', 'AC-AGENT-ONLY')
      const optional = criterionId(mounted, 'wi:solo-proj:AGENT-ONLY', 'AC-AGENT-ONLY-OPT')
      const result = await run(
        mounted,
        'project_work_update',
        {
          action: 'report',
          criteria: [
            { criterionId: failing, result: 'FAIL', exitCode: 1 },
            { criterionId: optional, result: 'PASS', exitCode: 0 },
          ],
        },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'report',
        workItemId: 'wi:solo-proj:AGENT-ONLY',
        itemStatus: 'FAILED',
        evaluatedCriteria: [
          { criterionId: failing, result: 'FAIL', status: 'FAILING' },
          { criterionId: optional, result: 'PASS', status: 'PASSING' },
        ],
        // A failing optional criterion is not on the DONE gate's pending list.
        pendingCriteria: [failing],
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('report applies one verdict per criterion, so a mixed suite fails only its failing criteria', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, DUAL_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:dual-proj:AGENT-DUAL' }, { agent: agent('agent-1') })
      const passing = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-A')
      const failing = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-B')
      const ownerGate = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-OWNER')
      const result = await run(
        mounted,
        'project_work_update',
        {
          action: 'report',
          criteria: [
            { criterionId: passing, result: 'PASS', exitCode: 0 },
            { criterionId: failing, result: 'FAIL', exitCode: 1 },
          ],
        },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'report',
        workItemId: 'wi:dual-proj:AGENT-DUAL',
        itemStatus: 'FAILED',
        evaluatedCriteria: [
          { criterionId: passing, result: 'PASS', status: 'PASSING' },
          { criterionId: failing, result: 'FAIL', status: 'FAILING' },
        ],
        pendingCriteria: [failing, ownerGate],
      })
      const ownerStatus = (mounted.ctx.projectLedger.db
        .prepare('SELECT status FROM acceptance_criteria WHERE id = ?')
        .get(ownerGate) as { status: string }).status
      expect(ownerStatus).toBe('PENDING')
    } finally {
      await unmount(mounted)
    }
  })

  it('report stores the exit code and a bounded output tail in each evaluation', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, DUAL_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:dual-proj:AGENT-DUAL' }, { agent: agent('agent-1') })
      const passing = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-A')
      const failing = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-B')
      const shortTail = 'Tests: 2 passed, 0 failed'
      const longTail = `${'x'.repeat(5_000)}END-OF-OUTPUT`
      const result = await run(
        mounted,
        'project_work_update',
        {
          action: 'report',
          criteria: [
            { criterionId: passing, result: 'PASS', exitCode: 0, outputTail: shortTail },
            { criterionId: failing, result: 'FAIL', exitCode: 1, outputTail: longTail },
          ],
        },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      // The observed payload beside each verdict keeps the exit code and the
      // final characters of the tail, so a replay explains the outcome.
      const observedById = new Map((mounted.ctx.projectLedger.db
        .prepare('SELECT criterion_id, observed_json FROM acceptance_evaluations')
        .all() as { criterion_id: string; observed_json: string }[])
        .map(row => [row.criterion_id, JSON.parse(row.observed_json) as { exitCode?: number; outputTail?: string }]))
      expect(observedById.get(passing)).toEqual({ exitCode: 0, outputTail: shortTail })
      const stored = observedById.get(failing)
      expect(stored?.exitCode).toBe(1)
      expect(stored?.outputTail).toHaveLength(miniProjectWork.REPORT_OUTPUT_TAIL_MAX_CHARS)
      expect(stored?.outputTail).toBe(longTail.slice(-miniProjectWork.REPORT_OUTPUT_TAIL_MAX_CHARS))
    } finally {
      await unmount(mounted)
    }
  })

  it('report passing every observable criterion still waits for the owner gate in VERIFYING', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, DUAL_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:dual-proj:AGENT-DUAL' }, { agent: agent('agent-1') })
      const first = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-A')
      const second = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-B')
      const result = await run(
        mounted,
        'project_work_update',
        { action: 'report', criteria: [{ criterionId: first, result: 'PASS' }, { criterionId: second, result: 'PASS' }] },
        { agent: agent('agent-1') },
      )
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        action: 'report',
        itemStatus: 'VERIFYING',
        evaluatedCriteria: [
          { criterionId: first, result: 'PASS', status: 'PASSING' },
          { criterionId: second, result: 'PASS', status: 'PASSING' },
        ],
        pendingCriteria: [criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-OWNER')],
      })
    } finally {
      await unmount(mounted)
    }
  })

  it('rejects verdict lists that misname, duplicate, or under-cover the observable criteria without writing', async () => {
    const mounted = await mount((db) => {
      seedActivePlan(db, DUAL_PLAN_TEXT)
    })
    try {
      await run(mounted, 'project_work_claim', { workItemId: 'wi:dual-proj:AGENT-DUAL' }, { agent: agent('agent-1') })
      const first = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-A')
      const second = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-B')
      const ownerGate = criterionId(mounted, 'wi:dual-proj:AGENT-DUAL', 'AC-DUAL-OWNER')
      const report = async (criteria: unknown) =>
        await run(mounted, 'project_work_update', { action: 'report', criteria }, { agent: agent('agent-1') })
      await expectError(await report([{ criterionId: 'ac:foreign', result: 'PASS' }]), 'is not an acceptance criterion of wi:dual-proj:AGENT-DUAL')
      await expectError(await report([{ criterionId: ownerGate, result: 'PASS' }]), 'is not agent-observable')
      await expectError(
        await report([{ criterionId: first, result: 'PASS' }, { criterionId: first, result: 'FAIL' }]),
        'lists criterion "' + first + '" twice',
      )
      await expectError(await report([{ criterionId: first, result: 'PASS' }]), `must cover every observable criterion; missing: ${second}`)
      // The rejections validated before any write, so the claim is still
      // held and a well-formed report reaches the ordinary outcome.
      const recovered = await report([{ criterionId: first, result: 'PASS' }, { criterionId: second, result: 'PASS' }])
      expect(recovered.isError).toBe(false)
      expect(recovered.value).toMatchObject({ action: 'report', itemStatus: 'VERIFYING' })
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
        'action "report" requires criteria: one verdict per observable acceptance criterion',
      )
      await expectError(
        await run(mounted, 'project_work_update', { action: 'heartbeat', criteria: [] }, { agent: agent('agent-1') }),
        'accepts criteria only with action "report"',
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
