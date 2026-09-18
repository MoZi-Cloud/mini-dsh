/**
 * The post-v1.6a real-use lane (docs/mini/real-use-log.md, §33): drives real
 * repository work through the SHIPPED mini-profile surface — the same
 * MiniProjectLedger and mini-project-work plugins a `dsh --profile mini`
 * session mounts — against one Project Ledger. For one ready work item of the
 * post-v1.6a increment plan the lane is the agent of record: it observes
 * through project_work_next, claims through project_work_claim (receiving the
 * WorkPacket, never the plan document), executes each observable criterion's
 * stored verifier command from the packet as a real subprocess in the
 * repository, and reports one verdict per criterion through
 * project_work_update with the observed exit code and output tail. DONE with
 * a clean doctor and a matching replay is the only passing outcome; a failing
 * verifier records its criterion FAIL and fails the run.
 *
 * The ledger is a fresh temporary file unless DSH_REAL_USE_LEDGER names a
 * persistent one (the profile default is ~/.dsh/project-ledger/ledger.sqlite),
 * so consecutive runs accumulate the real-use record in place. Runs are
 * idempotent: the plan document's current version imports once, any prior
 * ACTIVE version of the same plan is superseded through the §22 seam, and an
 * already-complete item passes without writing. No model is involved — this
 * lane is the deterministic driver whose recorded runs are the §33 real-use
 * evidence.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  compilePlan,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  replayProjectEvents,
  supersedePlanVersion,
  validatePlanSchema,
  type PlanVersionId,
  type WorkItemId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import MiniProjectLedger from '@deepseek-ai/dsh-experimental-mini-profile'
import * as miniProjectWork from '@deepseek-ai/dsh-experimental-mini-profile/project-work'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** The increment plan this lane drives; the shell entry runs from the repository root. */
const PLAN_PATH = join(process.cwd(), 'docs/mini/v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml')
/** The item this run claims; a later increment names its own item. */
const TARGET_STABLE_KEY = process.env.DSH_REAL_USE_ITEM ?? 'PW-ITEM-REVIEW-001'
/** A repository suite verifier can legitimately take minutes; the bound keeps a hung one from parking the lane. */
const VERIFIER_TIMEOUT_MS = 600_000
/** How much verifier output the failure diagnostics carry. */
const RESULT_TAIL_CHARS = 4_000
/** The agent identity recorded on claims, evaluations, and events this lane drives. */
const LANE_AGENT_ID = 'mini-real-use-lane'

/** One entry of the next listing, as the lane reads the canonical value. */
interface NextItem {
  readonly workItemId: string
  readonly stableKey: string
  readonly ready: boolean
  readonly blockers: readonly { readonly message: string }[]
}

/** The outcome report, printed as one JSON line. */
interface LaneReport {
  readonly lane: 'real-use'
  readonly ledger: string
  readonly alreadyComplete: boolean
  readonly planVersionId: string
  readonly workItemId: string
  readonly stableKey: string
  readonly verifierResults: readonly {
    readonly criterionId: string
    readonly command: string
    readonly exitCode: number | null
  }[]
  readonly itemStatus: string
  readonly doctorIssues: number
  readonly replayItemStatus: string
  readonly toolCalls: Readonly<Record<string, number>>
}

/** One executed verifier run paired with the criterion its spec belongs to. */
interface VerifierRun {
  readonly criterionId: string
  readonly command: string
  readonly exitCode: number | null
  readonly output: string
}

/** The verifier-spec fields of a work-packet document the lane reads. */
interface PacketVerifierSpec {
  readonly criterionId: string
  readonly commandText: string | null
  readonly queryText: string | null
}

/** Run one verifier command in the repository, bounded in time and output. */
async function runVerifier(command: string): Promise<{ exitCode: number | null; output: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn('sh', ['-c', command], { cwd: process.cwd() })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), VERIFIER_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolveRun({ exitCode, output: output.slice(-RESULT_TAIL_CHARS) })
    })
  })
}

/**
 * Run every observable criterion's stored command verifier from a claimed
 * work packet, in packet order. Specs without stored text are not
 * agent-observable and are skipped; a query verifier is observable but not
 * executable here, so it fails loud instead of being reported from nothing.
 */
async function runPacketVerifiers(specs: readonly PacketVerifierSpec[]): Promise<VerifierRun[]> {
  const runs: VerifierRun[] = []
  for (const spec of specs) {
    if (spec.commandText === null) {
      if (spec.queryText !== null) {
        throw new Error(`real-use lane: criterion ${spec.criterionId} stores a query verifier, which this lane cannot execute`)
      }
      continue
    }
    const verifier = await runVerifier(spec.commandText)
    runs.push({ criterionId: spec.criterionId, command: spec.commandText, exitCode: verifier.exitCode, output: verifier.output })
  }
  if (runs.length === 0) {
    throw new Error('real-use lane: the work packet carries no command verifier to run')
  }
  return runs
}

