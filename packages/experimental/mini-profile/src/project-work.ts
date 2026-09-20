/**
 * The mini profile's model-facing project-work tools (v1.6a §5.4, the W09
 * consumer): the three short tools the proposal names, over the mounted
 * Project Ledger. `project_work_next` lists the agent todo view (§11) as
 * canonical JSON, filtered to the calling agent's per-actor claim visibility
 * (v1.6d) when the session names an agent; `project_work_claim` takes the
 * lease and delivers the bounded WorkPacket (§16/§17); `project_work_update`
 * advances the held claim — heartbeat, release, or a verification report.
 *
 * The lease bearer token never enters a model-visible value: the plugin holds
 * it in process memory keyed by the claiming agent's worker identity, so
 * nothing a session log replays can heartbeat or release a lease; a lost
 * holder is recovered by expiry and the reaper, not by a re-derived token.
 *
 * Completion stays with the acceptance seam (§5.3): a report carries one
 * caller-named verdict per criterion whose verifier spec stores runnable text
 * (a command or query the agent can execute through its ordinary tools),
 * covering every such criterion exactly once, and never names an
 * OWNER_CONFIRMATION. Each verdict may carry the observed exit code and a
 * bounded tail of the verifier output, both stored in the evaluation's
 * observed payload, so a replayed ledger shows why a criterion passed or
 * failed without re-running the command. DONE happens only when every
 * required criterion is already PASSING or WAIVED — the ledger's own gate.
 * Nothing here executes a verifier command.
 *
 * @module @deepseek-ai/dsh-experimental-mini-profile/project-work
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ACCEPTANCE_CRITERION_STATUSES,
  PLAN_WORK_ITEM_STATUSES,
  TODO_VIEW_STATUSES,
  WORK_READINESS_BLOCKER_KINDS,
  buildWorkPacket,
  changeWorkStatus,
  claimWorkItem,
  evaluateAcceptanceCriterion,
  heartbeatWorkLease,
  listAgentTodo,
  listPlans,
  releaseWorkLease,
  resolveLeaseConfig,
  serializeWorkPacket,
  type AcceptanceCriterionId,
  type AcceptanceCriterionStatus,
  type LeaseConfig,
  type PlanWorkItemStatus,
  type WorkItemId,
  type WorkLeaseId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import type { DatabaseSync } from 'node:sqlite'
import { resolveProjectId } from './project-resolution.js'

/** Stable Cordis plugin name. */
export const name = 'mini-project-work'

/** The services this surface consumes: the tool registry and the mounted ledger. */
export const inject = ['tools', 'projectLedger']

/** Actor recorded on ledger events this plugin writes; the observing worker is recorded separately. */
const TOOL_ACTOR_REF = 'dsh-experimental-mini-profile/project-work'

/**
 * Final characters kept from a caller-supplied verifier output tail. A fixed
 * storage invariant of the durable ledger — the work packet's serialized
 * ceiling is its peer — bounding what one report can store per criterion; it
 * is not a deployment-varying choice.
 */
export const REPORT_OUTPUT_TAIL_MAX_CHARS = 2048

/** Model-facing project-work tool configuration. */
export interface Config {
  /**
   * Claim and heartbeat horizon in milliseconds; omitted keeps the ledger
   * default. A pair the ledger seams would reject fails the plugin load.
   */
  readonly leaseTtlMs?: number
  /** Heartbeat cadence in milliseconds; omitted keeps the ledger default. */
  readonly leaseHeartbeatIntervalMs?: number
}

/** Schemastery configuration for the project-work tool consumer. */
export const Config: z<Config> = z.object({
  leaseTtlMs: z.number(),
  leaseHeartbeatIntervalMs: z.number(),
})

/** The lease this plugin holds for one claiming agent: the ids plus the bearer token. */
interface HeldClaim {
  readonly leaseId: WorkLeaseId
  readonly leaseToken: string
  readonly workItemId: WorkItemId
}

/**
 * The worker identity recorded on claims and evaluations: which agent session
 * holds or observed the work.
 * @param agent - the calling agent.
 * @returns the ledger-visible worker identity string.
 */
function workerIdentityOf(agent: Agent): string {
  return `agent:${agent.id}`
}

/** One acceptance criterion row as the report path reads it. */
type CriterionRow = {
  readonly id: string
  readonly required: number
  readonly status: AcceptanceCriterionStatus
}

