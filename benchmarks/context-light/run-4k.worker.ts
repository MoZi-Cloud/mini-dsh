/**
 * The pinned context-light 4K real-use slice (docs/mini/v1.6a §3, W12,
 * AC-4K-001): one fresh agent completes one real ledger-driven task with the
 * provider and adapter context window both pinned to 4096 and no widening.
 * The agent sees the task only through the Project Ledger — the tool results
 * carry the WorkPacket, never the task plan — executes the packet's verifier
 * command as a real subprocess in a copied fixture workspace, and reports the
 * outcome through the ledger's acceptance seam.
 *
 * Two lanes share the loop and the tools. The deterministic lane (default)
 * drives a scripted adapter that reads its next action from the packet in
 * the conversation and enforces the §3 pre-check — estimated request tokens
 * plus reserved output at or under 4096 — on every request. The live lane
 * (DSH_4K_LIVE=1 with DEEPSEEK_API_KEY) sends the same loop to the real
 * provider and takes the final verdict from provider usage, the standard §3
 * names; the heuristic estimate stays a pre-check there.
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  ToolCallId,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  buildWorkPacket,
  changeWorkStatus,
  claimWorkItem,
  compilePlan,
  evaluateAcceptanceCriterion,
  activatePlanVersion,
  importPlanVersion,
  listAgentTodo,
  parsePlanDocument,
  replayProjectEvents,
  serializeWorkPacket,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type WorkItemId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** The benchmark's source tree, holding the task plan and fixture workspace; the shell entry runs from the repository root. */
const SRC = join(process.cwd(), 'benchmarks', 'context-light')

/** §3: provider and adapter context window, with no widening to 8192. */
const TOKEN_BUDGET = 4096
/** Output reserved before the request is admitted; the estimate must leave room for it. */
const RESERVED_OUTPUT_TOKENS = 512
/**
 * Conservative pre-check conversion (§3): four characters per token. The
 * deterministic lane's verdict and the live lane's pre-check both use it; the
 * live lane's final verdict uses provider usage.
 */
const CHARS_PER_TOKEN = 4
const VERIFIER_TIMEOUT_MS = 30_000
const RESULT_TAIL_CHARS = 1_500
/** The report tool's stored output-tail bound, mirrored so the fixture stores what the real tool stores. */
const REPORT_OUTPUT_TAIL_MAX_CHARS = 2048

const PERSONA = [
  'You are a project agent working from a Project Ledger.',
  'Call project_work_next to get your task packet, claim it with project_work_claim,',
  'make exactly the change the packet describes using write_file, verify with the',
  "packet's verifier command through run_command, then report the outcome with",
  'project_work_update. Do not read any plan document.',
].join(' ')

/** The pinned implementation the task's description fully determines. */
const MATH_IMPLEMENTATION = 'export function checksumSum(a, b) {\n  return a + b\n}\n'

/** One measured model request. */
interface RequestSample {
  readonly bytes: number
  readonly tokens: number
  /** Provider-reported input tokens; present only in the live lane. */
  readonly reportedInputTokens: number | undefined
}

/** The slice's outcome report, printed as one JSON line. */
interface SliceReport {
  readonly lane: 'deterministic' | 'live'
  readonly requests: number
  readonly requestSamples: readonly RequestSample[]
  readonly maxEstimatedRequestTokens: number
  readonly packetBytes: number
  readonly toolCalls: Readonly<Record<string, number>>
  readonly verifierExitCode: number | null
  readonly finalItemStatus: string
}

/** Serialize one request exactly as the model-visible payload and estimate its tokens. */
function measureRequest(options: GenerateOptions): { bytes: number; tokens: number } {
  const bytes = Buffer.byteLength(
    JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }),
    'utf8',
  )
  return { bytes, tokens: Math.ceil(bytes / CHARS_PER_TOKEN) + RESERVED_OUTPUT_TOKENS }
}

/** Fail the run when a request cannot fit the pinned window — widening is not an option. */
function enforceBudget(lane: string, sample: { tokens: number }): void {
  if (sample.tokens > TOKEN_BUDGET) {
    throw new Error(
      `${lane} request estimated at ${sample.tokens} tokens exceeds the pinned ${TOKEN_BUDGET}-token window; `
        + 'context widening is not allowed (docs/mini/v1.6a §3)',
    )
  }
}