async function main(): Promise<void> {
  const persistentLedger = process.env.DSH_REAL_USE_LEDGER
  let ledgerPath: string
  let cleanup: (() => Promise<void>) | undefined
  if (persistentLedger === undefined || persistentLedger === '') {
    const root = await mkdtemp(join(tmpdir(), 'dsh-real-use-'))
    ledgerPath = join(root, 'ledger.sqlite')
    cleanup = () => rm(root, { recursive: true, force: true })
  } else {
    ledgerPath = persistentLedger
  }

  const planText = await readFile(PLAN_PATH, 'utf8')
  const compiled = compilePlan(validatePlanSchema(parsePlanDocument(planText).value), { sourceText: planText })

  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MiniProjectLedger, { ledgerPath })
    await ctx.plugin(miniProjectWork)
    const db = ctx.projectLedger.db

    const existing = db.prepare('SELECT id, status FROM plan_versions WHERE plan_id = ? AND version_no = ?')
      .get(compiled.planId, compiled.versionNo) as { id: string; status: string } | undefined
    let versionId: string
    if (existing === undefined) {
      versionId = importPlanVersion(db, compiled, { sourcePath: PLAN_PATH }).planVersionId
    } else {
      versionId = existing.id
    }
    const statusRow = () => db.prepare('SELECT status FROM plan_versions WHERE id = ?')
      .get(versionId) as { status: string }
    if (statusRow().status !== 'ACTIVE') {
      // The supersede seam (§22): a prior ACTIVE version of this plan freezes
      // under the imported successor; like activation, supersede-then-activate
      // here is the owner's move the lane performs directly, per the pinned
      // fixtures' documented raw owner updates.
      const activeOther = db.prepare(
        "SELECT id FROM plan_versions WHERE plan_id = ? AND status = 'ACTIVE' AND id <> ?",
      ).get(compiled.planId, versionId) as { id: string } | undefined
      if (activeOther !== undefined) {
        supersedePlanVersion(db, brandString<PlanVersionId>(activeOther.id), {
          succeededBy: brandString<PlanVersionId>(versionId),
        })
      }
      db.prepare("UPDATE plan_versions SET status = 'ACTIVE' WHERE id = ?").run(versionId)
    }

    const itemRow = db.prepare('SELECT id, status FROM work_items WHERE plan_version_id = ? AND stable_key = ?')
      .get(versionId, TARGET_STABLE_KEY) as { id: string; status: string } | undefined
    if (itemRow === undefined) {
      throw new Error(`real-use lane: plan version ${versionId} records no work item ${TARGET_STABLE_KEY}`)
    }

    const toolCalls: Record<string, number> = {}
    const signal = new AbortController().signal
    let serial = 0
    const call = async (name: string, args: unknown): Promise<unknown> => {
      toolCalls[name] = (toolCalls[name] ?? 0) + 1
      const result = await ctx.tools.execute({
        signal,
        callId: ToolCallId(`real-use-${++serial}`),
        name,
        arguments: args,
        agent: { id: LANE_AGENT_ID } as Agent,
      })
      if (result.isError) {
        const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
        throw new Error(`real-use lane: ${name} failed: ${text}`)
      }
      return result.value
    }

    if (itemRow.status === 'DONE') {
      const doctor = planDoctor(db, brandString<PlanVersionId>(versionId))
      if (doctor.issues.length > 0) {
        throw new Error(`real-use lane: doctor reports ${String(doctor.issues.length)} issue(s) on an already-complete item`)
      }
      const report: LaneReport = {
        lane: 'real-use',
        ledger: ledgerPath,
        alreadyComplete: true,
        planVersionId: versionId,
        workItemId: itemRow.id,
        stableKey: TARGET_STABLE_KEY,
        verifierResults: [],
        itemStatus: itemRow.status,
        doctorIssues: 0,
        replayItemStatus: 'DONE',
        toolCalls,
      }
      process.stdout.write(JSON.stringify(report) + '\n')
      return
    }

    const nextValue = await call('project_work_next', {}) as { items: NextItem[] }
    const entry = nextValue.items.find(item => item.stableKey === TARGET_STABLE_KEY)
    if (entry === undefined) {
      throw new Error(`real-use lane: ${TARGET_STABLE_KEY} is ${itemRow.status} and absent from the agent todo view`)
    }
    if (!entry.ready) {
      throw new Error(`real-use lane: ${TARGET_STABLE_KEY} is blocked: ${entry.blockers.map(b => b.message).join('; ')}`)
    }

    const claimValue = await call('project_work_claim', { workItemId: entry.workItemId }) as {
      packet: { verifierSpecs: readonly PacketVerifierSpec[] }
    }
    const verifierRuns = await runPacketVerifiers(claimValue.packet.verifierSpecs)
    const allPassed = verifierRuns.every(run => run.exitCode === 0)

    const updateValue = await call('project_work_update', {
      action: 'report',
      criteria: verifierRuns.map(run => ({
        criterionId: run.criterionId,
        result: run.exitCode === 0 ? 'PASS' as const : 'FAIL' as const,
        ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
        ...(run.output === '' ? {} : { outputTail: run.output }),
      })),
    }) as {
      action: string
      itemStatus: string
      evaluatedCriteria: readonly { criterionId: string; result: string }[]
      pendingCriteria: readonly string[]
    }
    if (updateValue.action !== 'report') {
      throw new Error(`real-use lane: report came back as ${updateValue.action}`)
    }
    // Every executed criterion is recorded with exactly the verdict the lane observed.
    const observed = new Map(verifierRuns.map(run => [run.criterionId, run.exitCode === 0 ? 'PASS' : 'FAIL']))
    for (const evaluated of updateValue.evaluatedCriteria) {
      if (observed.get(evaluated.criterionId) !== evaluated.result) {
        throw new Error(
          `real-use lane: criterion ${evaluated.criterionId} recorded ${evaluated.result}, `
          + `expected ${observed.get(evaluated.criterionId) ?? 'no verdict'}`,
        )
      }
    }
    // The bounded output tail landed beside each exit code in the evaluations'
    // observed payload, so the ledger explains the verdicts without a rerun.
    const observedRows = db.prepare(
      'SELECT criterion_id, observed_json FROM acceptance_evaluations WHERE work_item_id = ?',
    ).all(entry.workItemId) as { criterion_id: string; observed_json: string | null }[]
    const observedTailById = new Map(observedRows.map(row => {
      const payload = JSON.parse(row.observed_json ?? '{}') as { exitCode?: number; outputTail?: string }
      return [row.criterion_id, payload]
    }))
    for (const run of verifierRuns) {
      const payload = observedTailById.get(run.criterionId)
      const expectedTail = run.output === '' ? undefined : run.output.slice(-miniProjectWork.REPORT_OUTPUT_TAIL_MAX_CHARS)
      if (payload?.outputTail !== expectedTail) {
        throw new Error(
          `real-use lane: criterion ${run.criterionId} stored `
          + `${String(payload?.outputTail?.length ?? 0)} output-tail character(s), expected the bounded verifier tail`,
        )
      }
    }
    if (allPassed && updateValue.itemStatus !== 'DONE') {
      throw new Error(
        `real-use lane: PASS report left the item ${updateValue.itemStatus}`
        + (updateValue.pendingCriteria.length > 0 ? `; pending: ${updateValue.pendingCriteria.join(', ')}` : ''),
      )
    }
    if (!allPassed) {
      const failing = verifierRuns.filter(run => run.exitCode !== 0)
      throw new Error(
        `real-use lane: ${String(failing.length)} verifier(s) failed (criterion ${failing.map(run => run.criterionId).join(', ')}); `
        + `item is ${updateValue.itemStatus}; output tail: ${failing.map(run => run.output.slice(-800)).join('\n')}`,
      )
    }

    const doctor = planDoctor(db, brandString<PlanVersionId>(versionId))
    if (doctor.issues.length > 0) {
      throw new Error(`real-use lane: doctor reports ${String(doctor.issues.length)} issue(s) after completion`)
    }
    const replayed = replayProjectEvents(db, compiled.projectId).workItems.get(brandString<WorkItemId>(entry.workItemId))
    if (replayed?.status !== 'DONE') {
      throw new Error(`real-use lane: replayed projection is ${replayed === undefined ? 'missing' : replayed.status}, expected DONE`)
    }

    const report: LaneReport = {
      lane: 'real-use',
      ledger: ledgerPath,
      alreadyComplete: false,
      planVersionId: versionId,
      workItemId: entry.workItemId,
      stableKey: TARGET_STABLE_KEY,
      verifierResults: verifierRuns.map(run => ({
        criterionId: run.criterionId,
        command: run.command,
        exitCode: run.exitCode,
      })),
      itemStatus: updateValue.itemStatus,
      doctorIssues: 0,
      replayItemStatus: replayed.status,
      toolCalls,
    }
    process.stdout.write(JSON.stringify(report) + '\n')
  } finally {
    await ctx.fiber.dispose()
    if (cleanup !== undefined) await cleanup()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-experimental-project-ledger',
  '@deepseek-ai/dsh-experimental-mini-profile',
  '@deepseek-ai/dsh-experimental-mini-profile/project-work',
].map(name => [name, import.meta.resolve(name)])))

await main()