/** One caller-supplied report verdict over an observable criterion. */
interface CriterionVerdict {
  readonly criterionId: string
  readonly result: 'PASS' | 'FAIL'
  readonly exitCode?: number
  readonly outputTail?: string
}

/**
 * List one work item's acceptance criteria in ordinal order.
 * @param db - open ledger database.
 * @param workItemId - the claimed work item.
 * @returns the criterion rows with their projection statuses.
 */
function listCriteria(db: DatabaseSync, workItemId: WorkItemId): CriterionRow[] {
  return db.prepare(
    'SELECT id, required, status FROM acceptance_criteria WHERE work_item_id = ? ORDER BY ordinal',
  ).all(workItemId) as CriterionRow[]
}

/**
 * Whether a criterion's verifier spec stores runnable text — a command or
 * query the agent can execute through its ordinary tools and observe. Kinds
 * with no stored text (an owner instruction, a structural assertion) are not
 * agent-observable, so the report path never writes their evaluations.
 * @param db - open ledger database.
 * @param criterionId - the criterion to check.
 * @returns whether the report path may evaluate the criterion.
 */
function isAgentObservable(db: DatabaseSync, criterionId: string): boolean {
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM verification_specs '
      + 'WHERE criterion_id = ? AND (command_text IS NOT NULL OR query_text IS NOT NULL)',
  ).get(criterionId) as { count: number }
  return row.count > 0
}

/**
 * Bound one caller-supplied verifier output tail to the stored length,
 * keeping the end, where a verifier's summary and failure lines live.
 * @param text - the tail the report carried.
 * @returns the final {@link REPORT_OUTPUT_TAIL_MAX_CHARS} characters at most.
 */
function boundedOutputTail(text: string): string {
  return text.length <= REPORT_OUTPUT_TAIL_MAX_CHARS ? text : text.slice(-REPORT_OUTPUT_TAIL_MAX_CHARS)
}

/**
 * Read one work item's current status.
 * @param db - open ledger database.
 * @param workItemId - the work item to read.
 * @returns the recorded status.
 */
function readItemStatus(db: DatabaseSync, workItemId: WorkItemId): PlanWorkItemStatus {
  const row = db.prepare('SELECT status FROM work_items WHERE id = ?').get(workItemId) as { status: PlanWorkItemStatus }
  return row.status
}

/**
 * Render one listed item as its model-facing line: status, id, claim
 * readiness, and the live lease holder.
 * @param item - one canonical next-listing item.
 * @returns the terse item line.
 */
function renderNextItemLine(item: {
  status: string
  workItemId: string
  ready: boolean
  blockers: { message: string }[]
  activeLease: { workerIdentity: string } | null
}): string {
  const heldBy = item.activeLease === null ? '' : ` (held by ${item.activeLease.workerIdentity})`
  const readiness = item.ready ? ' ready' : ` blocked: ${item.blockers.map(blocker => blocker.message).join('; ')}`
  return `${item.status} ${item.workItemId} —${readiness}${heldBy}`
}

/**
 * Generic, args-only pending presentation shared by the three tools; the
 * completed call keeps this title over the rendered result content, and the
 * Web Client keeps deriving its own cards from the raw events.
 */