/** Stream one assistant turn made only of whole content blocks. */
function* blockChunks(blocks: readonly ContentBlock[]): Generator<StreamChunk> {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined) throw new Error('unreachable block index')
    yield { type: 'block-start', index, blockType: block.type }
    yield { type: 'block-end', index, block }
  }
}

function toolCallBlock(serial: number, name: string, args: Readonly<Record<string, unknown>>): ContentBlock {
  return {
    type: 'tool-call',
    id: ToolCallId(`call-${serial}`),
    name,
    arguments: JSON.stringify(args),
  }
}

/**
 * The deterministic lane's model: every action is derived from the packet
 * text already in the conversation, proving the packet alone carries the
 * task. The script refuses any turn past the fixed flow, so an accidental
 * context grower fails instead of looping.
 */
class ScriptedLaneAdapter extends LlmAdapter {
  readonly samples: RequestSample[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Context-Light Scripted 4K',
      context: { contextWindow: TOKEN_BUDGET },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const measured = measureRequest(options)
    enforceBudget('deterministic lane', measured)
    this.samples.push({ ...measured, reportedInputTokens: undefined })
    const transcript = JSON.stringify(options.messages)
    const serial = this.samples.length
    let blocks: readonly ContentBlock[]
    if (serial === 1) {
      blocks = [toolCallBlock(serial, 'project_work_next', {})]
    } else if (serial === 2) {
      const workItemId = /workItemId\\*":\\*"([^"\\]+)/.exec(transcript)?.[1]
      if (workItemId === undefined) throw new Error('scripted lane: no work item id in the packet result')
      blocks = [toolCallBlock(serial, 'project_work_claim', { workItemId })]
    } else if (serial === 3) {
      blocks = [toolCallBlock(serial, 'write_file', { path: 'src/math.mjs', content: MATH_IMPLEMENTATION })]
    } else if (serial === 4) {
      const command = /commandText\\*":\\*"([^"\\]+)/.exec(transcript)?.[1]
      if (command === undefined) throw new Error('scripted lane: the packet result carries no verifier command')
      blocks = [toolCallBlock(serial, 'run_command', { command })]
    } else if (serial === 5) {
      const criterionId = /criterionId\\*":\\*"([^"\\]+)/.exec(transcript)?.[1]
      if (criterionId === undefined) throw new Error('scripted lane: the packet result carries no criterion id')
      blocks = [toolCallBlock(serial, 'project_work_update', {
        action: 'report',
        criteria: [{ criterionId, result: 'PASS', outputTail: 'all tests passed' }],
      })]
    } else if (serial === 6) {
      blocks = [{ type: 'text', text: 'Slice complete.' }]
    } else {
      throw new Error(`scripted lane: unexpected model request ${serial}; the fixed flow is six requests`)
    }
    const hasToolCalls = blocks.some(block => block.type === 'tool-call')
    yield* blockChunks(blocks)
    yield { type: 'usage', usage: { inputTokens: measured.tokens, outputTokens: 32 } }
    yield { type: 'finish', reason: { kind: hasToolCalls ? 'tool-calls' : 'stop' } }
  }
}

/** Minimal shape of one OpenAI-compatible non-streaming completion response. */
interface CompletionResponse {
  readonly choices: readonly {
    readonly message: {
      readonly content: string | null
      readonly tool_calls?: readonly { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }[]
    }
  }[]
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number }
}

/**
 * The live lane's model: the real provider behind the same pinned window.
 * The provider-message mapping is the one shape this lane owns; the loop's
 * message internals cross it as plain records.
 */
function providerMessages(options: GenerateOptions): Readonly<Record<string, unknown>[]> {
  const mapped: Record<string, unknown>[] = []
  for (const message of options.messages) {
    const record = message as unknown as {
      role: string
      content: readonly Record<string, unknown>[]
    }
    const blocks = record.content ?? []
    const text = blocks
      .filter(block => block['type'] === 'text')
      .map(block => String(block['text'] ?? ''))
      .join('\n')
    const calls = blocks.filter(block => block['type'] === 'tool-call')
    const results = blocks.filter(block => block['type'] === 'tool-result')
    if (record.role === 'assistant' && calls.length > 0) {
      mapped.push({
        role: 'assistant',
        content: text === '' ? null : text,
        tool_calls: calls.map(block => ({
          id: block['id'],
          type: 'function',
          function: { name: block['name'], arguments: block['arguments'] },
        })),
      })
      continue
    }
    for (const result of results) {
      mapped.push({
        role: 'tool',
        tool_call_id: result['callId'] ?? result['toolCallId'] ?? result['id'],
        content: result['content'] === undefined ? text : JSON.stringify(result['content']),
      })
    }
    if (results.length === 0) {
      mapped.push({ role: record.role === 'system' ? 'system' : record.role, content: text })
    }
  }
  return mapped
}

/** The live lane's adapter: real requests, pinned window, usage as the verdict. */
class LiveLaneAdapter extends LlmAdapter {
  readonly samples: RequestSample[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Context-Light Live 4K',
      context: { contextWindow: TOKEN_BUDGET },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const measured = measureRequest(options)
    enforceBudget('live lane pre-check', measured)
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        max_tokens: 1024,
        messages: providerMessages(options),
        tools: options.tools === undefined ? undefined : options.tools.map(tool => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      }),
    })
    if (!response.ok) {
      throw new Error(`live lane: provider responded ${String(response.status)} ${await response.text()}`)
    }
    const payload = await response.json() as CompletionResponse
    const choice = payload.choices[0]?.message
    if (choice === undefined) throw new Error('live lane: provider returned no choice')
    const blocks: ContentBlock[] = choice.content === null ? [] : [{ type: 'text', text: choice.content }]
    for (const call of choice.tool_calls ?? []) {
      blocks.push({ type: 'tool-call', id: ToolCallId(call.id), name: call.function.name, arguments: call.function.arguments })
    }
    const reported = payload.usage?.prompt_tokens
    this.samples.push({ ...measured, reportedInputTokens: reported })
    if (reported !== undefined && reported > TOKEN_BUDGET) {
      throw new Error(
        `live lane: provider reported ${String(reported)} input tokens, above the pinned ${TOKEN_BUDGET}-token window`,
      )
    }
    yield* blockChunks(blocks)
    if (payload.usage !== undefined) {
      yield {
        type: 'usage',
        usage: { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens },
      }
    }
    yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}

/** Run one command in the workspace, bounded in time and output. */
async function runVerifier(workspaceRoot: string, command: string): Promise<{ exitCode: number | null; output: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn('sh', ['-c', command], { cwd: workspaceRoot })
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

async function main(): Promise<void> {
  const live = process.env.DSH_4K_LIVE === '1'
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
  if (live && apiKey === '') {
    throw new Error('DSH_4K_LIVE=1 requires DEEPSEEK_API_KEY for real provider usage')
  }
  const adapter: ScriptedLaneAdapter | LiveLaneAdapter = live
    ? new LiveLaneAdapter(
        process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        apiKey,
        process.env.DSH_4K_MODEL ?? 'deepseek-chat',
      )
    : new ScriptedLaneAdapter()

  const root = await mkdtemp(join(tmpdir(), 'dsh-context-light-'))
  const workspaceRoot = join(root, 'workspace')
  let finalItemStatus = 'unknown'
  let verifierExitCode: number | null = null
  let verifierOutput = ''
  let lastToolError = ''
  const toolCalls: Record<string, number> = {}
  let packetBytes = 0
  try {
    const planTextProbe = join(SRC, 'task-plan.yaml')
    const planProbe = await readFile(planTextProbe, 'utf8').then(() => true, () => false)
    if (!planProbe) {
      throw new Error(`task plan not found at ${planTextProbe}; run benchmarks/context-light/run-4k.sh from the repository root`)
    }
    await cp(join(SRC, 'workspace'), workspaceRoot, { recursive: true })
    const db = await openProjectLedgerDatabase(':memory:')
    const planText = await readFile(join(SRC, 'task-plan.yaml'), 'utf8')
    const compiled = compilePlan(validatePlanSchema(parsePlanDocument(planText).value), { sourceText: planText })
    const { planVersionId } = importPlanVersion(db, compiled)
    activatePlanVersion(db, planVersionId)

    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: PERSONA },
      })
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.effect(() => ctx.llm.registerAdapter(['context-light'], adapter))
      ctx.effect(() => ctx.tools.register(defineContentToolFixture({
        name: 'project_work_next',
        description: 'Get the next ready agent task as a bounded WorkPacket. No parameters.',
        parameters: {},
        isConcurrencySafe: () => true,
        execute() {
          toolCalls['project_work_next'] = (toolCalls['project_work_next'] ?? 0) + 1
          const entry = listAgentTodo(db, compiled.projectId, {}).entries[0]
          if (entry === undefined) return Promise.resolve([{ type: 'text', text: 'no ready agent task' }])
          const packet = buildWorkPacket(db, entry.workItemId, { actorRef: 'context-light/slice' })
          const packetText = serializeWorkPacket(packet)
          packetBytes = Buffer.byteLength(packetText, 'utf8')
          return Promise.resolve([{
            type: 'text',
            text: JSON.stringify({ workItemId: entry.workItemId, packet: JSON.parse(packetText) }),
          }])
        },
      })))
      ctx.effect(() => ctx.tools.register(defineContentToolFixture({
        name: 'project_work_claim',
        description: 'Claim one work item by id. Parameter workItemId: string.',
        parameters: { workItemId: { type: 'string', required: true } },
        isConcurrencySafe: () => false,
        execute(args: { workItemId: string }) {
          toolCalls['project_work_claim'] = (toolCalls['project_work_claim'] ?? 0) + 1
          const claim = claimWorkItem(
            db,
            brandString<WorkItemId>(args.workItemId),
            'context-light/agent',
            { actorRef: 'context-light/slice', leaseConfig: { ttlMs: 600_000, heartbeatIntervalMs: 120_000 } },
          )
          return Promise.resolve([{
            type: 'text',
            text: JSON.stringify({ leaseId: claim.leaseId, expiresAtMs: claim.expiresAtMs }),
          }])
        },
      })))
      ctx.effect(() => ctx.tools.register(defineContentToolFixture({
        name: 'write_file',
        description: 'Write one file inside the task workspace. Parameters path: string, content: string.',
        parameters: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        isConcurrencySafe: () => false,
        async execute(args: { path: string; content: string }) {
          toolCalls['write_file'] = (toolCalls['write_file'] ?? 0) + 1
          try {
          const target = resolve(workspaceRoot, args.path)
          if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
            throw new Error(`write_file refuses paths outside the workspace: ${args.path}`)
          }
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, args.content, 'utf8')
          return [{ type: 'text', text: `wrote ${String(Buffer.byteLength(args.content, 'utf8'))} bytes to ${args.path}` }]
          } catch (error: unknown) {
            lastToolError = `write_file: ${(error as Error).message}`
            throw error
          }
        },
      })))
      ctx.effect(() => ctx.tools.register(defineContentToolFixture({
        name: 'run_command',
        description: 'Run one verifier command from the packet in the task workspace. Parameter command: string.',
        parameters: { command: { type: 'string', required: true } },
        isConcurrencySafe: () => false,
        async execute(args: { command: string }) {
          toolCalls['run_command'] = (toolCalls['run_command'] ?? 0) + 1
          const outcome = await runVerifier(workspaceRoot, args.command)
          verifierExitCode = outcome.exitCode
          verifierOutput = outcome.output
          return [{ type: 'text', text: JSON.stringify({ exitCode: outcome.exitCode, output: outcome.output }) }]
        },
      })))
      ctx.effect(() => ctx.tools.register(defineContentToolFixture({
        name: 'project_work_update',
        description: 'Report the verifier outcome. Parameter criteria: one {criterionId, result PASS|FAIL} entry '
          + 'per observable acceptance criterion the packet delivered.',
        parameters: {
          action: { type: 'string', required: true, enum: ['heartbeat', 'release', 'report'] },
          criteria: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                criterionId: { type: 'string', required: true },
                result: { type: 'string', required: true, enum: ['PASS', 'FAIL'] },
                exitCode: { type: 'integer' },
                outputTail: { type: 'string' },
              },
            },
          },
        },
        isConcurrencySafe: () => false,
        execute(args: { action: string; criteria: { criterionId: string; result: string; outputTail?: string }[] }) {
          toolCalls['project_work_update'] = (toolCalls['project_work_update'] ?? 0) + 1
          if (args.action !== 'report') {
            throw new Error(`project_work_update fixture: action ${args.action} is outside the 4K slice flow`)
          }
          const entry = listAgentTodo(db, compiled.projectId, {}).entries[0]
          if (entry === undefined) throw new Error('project_work_update: no in-flight task found')
          for (const verdict of args.criteria) {
            evaluateAcceptanceCriterion(
              db,
              brandString<AcceptanceCriterionId>(verdict.criterionId),
              verdict.result === 'PASS' ? 'PASS' : 'FAIL',
              {
                evaluatedBy: 'context-light/agent',
                attemptRef: 'context-light/4k',
                observed: {
                  exitCode: verifierExitCode,
                  ...(verdict.outputTail === undefined
                    ? {}
                    : { outputTail: verdict.outputTail.slice(-REPORT_OUTPUT_TAIL_MAX_CHARS) }),
                },
              },
            )
          }
          changeWorkStatus(db, entry.workItemId, 'VERIFYING', { actorRef: 'context-light/agent' })
          if (args.criteria.every(verdict => verdict.result === 'PASS')) {
            changeWorkStatus(db, entry.workItemId, 'DONE', { actorRef: 'context-light/agent' })
          }
          finalItemStatus = (db.prepare('SELECT status FROM work_items WHERE id = ?')
            .get(entry.workItemId) as { status: string }).status
          return Promise.resolve([{ type: 'text', text: JSON.stringify({ itemStatus: finalItemStatus }) }])
        },
      })))

      const agent = await ctx.agentLoop.create(
        SessionId('context-light-4k'),
        { provider: 'context-light', model: live ? (process.env.DSH_4K_MODEL ?? 'deepseek-chat') : 'scripted-4k' },
      )
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Complete your next project task.' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    } finally {
      await ctx.fiber.dispose()
    }

    if (finalItemStatus !== 'DONE' || verifierExitCode !== 0) {
      throw new Error(
        `slice did not complete: item status ${finalItemStatus}, verifier exit `
          + (verifierExitCode === null ? 'null' : String(verifierExitCode))
          + `; requests ${String(adapter.samples.length)}, tool calls ${JSON.stringify(toolCalls)}, `
          + `verifier output: ${verifierOutput.slice(-600)}, last tool error: ${lastToolError}`,
      )
    }
    const criterionRow = db.prepare('SELECT status FROM acceptance_criteria').get() as { status: string }
    if (criterionRow.status !== 'PASSING') {
      throw new Error(`criterion projection is ${criterionRow.status}, expected PASSING`)
    }
    const evaluationRow = db.prepare('SELECT result FROM acceptance_evaluations').get() as { result: string }
    if (evaluationRow.result !== 'PASS') {
      throw new Error(`recorded evaluation is ${evaluationRow.result}, expected PASS`)
    }
    const taskItem = compiled.workItems[0]
    if (taskItem === undefined) throw new Error('task plan carries no work item')
    const replayed = replayProjectEvents(db, compiled.projectId).workItems.get(taskItem.id)
    if (replayed?.status !== 'DONE') {
      throw new Error(`replayed projection status is ${replayed === undefined ? 'missing' : replayed.status}, expected DONE`)
    }
    const samples = adapter.samples
    const report: SliceReport = {
      lane: live ? 'live' : 'deterministic',
      requests: samples.length,
      requestSamples: samples,
      maxEstimatedRequestTokens: samples.reduce((max, sample) => Math.max(max, sample.tokens), 0),
      packetBytes,
      toolCalls,
      verifierExitCode,
      finalItemStatus,
    }
    process.stdout.write(JSON.stringify(report) + '\n')
    db.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-loop-testkit',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-experimental-project-ledger',
  '@deepseek-ai/dsh-experimental-project-ledger-sqlite',
].map(name => [name, import.meta.resolve(name)])))

await main()
