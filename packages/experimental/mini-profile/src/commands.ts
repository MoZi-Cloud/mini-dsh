/**
 * The mini profile's `/project` command surface: read-only reporting over
 * the mounted Project Ledger for the human operating a `dsh --profile mini`
 * session. `todo` projects the executor-separated Owner/Agent views (v1.6a
 * §11), `doctor` runs the read-only plan doctor pass (F05), and `item`
 * reviews one work item over its criteria and latest evaluations — including
 * each evaluation's observed exit code and output-tail excerpt — through the
 * ledger's review read seam; the project and plan version resolve through
 * the ledger's plan directory when the command names none. The handler never
 * mutates ledger state, never sends anything to the model, and never
 * executes a verifier command — mutating surfaces stay with their owning
 * writers and later work.
 *
 * @module @deepseek-ai/dsh-experimental-mini-profile/commands
 */

import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  PlanDoctorError,
  listAgentTodo,
  listOwnerTodo,
  listPlans,
  planDoctor,
  readWorkItemReview,
  type PlanDoctorReport,
  type PlanVersionId,
  type WorkItemReview,
  type WorkTodoView,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import { ProjectResolutionError, resolveProjectId } from './project-resolution.js'

/** Stable Cordis plugin name. */
export const name = 'mini-project-commands'

/** The services this surface consumes: the command registry and the mounted ledger. */
export const inject = ['commands', 'projectLedger']

/** One parsed `/project` invocation. */
type ProjectCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'todo'; readonly agentView: boolean; readonly projectId: string | undefined }
  | { readonly kind: 'doctor'; readonly planVersionId: string | undefined }
  | { readonly kind: 'item'; readonly itemRef: string; readonly projectId: string | undefined }

/* v8 ignore next 3 -- the parse step returns a closed union */
function assertNever(value: never, label: string): never {
  throw new Error(`unhandled ${label}: ${String(value)}`)
}

const HELP_TEXT = [
  'Inspect the mounted Project Ledger.',
  '/project todo [--agent] [<project-id>] — list outstanding owner (or agent) work with readiness and leases',
  '/project doctor [<plan-version-id>] — run the read-only plan doctor on the current (or named) plan version',
  '/project item <stable-key-or-id> [<project-id>] — review one work item: criteria statuses, latest evaluations, observed evidence',
].join('\n')

/**
 * Parse the exact text following `/project` into one closed command.
 * @param rawInput - exact text after the command name, including separator whitespace.
 * @returns the parsed command, or `undefined` when the input matches no form.
 */