function present(title: string, kind: 'search' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register the three model-facing project-work tools on `ctx.tools`.
 * @param ctx - profile context carrying the tool registry and the ledger mount.
 * @param config - deployment's lease policy for this tool's claims.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // The two policy fields are the lease seams' own vocabulary; the eager
  // resolution makes a pair the seams would reject fail the plugin load.
  const leaseConfig: Partial<LeaseConfig> = {
    ...(config.leaseTtlMs === undefined ? {} : { ttlMs: config.leaseTtlMs }),
    ...(config.leaseHeartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: config.leaseHeartbeatIntervalMs }),
  }
  resolveLeaseConfig(leaseConfig)
  const held = new Map<string, HeldClaim>()

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_work_next',
    description: 'List this project\'s outstanding agent work items with claim readiness, blockers, and lease '
      + 'holders. The list is your per-actor view: items another agent holds a live claim on do not appear. '
      + 'Optional parameter projectId selects the project when the ledger records several.',
    parameters: {
      projectId: { type: 'string', description: 'Project id, when the ledger records more than one project.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                workItemId: { type: 'string', required: true },
                stableKey: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...TODO_VIEW_STATUSES] },
                priority: { type: 'integer', required: true },
                phaseStableKey: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                ready: { type: 'boolean', required: true },
                blockers: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, enum: [...WORK_READINESS_BLOCKER_KINDS] },
                      message: { type: 'string', required: true },
                    },
                  },
                },
                activeLease: {
                  required: true,
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        leaseId: { type: 'string', required: true },
                        workerIdentity: { type: 'string', required: true },
                        expiresAtMs: { type: 'integer', required: true },
                      },
                    },
                    { type: 'null' },
                  ],
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.length === 0
          ? `No outstanding agent work in project ${value.projectId}.`
          : [`Project ${value.projectId} — ${value.items.length} agent work item(s):`,
            ...value.items.map(item => renderNextItemLine(item))].join('\n'),
      }],
    },
    presentCall: args => present('List next project tasks', 'search', args.projectId),
    execute(args, exec) {
      const db = ctx.projectLedger.db
      const projectId = resolveProjectId(listPlans(db), args.projectId)
      // Per-actor claim visibility resolves at this boundary: a session that
      // names an agent sees its own queue (another holder's live claims drop
      // out); a session-less execution has no identity to filter by and lists
      // the full queue, the same view the `/project todo --agent` command reads.
      const viewer = exec.agent === undefined ? undefined : workerIdentityOf(exec.agent)
      const view = listAgentTodo(db, projectId, viewer === undefined ? {} : { viewerIdentity: viewer })
      return Promise.resolve({
        projectId: view.projectId,
        items: view.entries.map(entry => ({
          workItemId: entry.workItemId,
          stableKey: entry.stableKey,
          title: entry.title,
          // The query filters rows to the todo statuses; the row type keeps
          // the closed status union, so this narrows what the schema echoes.
          status: entry.status as (typeof TODO_VIEW_STATUSES)[number],
          priority: entry.priority,
          phaseStableKey: entry.phaseStableKey,
          ready: entry.readiness.ready,
          blockers: entry.readiness.reasons.map(reason => ({ kind: reason.kind, message: reason.message })),
          activeLease: entry.activeLease === null ? null : {
            leaseId: entry.activeLease.leaseId,
            workerIdentity: entry.activeLease.workerIdentity,
            expiresAtMs: entry.activeLease.expiresAtMs,
          },
        })),
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_work_claim',
    description: 'Claim one ready agent work item (parameter workItemId) and receive its bounded work packet: the '
      + 'objective, phase, blocking receipts, acceptance criteria, and stored verifier specs. The claim holds a '
      + 'lease; advance it with project_work_update.',
    parameters: {
      workItemId: { type: 'string', required: true, description: 'The work item to claim, as project_work_next listed it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workItemId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          lease: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              leaseId: { type: 'string', required: true },
              expiresAtMs: { type: 'integer', required: true },
            },
          },
          packet: {
            type: 'json',
            required: true,
            description: 'The bounded work-packet document, hash-pinned by the recorded project/work-packet-prepared recipe.',
          },
          packetId: { type: 'string', required: true },
          packetHash: { type: 'string', required: true },
          serializedBytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Claimed ${value.workItemId} — "${value.title}". Lease ${value.lease.leaseId} expires `
          + `${new Date(value.lease.expiresAtMs).toISOString()}. Work packet delivered; report the verifier `
          + 'outcome with project_work_update.',
      }],
    },
    presentCall: args => present('Claim project task', 'other', args.workItemId),
    execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('project_work_claim requires an owning agent session; the claim needs a worker identity')
      }
      const identity = workerIdentityOf(exec.agent)
      const db = ctx.projectLedger.db
      const workItemId = brandString<WorkItemId>(args.workItemId)
      const claim = claimWorkItem(db, workItemId, identity, { actorRef: TOOL_ACTOR_REF, leaseConfig })
      held.set(identity, { leaseId: claim.leaseId, leaseToken: claim.leaseToken, workItemId })
      const packet = buildWorkPacket(db, workItemId, { actorRef: TOOL_ACTOR_REF })
      const packetDocument = JSON.parse(serializeWorkPacket(packet)) as JsonValue
      return Promise.resolve({
        workItemId: claim.workItemId,
        title: packet.objective.title,
        lease: { leaseId: claim.leaseId, expiresAtMs: claim.expiresAtMs },
        packet: packetDocument,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        serializedBytes: packet.serializedBytes,
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'project_work_update',
    description: 'Advance your held claim. action heartbeat extends the lease; action release gives the item back; '
      + 'action report (parameter criteria: one {criterionId, result PASS|FAIL, optional exitCode, optional '
      + 'outputTail} entry per observable acceptance criterion) records your verifier observations per criterion '
      + 'with the exit code and the bounded output tail stored in each evaluation\'s observed payload, moves the '
      + 'item to VERIFYING or FAILED, and completes it only when every required criterion already passes — owner '
      + 'confirmations are never written here.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['heartbeat', 'release', 'report'],
        description: 'heartbeat | release | report.',
      },
      criteria: {
        type: 'array',
        description: 'For action report only: one verdict per observable acceptance criterion the work packet delivered.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterionId: { type: 'string', required: true, description: 'Criterion id exactly as the work packet delivered it.' },
            result: { type: 'string', required: true, enum: ['PASS', 'FAIL'], description: 'Verdict you observed for this criterion.' },
            exitCode: { type: 'integer', description: 'Verifier exit code you observed for this criterion.' },
            outputTail: {
              type: 'string',
              description: `Final part of the verifier output you observed for this criterion; at most the last ${String(REPORT_OUTPUT_TAIL_MAX_CHARS)} characters are stored.`,
            },
          },
        },
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', const: 'heartbeat', required: true },
              workItemId: { type: 'string', required: true },
              leaseId: { type: 'string', required: true },
              expiresAtMs: { type: 'integer', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', const: 'release', required: true },
              workItemId: { type: 'string', required: true },
              leaseId: { type: 'string', required: true },
              itemStatus: { type: 'string', required: true, enum: [...PLAN_WORK_ITEM_STATUSES] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', const: 'report', required: true },
              workItemId: { type: 'string', required: true },
              leaseId: { type: 'string', required: true },
              itemStatus: { type: 'string', required: true, enum: [...PLAN_WORK_ITEM_STATUSES] },
              evaluatedCriteria: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    criterionId: { type: 'string', required: true },
                    result: { type: 'string', required: true, enum: ['PASS', 'FAIL'] },
                    status: { type: 'string', required: true, enum: [...ACCEPTANCE_CRITERION_STATUSES] },
                  },
                },
              },
              pendingCriteria: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        ],
      },
      render: (_args, value) => {
        let text: string
        switch (value.action) {
          case 'heartbeat':
            text = `Lease ${value.leaseId} extended to ${new Date(value.expiresAtMs).toISOString()}.`
            break
          case 'release':
            text = `Released ${value.leaseId}; work item ${value.workItemId} is ${value.itemStatus}.`
            break
          case 'report':
            text = `Recorded ${value.evaluatedCriteria.length} evaluation(s); work item ${value.workItemId} is `
              + `${value.itemStatus}.`
              + (value.pendingCriteria.length > 0 ? ` Awaiting: ${value.pendingCriteria.join(', ')}.` : '')
            break
        }
        return [{ type: 'text', text }]
      },
    },
    presentCall: (args) => {
      const title = args.action === 'report'
        ? 'Report verification outcome'
        : args.action === 'heartbeat' ? 'Extend work lease' : 'Release work claim'
      return present(title, 'other', args.action === 'report' ? args.criteria : undefined)
    },
    execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('project_work_update requires an owning agent session; the update needs the holder identity')
      }
      const identity = workerIdentityOf(exec.agent)
      const heldClaim = held.get(identity)
      if (heldClaim === undefined) {
        throw new Error('project_work_update requires a held claim; call project_work_claim first')
      }
      if (args.action !== 'report' && args.criteria !== undefined) {
        throw new Error('project_work_update accepts criteria only with action "report"')
      }
      const db = ctx.projectLedger.db
      if (args.action === 'heartbeat') {
        const lease = heartbeatWorkLease(db, heldClaim.leaseId, heldClaim.leaseToken, { actorRef: TOOL_ACTOR_REF, leaseConfig })
        return Promise.resolve({
          action: 'heartbeat',
          workItemId: heldClaim.workItemId,
          leaseId: lease.leaseId,
          expiresAtMs: lease.expiresAtMs,
        })
      }
      if (args.action === 'release') {
        releaseWorkLease(db, heldClaim.leaseId, heldClaim.leaseToken, { actorRef: TOOL_ACTOR_REF })
        held.delete(identity)
        return Promise.resolve({
          action: 'release',
          workItemId: heldClaim.workItemId,
          leaseId: heldClaim.leaseId,
          itemStatus: readItemStatus(db, heldClaim.workItemId),
        })
      }
      if (args.criteria === undefined) {
        throw new Error('project_work_update action "report" requires criteria: one verdict per observable acceptance criterion')
      }
      // Report: validate the verdict list against the item, prove the lease
      // is live, then record one evaluation per observable criterion. The
      // projection statuses and the acceptance gate decide the outcome.
      const criteriaRows = listCriteria(db, heldClaim.workItemId)
      const itemCriterionIds = new Set(criteriaRows.map(criterion => criterion.id))
      const observable = criteriaRows.filter(criterion => isAgentObservable(db, criterion.id))
      const observableIds = new Set(observable.map(criterion => criterion.id))
      const verdicts = new Map<string, CriterionVerdict>()
      for (const entry of args.criteria) {
        if (!itemCriterionIds.has(entry.criterionId)) {
          throw new Error(`project_work_update criterion "${entry.criterionId}" is not an acceptance criterion of ${heldClaim.workItemId}`)
        }
        if (!observableIds.has(entry.criterionId)) {
          throw new Error(`project_work_update criterion "${entry.criterionId}" is not agent-observable; the report path never evaluates it`)
        }
        if (verdicts.has(entry.criterionId)) {
          throw new Error(`project_work_update lists criterion "${entry.criterionId}" twice`)
        }
        verdicts.set(entry.criterionId, entry)
      }
      const ordered: CriterionVerdict[] = []
      const missing: string[] = []
      for (const criterion of observable) {
        const verdict = verdicts.get(criterion.id)
        if (verdict === undefined) missing.push(criterion.id)
        else ordered.push(verdict)
      }
      if (missing.length > 0) {
        throw new Error(`project_work_update criteria must cover every observable criterion; missing: ${missing.join(', ')}`)
      }
      heartbeatWorkLease(db, heldClaim.leaseId, heldClaim.leaseToken, { actorRef: TOOL_ACTOR_REF, leaseConfig })
      for (const verdict of ordered) {
        const observed: { exitCode?: number; outputTail?: string } = {}
        if (verdict.exitCode !== undefined) observed.exitCode = verdict.exitCode
        if (verdict.outputTail !== undefined) observed.outputTail = boundedOutputTail(verdict.outputTail)
        evaluateAcceptanceCriterion(
          db,
          brandString<AcceptanceCriterionId>(verdict.criterionId),
          verdict.result,
          {
            evaluatedBy: identity,
            ...(Object.keys(observed).length === 0 ? {} : { observed }),
          },
        )
      }
      const after = listCriteria(db, heldClaim.workItemId)
      const resultById = new Map(ordered.map(verdict => [verdict.criterionId, verdict.result]))
      const evaluatedCriteria = after.flatMap((criterion) => {
        const result = resultById.get(criterion.id)
        return result === undefined ? [] : [{ criterionId: criterion.id, result, status: criterion.status }]
      })
      const pendingCriteria = after
        .filter(criterion => criterion.required === 1 && criterion.status !== 'PASSING' && criterion.status !== 'WAIVED')
        .map(criterion => criterion.id)
      if (ordered.some(verdict => verdict.result === 'FAIL')) {
        changeWorkStatus(db, heldClaim.workItemId, 'FAILED', { actorRef: identity })
      } else {
        changeWorkStatus(db, heldClaim.workItemId, 'VERIFYING', { actorRef: identity })
        if (pendingCriteria.length === 0) {
          changeWorkStatus(db, heldClaim.workItemId, 'DONE', { actorRef: identity })
        }
      }
      // The claim concludes with the report; the lease goes back regardless
      // of outcome, and the item's terminal or awaiting state outlives it.
      releaseWorkLease(db, heldClaim.leaseId, heldClaim.leaseToken, { actorRef: TOOL_ACTOR_REF })
      held.delete(identity)
      return Promise.resolve({
        action: 'report',
        workItemId: heldClaim.workItemId,
        leaseId: heldClaim.leaseId,
        itemStatus: readItemStatus(db, heldClaim.workItemId),
        evaluatedCriteria,
        pendingCriteria,
      })
    },
  })))
}