function parseProjectCommand(rawInput: string): ProjectCommand | undefined {
  const tokens = rawInput.split(/\s+/u).filter(token => token !== '')
  if (tokens.length === 0) return { kind: 'help' }
  if (tokens[0] === 'todo') {
    let cursor = 1
    let agentView = false
    if (tokens[cursor] === '--agent') {
      agentView = true
      cursor += 1
    } else if (tokens[cursor] === '--owner') {
      cursor += 1
    }
    if (tokens.length > cursor + 1) return undefined
    return { kind: 'todo', agentView, projectId: tokens[cursor] }
  }
  if (tokens[0] === 'doctor') {
    return tokens.length <= 2
      ? { kind: 'doctor', planVersionId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'item') {
    const [itemRef, projectId] = tokens.slice(1)
    if (itemRef === undefined || tokens.length > 3) return undefined
    return { kind: 'item', itemRef, projectId }
  }
  return undefined
}

/**
 * Resolve which plan version a doctor pass checks.
 * @param db - the opened ledger database.
 * @param explicit - the plan version id the command named, if any.
 * @returns the plan version id to check.
 * @throws {ProjectResolutionError} when the implicit single-plan resolution is empty, ambiguous, or names no current version.
 */
function resolveDoctorVersion(db: DatabaseSync, explicit: string | undefined): PlanVersionId {
  if (explicit !== undefined) return brandString<PlanVersionId>(explicit)
  const plans = listPlans(db)
  const [only, ...rest] = plans
  if (only === undefined) {
    throw new ProjectResolutionError('This ledger records no plan yet. Import a plan version first.')
  }
  if (rest.length > 0) {
    throw new ProjectResolutionError(
      'This ledger records more than one plan. Pass a plan version id: /project doctor <plan-version-id>.',
    )
  }
  const current = only.currentVersionId
  if (current === null) {
    throw new ProjectResolutionError(
      'The plan names no current version yet. Pass a plan version id: /project doctor <plan-version-id>.',
    )
  }
  return current
}

/**
 * Render one todo view as command output: a header line, then one line per
 * entry with its phase, priority, recomputed blockers, and live lease.
 * @param view - the listed view.
 * @param agentView - whether the view is the Agent (not Owner) list.
 * @returns the multi-line command text.
 */
function renderTodoView(view: WorkTodoView, agentView: boolean): string {
  const role = agentView ? 'agent' : 'owner'
  if (view.entries.length === 0) {
    return `No outstanding ${role} work in project ${view.projectId}.`
  }
  const lines = [`Project ${view.projectId} — ${role} todo, ${view.entries.length} items:`]
  for (const entry of view.entries) {
    lines.push(
      `${entry.status} ${entry.workItemId} — ${entry.title} `
        + `(phase ${entry.phaseStableKey ?? 'none'}, priority ${entry.priority})`,
    )
    if (!entry.readiness.ready) {
      lines.push(`  not ready: ${entry.readiness.reasons.map(reason => reason.message).join('; ')}`)
    }
    if (entry.activeLease !== null) {
      lines.push(
        `  lease ${entry.activeLease.leaseId} held by ${entry.activeLease.workerIdentity}, `
          + `expires ${new Date(entry.activeLease.expiresAtMs).toISOString()}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Render one doctor report as command output: the version's identity and
 * baseline, the checked row counts, then every issue or the clean verdict.
 * @param report - the doctor pass outcome.
 * @returns the multi-line command text.
 */
function renderDoctorReport(report: PlanDoctorReport): string {
  const lines = [
    `Plan ${report.planId} v${report.versionNo} (${report.status}) — project ${report.projectId}`,
    `Counts: ${report.counts.phases} phases, ${report.counts.workItems} work items, `
      + `${report.counts.relations} relations, ${report.counts.criteria} criteria, ${report.counts.events} events.`,
    `Baseline repo head: ${report.baselineRepoHead ?? 'none'}`,
  ]
  if (report.issues.length === 0) {
    lines.push('No issues found.')
  } else {
    for (const issue of report.issues) {
      lines.push(`- [${issue.code}] ${issue.message}`)
    }
  }
  return lines.join('\n')
}

/** How many characters of an observed output tail the item review quotes. */
const REVIEW_EXCERPT_CHARS = 160

/**
 * Collapse one observed output tail to a single-line excerpt, so a criterion
 * line stays readable while still showing the verifier's own words.
 * @param tail - the output tail an evaluation stored.
 * @returns the whitespace-collapsed excerpt, cut with an ellipsis past the cap.
 */
function reviewExcerpt(tail: string): string {
  const collapsed = tail.split(/\s+/u).filter(part => part !== '').join(' ')
  return collapsed.length <= REVIEW_EXCERPT_CHARS
    ? collapsed
    : `${collapsed.slice(0, REVIEW_EXCERPT_CHARS)}…`
}

/**
 * Narrow one evaluation's observed payload to the facts the review prints.
 * The payload crossed the durable boundary as JSON, so it is read by field,
 * never trusted whole.
 * @param observed - the parsed observed payload, or `null`.
 * @returns the exit code and output-tail excerpt it carries, when well-formed.
 */
function observedReviewFacts(observed: unknown): { exitCode?: number; tailExcerpt?: string } {
  if (typeof observed !== 'object' || observed === null) return {}
  const record = observed as Record<string, unknown>
  const facts: { exitCode?: number; tailExcerpt?: string } = {}
  if (typeof record.exitCode === 'number') facts.exitCode = record.exitCode
  if (typeof record.outputTail === 'string' && record.outputTail.trim() !== '') {
    facts.tailExcerpt = reviewExcerpt(record.outputTail)
  }
  return facts
}

/**
 * Render one work-item review as command output: the item's identity and
 * status, then one line per criterion with its status and latest evaluation,
 * quoting the observed exit code and output-tail excerpt when present.
 * @param review - the review read seam's outcome.
 * @returns the multi-line command text.
 */
function renderItemReview(review: WorkItemReview): string {
  const lines = [
    `Work item ${review.workItemId} "${review.title}" — ${review.status} `
      + `(${review.executorKind.toLowerCase()}, priority ${String(review.priority)}, `
      + `version ${review.planVersionId ?? 'none'})`,
  ]
  for (const criterion of review.criteria) {
    const role = criterion.required ? 'required' : 'optional'
    if (criterion.latest === null) {
      lines.push(`- ${criterion.criterionId} (${criterion.kind}, ${role}) ${criterion.status} — no evaluation yet`)
      continue
    }
    const { latest } = criterion
    const facts = observedReviewFacts(latest.observed)
    lines.push(
      `- ${criterion.criterionId} (${criterion.kind}, ${role}) ${criterion.status} — ${latest.result} `
        + `by ${latest.evaluatedBy} at ${new Date(latest.evaluatedAtMs).toISOString()}`
        + (facts.exitCode === undefined ? '' : `; exit ${String(facts.exitCode)}`),
    )
    if (facts.tailExcerpt !== undefined) lines.push(`  ${facts.tailExcerpt}`)
  }
  return lines.join('\n')
}

/**
 * Execute one parsed `/project` invocation against the mounted ledger.
 * @param ctx - context whose `projectLedger` service owns the opened database.
 * @param rawInput - exact text after the command name.
 * @returns the settled command result.
 */
function runProjectCommand(ctx: Context, rawInput: string): CommandResult {
  const command = parseProjectCommand(rawInput)
  if (command === undefined) return { kind: 'error', text: 'Unknown /project input. Run /project for usage.' }
  const db = ctx.projectLedger.db
  try {
    switch (command.kind) {
      case 'help':
        return { kind: 'success', text: HELP_TEXT }
      case 'todo': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        const view = command.agentView ? listAgentTodo(db, projectId) : listOwnerTodo(db, projectId)
        return { kind: 'success', text: renderTodoView(view, command.agentView) }
      }
      case 'doctor': {
        const report = planDoctor(db, resolveDoctorVersion(db, command.planVersionId))
        return { kind: 'success', text: renderDoctorReport(report) }
      }
      case 'item': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        const review = readWorkItemReview(db, projectId, command.itemRef)
        if (review === undefined) {
          throw new ProjectResolutionError(
            `No work item "${command.itemRef}" in project ${projectId}. Name a stable key or full id.`,
          )
        }
        return { kind: 'success', text: renderItemReview(review) }
      }
      /* v8 ignore next 2 -- the parse step returns a closed union */
      default: return assertNever(command, 'project command')
    }
  } catch (error) {
    if (error instanceof ProjectResolutionError) return { kind: 'error', text: error.message }
    if (error instanceof PlanDoctorError) {
      return { kind: 'error', text: `The plan doctor rejected the request: ${error.message}` }
    }
    throw error
  }
}

/**
 * Register the mini profile's `/project` reporting command. Effect-owned:
 * disposal unregisters the command with the plugin.
 * @param ctx - profile context carrying the command registry and the ledger mount.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-mini-profile'),
    name: 'project',
    description: 'Inspect Project Ledger work and run the plan doctor',
    input: { hint: 'todo [--agent] [<project-id>] | doctor [<plan-version-id>] | item <stable-key-or-id> [<project-id>]' },
    handler: invocation => runProjectCommand(ctx, invocation.rawInput),
  }))
}
