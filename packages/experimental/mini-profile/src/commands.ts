/**
 * The mini profile's `/project` command surface: read-only reporting over
 * the mounted Project Ledger for the human operating a `dsh --profile mini`
 * session. `todo` projects the executor-separated Owner/Agent views (v1.6a
 * §11), `doctor` runs the read-only plan doctor pass (F05), `item`
 * reviews one work item over its criteria and latest evaluations, `history`
 * lists that item's every recorded attempt newest-first — including
 * each evaluation's observed exit code and output-tail excerpt — through the
 * ledger's review read seam, `replay` audits ledger integrity through
 * the replay read seam, folding the project's events and comparing the
 * projection with the materialized rows, `digest` reads the whole-project
 * evidence summary through the ledger's digest read seam, which `export`
 * renders again as one archival markdown block, `decisions` lists the
 * project's owner decision requests with their options and the decisions
 * that resolved them, `approvals` lists the project's approvals over
 * their typed subjects with the decisions that answered them,
 * `resources` lists the project's resource requirements with their
 * instances and verification verdicts, `actors` lists the project's
 * registered actors, defined roles, and live assignments, `assignments`
 * lists the project's work assignments with their item, actor, and role
 * labels, `handoffs` lists the project's recorded handoffs with their
 * item, sender, and recipient labels, and `reservations` lists the
 * project's scope reservations with their item, actor, and scope. The
 * project and plan version
 * resolve through the ledger's plan directory when the command names none. The handler never mutates ledger state, never sends anything to
 * the model, and never executes a verifier command — mutating surfaces stay
 * with their owning writers and later work.
 *
 * @module @deepseek-ai/dsh-experimental-mini-profile/commands
 */

import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ACCEPTANCE_EVALUATION_RESULTS,
  PlanDoctorError,
  listAgentTodo,
  listOwnerTodo,
  listPlans,
  planDoctor,
  readProjectActors,
  readProjectApprovals,
  readProjectDecisions,
  readProjectResources,
  readProjectDigest,
  readProjectHandoffs,
  readProjectScopeReservations,
  readProjectReplay,
  readProjectWorkAssignments,
  readWorkItemHistory,
  readWorkItemReview,
  type ActorDirectory,
  type Approval,
  type DecisionRequest,
  type PlanDoctorReport,
  type PlanVersionId,
  type ProjectDigest,
  type ProjectId,
  type ProjectReplayReport,
  type ResourceRequirement,
  type ReviewedCriterion,
  type Handoff,
  type ScopeReservation,
  type WorkAssignment,
  type WorkItemHistory,
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
  | { readonly kind: 'history'; readonly itemRef: string; readonly projectId: string | undefined }
  | { readonly kind: 'replay'; readonly projectId: string | undefined }
  | { readonly kind: 'digest'; readonly projectId: string | undefined }
  | { readonly kind: 'export'; readonly projectId: string | undefined }
  | { readonly kind: 'decisions'; readonly projectId: string | undefined }
  | { readonly kind: 'approvals'; readonly projectId: string | undefined }
  | { readonly kind: 'resources'; readonly projectId: string | undefined }
  | { readonly kind: 'actors'; readonly projectId: string | undefined }
  | { readonly kind: 'assignments'; readonly projectId: string | undefined }
  | { readonly kind: 'handoffs'; readonly projectId: string | undefined }
  | { readonly kind: 'reservations'; readonly projectId: string | undefined }

/* v8 ignore next 3 -- the parse step returns a closed union */
function assertNever(value: never, label: string): never {
  throw new Error(`unhandled ${label}: ${String(value)}`)
}

const HELP_TEXT = [
  'Inspect the mounted Project Ledger.',
  '/project todo [--agent] [<project-id>] — list outstanding owner (or agent) work with readiness and leases',
  '/project doctor [<plan-version-id>] — run the read-only plan doctor on the current (or named) plan version',
  '/project item <stable-key-or-id> [<project-id>] — review one work item: criteria statuses, latest evaluations, observed evidence',
  '/project history <stable-key-or-id> [<project-id>] — list one work item\'s full evaluation timeline, newest first',
  '/project replay [<project-id>] — replay the project\'s events and compare the projection with materialized rows',
  '/project digest [<project-id>] — read the whole-project evidence digest: plan versions, item completion, replay verdict',
  '/project export [<project-id>] — render the whole evidence record as one archival markdown block',
  '/project decisions [<project-id>] — list owner decision requests with options and the decisions that resolved them',
  '/project approvals [<project-id>] — list approvals over their typed subjects with the decisions that answered them',
  '/project resources [<project-id>] — list resource requirements with instances and verification verdicts',
  '/project actors [<project-id>] — list registered actors, defined roles, and live assignments',
  '/project assignments [<project-id>] — list work assignments with their item, actor, and role labels',
  '/project handoffs [<project-id>] — list recorded handoffs with their item, sender, and recipient labels',
  '/project reservations [<project-id>] — list scope reservations with their item, actor, and scope',
].join('\n')

/** The usage hint the command registry shows for /project. */
const PROJECT_INPUT_HINT = [
  'todo [--agent] [<project-id>]',
  'doctor [<plan-version-id>]',
  'item <stable-key-or-id> [<project-id>]',
  'history <stable-key-or-id> [<project-id>]',
  'replay [<project-id>]',
  'digest [<project-id>]',
  'export [<project-id>]',
  'decisions [<project-id>]',
  'approvals [<project-id>]',
  'resources [<project-id>]',
  'actors [<project-id>]',
  'assignments [<project-id>]',
  'handoffs [<project-id>]',
  'reservations [<project-id>]',
].join(' | ')

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
  if (tokens[0] === 'history') {
    const [itemRef, projectId] = tokens.slice(1)
    if (itemRef === undefined || tokens.length > 3) return undefined
    return { kind: 'history', itemRef, projectId }
  }
  if (tokens[0] === 'replay') {
    return tokens.length <= 2
      ? { kind: 'replay', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'digest') {
    return tokens.length <= 2
      ? { kind: 'digest', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'export') {
    return tokens.length <= 2
      ? { kind: 'export', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'decisions') {
    return tokens.length <= 2
      ? { kind: 'decisions', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'approvals') {
    return tokens.length <= 2
      ? { kind: 'approvals', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'resources') {
    return tokens.length <= 2
      ? { kind: 'resources', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'actors') {
    return tokens.length <= 2
      ? { kind: 'actors', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'assignments') {
    return tokens.length <= 2
      ? { kind: 'assignments', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'handoffs') {
    return tokens.length <= 2
      ? { kind: 'handoffs', projectId: tokens[1] }
      : undefined
  }
  if (tokens[0] === 'reservations') {
    return tokens.length <= 2
      ? { kind: 'reservations', projectId: tokens[1] }
      : undefined
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
 * Render one work-item evaluation history as command output: the item's
 * identity and status, then every recorded attempt newest-first with its
 * verdict, evaluator, time, and observed exit code and output-tail excerpt.
 * @param history - the history read seam's outcome.
 * @returns the multi-line command text.
 */
function renderItemHistory(history: WorkItemHistory): string {
  const lines = [
    `Work item ${history.workItemId} "${history.title}" — ${history.status} `
      + `(${history.executorKind.toLowerCase()}, priority ${String(history.priority)}, `
      + `version ${history.planVersionId ?? 'none'})`,
  ]
  if (history.evaluations.length === 0) {
    lines.push('No evaluations recorded yet.')
    return lines.join('\n')
  }
  lines.push(`Evaluation history (${String(history.evaluations.length)}), newest first:`)
  for (const evaluation of history.evaluations) {
    const facts = observedReviewFacts(evaluation.observed)
    lines.push(
      `- ${evaluation.criterionId} (${evaluation.kind}) ${evaluation.result} `
        + `by ${evaluation.evaluatedBy} at ${new Date(evaluation.evaluatedAtMs).toISOString()}`
        + (facts.exitCode === undefined ? '' : `; exit ${String(facts.exitCode)}`),
    )
    if (facts.tailExcerpt !== undefined) lines.push(`  ${facts.tailExcerpt}`)
  }
  return lines.join('\n')
}

/**
 * Render one replay audit as command output: the timeline size, the counts
 * both sides recorded, then the parity verdict — every drift finding, or the
 * clean line; an undecodable timeline reports why instead of parity.
 * @param report - the replay read seam's outcome.
 * @returns the multi-line command text.
 */
function renderReplayReport(report: ProjectReplayReport): string {
  const header = `Project ${report.projectId} — replay audit over ${String(report.eventCount)} events, `
    + `last sequence ${String(report.lastSequenceNo)}.`
  if (report.outcome === 'undecodable') {
    return [
      header,
      `The timeline cannot be decoded by this build: ${report.timelineError}`,
      `Materialized: ${String(report.materialized.planVersions)} plan versions, `
        + `${String(report.materialized.workItems)} work items, ${String(report.materialized.criteria)} criteria, `
        + `${String(report.materialized.leases)} leases.`,
    ].join('\n')
  }
  const lines = [
    header,
    `Replayed: ${String(report.replayed.planVersions)} plan versions, ${String(report.replayed.workItems)} work items, `
      + `${String(report.replayed.criteria)} criteria, ${String(report.replayed.leases)} leases, `
      + `${String(report.replayed.workPackets)} work packets.`,
    `Materialized: ${String(report.materialized.planVersions)} plan versions, `
      + `${String(report.materialized.workItems)} work items, ${String(report.materialized.criteria)} criteria, `
      + `${String(report.materialized.leases)} leases.`,
  ]
  if (report.drift.length === 0) {
    lines.push('Replay matches every materialized row.')
    return lines.join('\n')
  }
  lines.push(`Drift (${String(report.drift.length)}):`)
  for (const finding of report.drift) lines.push(`- ${finding.message}`)
  return lines.join('\n')
}

/**
 * Count one item's criteria whose latest evaluation records `result`.
 * @param item - the digest row to count over.
 * @param result - the evaluation result to count.
 * @returns how many of the item's criteria carry that latest verdict.
 */
function latestResultCount(
  item: { readonly criteria: readonly ReviewedCriterion[] },
  result: string,
): number {
  return item.criteria.filter(criterion => criterion.latest?.result === result).length
}

/**
 * Render one evidence digest as command output: every plan with its versions,
 * lifecycle statuses, and pinned baselines, every item with its completion
 * and latest verdict counts, then the replay audit verdict — clean, every
 * drift finding, or why the timeline cannot be decoded.
 * @param digest - the digest read seam's outcome.
 * @returns the multi-line command text.
 */
function renderDigest(digest: ProjectDigest): string {
  const lines = [`Project ${digest.projectId} — evidence digest.`]
  for (const plan of digest.plans) {
    lines.push(`Plan ${plan.planName} (${plan.planId}) — current version ${plan.currentVersionId ?? 'none'}.`)
    if (plan.versions.length === 0) {
      lines.push('  No plan versions recorded.')
      continue
    }
    for (const version of plan.versions) {
      const retired = version.supersededAtMs === null
        ? ''
        : `, superseded ${new Date(version.supersededAtMs).toISOString()}`
      lines.push(`  v${version.versionNo} ${version.status} — baseline ${version.baselineRepoHead ?? 'none'}${retired}`)
    }
  }
  lines.push(`Items (${digest.items.length}):`)
  for (const item of digest.items) {
    const passing = item.criteria.filter(criterion => criterion.status === 'PASSING').length
    const verdictCounts = ACCEPTANCE_EVALUATION_RESULTS
      .map(result => [result, latestResultCount(item, result)] as const)
      .filter(([, count]) => count > 0)
      .map(([result, count]) => `${result} ${String(count)}`)
    const evidence = item.lastEvaluatedAtMs === null
      ? ''
      : `; last evidence ${new Date(item.lastEvaluatedAtMs).toISOString()}`
    lines.push(
      `- ${item.stableKey} (${item.executorKind.toLowerCase()}, priority ${item.priority}) ${item.status} `
        + `— criteria ${passing}/${item.criteria.length} passing, `
        + `verdicts ${verdictCounts.length === 0 ? 'none' : verdictCounts.join(', ')}${evidence}`,
    )
  }
  lines.push(...replayVerdictLines(digest.replay))
  return lines.join('\n')
}

/**
 * Render the replay audit verdict lines both digest views share.
 * @param replay - the digest's embedded replay audit report.
 * @returns the verdict line, plus one line per drift finding when any exists.
 */
function replayVerdictLines(replay: ProjectReplayReport): string[] {
  if (replay.outcome === 'undecodable') {
    return [`Replay audit: the timeline cannot be decoded by this build — ${replay.timelineError}`]
  }
  if (replay.drift.length === 0) {
    return [`Replay audit: clean over ${replay.eventCount} events (last sequence ${replay.lastSequenceNo}).`]
  }
  const count = replay.drift.length
  return [
    `Replay audit: ${count} drift finding${count === 1 ? '' : 's'} over ${replay.eventCount} events:`,
    ...replay.drift.map(finding => `- ${finding.message}`),
  ]
}

/**
 * Render the whole-project evidence export as one archival markdown block:
 * every plan with its versions and baselines, every item with per-criterion
 * status and latest-verdict evidence (observed exit code and output-tail
 * excerpt included), and the replay audit verdict. Paste-ready for the §33
 * record or a review; the export only reads.
 * @param digest - the digest read seam's outcome.
 * @returns the markdown document text.
 */
function renderEvidenceExport(digest: ProjectDigest): string {
  const lines = [`# Project ${digest.projectId} — evidence export`, '', '## Plans', '']
  for (const plan of digest.plans) {
    lines.push(`- **${plan.planName}** (\`${plan.planId}\`) — current version \`${plan.currentVersionId ?? 'none'}\``)
    if (plan.versions.length === 0) {
      lines.push('  - (no plan versions recorded)')
      continue
    }
    for (const version of plan.versions) {
      const retired = version.supersededAtMs === null
        ? ''
        : `, superseded ${new Date(version.supersededAtMs).toISOString()}`
      lines.push(`  - v${version.versionNo} ${version.status} — baseline \`${version.baselineRepoHead ?? 'none'}\`${retired}`)
    }
  }
  lines.push('', `## Work items (${digest.items.length})`, '')
  for (const item of digest.items) {
    const passing = item.criteria.filter(criterion => criterion.status === 'PASSING').length
    const evidence = item.lastEvaluatedAtMs === null
      ? ''
      : ` · last evidence ${new Date(item.lastEvaluatedAtMs).toISOString()}`
    lines.push(`### ${item.stableKey} — ${item.title}`, '')
    lines.push(
      `\`${item.status}\` · ${item.executorKind.toLowerCase()} · priority ${item.priority} `
        + `· version \`${item.planVersionId ?? 'none'}\` · criteria ${passing}/${item.criteria.length} passing${evidence}`,
    )
    for (const criterion of item.criteria) {
      const role = criterion.required ? 'required' : 'optional'
      if (criterion.latest === null) {
        lines.push(`- \`${criterion.criterionId}\` (${criterion.kind}, ${role}) ${criterion.status} — no evaluation yet`)
        continue
      }
      const { latest } = criterion
      const facts = observedReviewFacts(latest.observed)
      lines.push(
        `- \`${criterion.criterionId}\` (${criterion.kind}, ${role}) ${criterion.status} — ${latest.result} `
          + `by ${latest.evaluatedBy} at ${new Date(latest.evaluatedAtMs).toISOString()}`
          + (facts.exitCode === undefined ? '' : `; exit ${String(facts.exitCode)}`),
      )
      if (facts.tailExcerpt !== undefined) lines.push(`  - evidence: ${facts.tailExcerpt}`)
    }
    lines.push('')
  }
  lines.push('## Replay audit', '', ...replayVerdictLines(digest.replay).map(stripReplayAuditLabel))
  return lines.join('\n')
}

/**
 * Drop the shared verdict line's leading label for the export's prose
 * section, which names itself.
 * @param line - one shared replay verdict line.
 * @returns the line without its `Replay audit: ` prefix.
 */
function stripReplayAuditLabel(line: string): string {
  return line.replace(/^Replay audit: /u, '')
}

/**
 * Render the project's decision requests as command output: a header line,
 * then one entry per request — newest first — with its blocking level,
 * status, options, and the decision that resolved it, when one did.
 * @param projectId - the project whose requests are listed.
 * @param requests - the listed requests, newest first.
 * @returns the multi-line command text.
 */
function renderDecisions(projectId: ProjectId, requests: readonly DecisionRequest[]): string {
  if (requests.length === 0) {
    return `No decision requests in project ${projectId}.`
  }
  const lines = [`Project ${projectId} — decision requests, ${requests.length}:`]
  for (const request of requests) {
    lines.push(`- ${request.decisionKey} (${request.blockingLevel}) ${request.status} — ${request.title}`)
    if (request.options.length > 0) {
      const options = request.options
        .map(option => `${option.optionKey} (${option.label}${option.recommended ? ', recommended' : ''})`)
        .join(', ')
      lines.push(`  options: ${options}`)
    }
    const decision = request.decision
    if (decision !== undefined) {
      const selected = decision.selectedOptionKey === undefined ? '' : ` ${decision.selectedOptionKey} —`
      lines.push(
        `  decided by ${decision.decidedBy} at ${new Date(decision.decidedAtMs).toISOString()}:${selected} `
          + `${decision.decisionText}${decision.rationale === undefined ? '' : ` (rationale: ${decision.rationale})`}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Render the project's approvals as command output: a header line, then one
 * entry per approval — newest first — with its typed subject, status, and
 * the decision that answered it, when one did.
 * @param projectId - the project whose approvals are listed.
 * @param approvals - the listed approvals, newest first.
 * @returns the multi-line command text.
 */
function renderApprovals(projectId: ProjectId, approvals: readonly Approval[]): string {
  if (approvals.length === 0) {
    return `No approvals in project ${projectId}.`
  }
  const lines = [`Project ${projectId} — approvals, ${approvals.length}:`]
  for (const approval of approvals) {
    const requestedBy = approval.requestedBy === undefined ? 'unknown' : approval.requestedBy
    const role = approval.requiredRole === undefined ? '' : ` (requires ${approval.requiredRole})`
    lines.push(
      `- ${approval.subjectType} ${approval.subjectId} ${approval.status}${role} `
        + `— requested by ${requestedBy} at ${new Date(approval.requestedAtMs).toISOString()}`,
    )
    const decision = approval.decision
    if (decision !== undefined) {
      lines.push(
        `  decided by ${decision.decidedBy} at ${new Date(decision.decidedAtMs).toISOString()}: ${decision.decisionText}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Render the project's resource requirements as command output: a header
 * line, then one entry per requirement — newest first — with its kind,
 * status, constraints, and the instances serving it with their verification
 * verdicts.
 * @param projectId - the project whose requirements are listed.
 * @param requirements - the listed requirements, newest first.
 * @returns the multi-line command text.
 */
function renderResources(projectId: ProjectId, requirements: readonly ResourceRequirement[]): string {
  if (requirements.length === 0) {
    return `No resource requirements in project ${projectId}.`
  }
  const lines = [`Project ${projectId} — resource requirements, ${requirements.length}:`]
  for (const requirement of requirements) {
    const requestedFrom = requirement.requestedFrom === undefined ? 'unknown' : requirement.requestedFrom
    lines.push(
      `- ${requirement.requirementKey} (${requirement.requirementKind}) ${requirement.status} — ${requirement.name} `
        + `(requested from ${requestedFrom})`,
    )
    lines.push(`  constraints: ${requirement.constraintsJson}`)
    for (const instance of requirement.instances) {
      const provider = instance.provider === undefined ? 'unknown' : instance.provider
      lines.push(
        `  instance ${instance.label} ${instance.status} — provided by ${provider}`,
        `    at ${new Date(instance.providedAtMs).toISOString()}`,
      )
      for (const verification of instance.verifications) {
        const observed = verification.observedJson === undefined ? '' : ` observed ${verification.observedJson}`
        lines.push(
          `    verified ${verification.result} (${verification.verifierKind}) at `
            + `${new Date(verification.verifiedAtMs).toISOString()}:${observed}`,
        )
      }
    }
  }
  return lines.join('\n')
}

/**
 * Render the project's actor directory as command output: actors, roles, and
 * the live assignments between them, each with its defining facts.
 * @param projectId - the project whose directory is listed.
 * @param directory - the listed actors, roles, and assignments.
 * @returns the multi-line command text.
 */
function renderActors(projectId: ProjectId, directory: ActorDirectory): string {
  if (directory.actors.length === 0 && directory.roles.length === 0) {
    return `No actors or roles in project ${projectId}.`
  }
  const lines = [
    `Project ${projectId} — actors, ${directory.actors.length}:`,
    ...directory.actors.map((actor) => {
      const external = actor.externalIdentity === undefined ? '' : ` — external ${actor.externalIdentity}`
      return `- ${actor.actorKey} (${actor.actorKind}) ${actor.status} — ${actor.displayName}${external}`
    }),
    `roles, ${directory.roles.length}:`,
    ...directory.roles.map((role) => {
      const described = role.description === undefined ? '' : ` — ${role.description}`
      return `- ${role.roleName} (${role.roleKind})${described}`
    }),
    `assignments, ${directory.assignments.length}:`,
    ...directory.assignments.map(assignment =>
      `- ${assignment.actorKey} holds ${assignment.roleName} since `
        + new Date(assignment.validFromMs).toISOString()),
  ]
  return lines.join('\n')
}

/**
 * Render the project's work assignments as command output: one line per
 * assignment with its item, actor, role, and duty labels.
 * @param projectId - the project whose assignments are listed.
 * @param assignments - the listed assignments, newest-first.
 * @returns the multi-line command text.
 */
function renderAssignments(projectId: ProjectId, assignments: readonly WorkAssignment[]): string {
  if (assignments.length === 0) {
    return `No work assignments in project ${projectId}.`
  }
  const lines = [
    `Project ${projectId} — work assignments, ${assignments.length}:`,
    ...assignments.map((assignment) => {
      const role = assignment.roleName === undefined ? '' : ` as ${assignment.roleName}`
      return `- ${assignment.actorKey} ${assignment.assignmentKind} on ${assignment.stableKey}${role} `
        + `(${assignment.status}) since ${new Date(assignment.assignedAtMs).toISOString()}`
    }),
  ]
  return lines.join('\n')
}

/**
 * Render the project's recorded handoffs as command output: one line per
 * handoff with its sender, recipient, kind, item, and summary.
 * @param projectId - the project whose handoffs are listed.
 * @param handoffs - the listed handoffs, newest-first.
 * @returns the multi-line command text.
 */
function renderHandoffs(projectId: ProjectId, handoffs: readonly Handoff[]): string {
  if (handoffs.length === 0) {
    return `No handoffs in project ${projectId}.`
  }
  const lines = [
    `Project ${projectId} — handoffs, ${handoffs.length}:`,
    ...handoffs.map((handoff) => {
      const recipient = handoff.toActorKey === undefined ? `role ${handoff.toRoleName}` : handoff.toActorKey
      return `- ${handoff.fromActorKey} handed to ${recipient} (${handoff.handoffKind}) on ${handoff.stableKey} `
        + `— ${handoff.summary} at ${new Date(handoff.recordedAtMs).toISOString()}`
    }),
  ]
  return lines.join('\n')
}

/**
 * Render the project's scope reservations as command output: one line per
 * reservation with its actor, scope, item, and lifecycle.
 * @param projectId - the project whose reservations are listed.
 * @param reservations - the listed reservations, newest-first.
 * @returns the multi-line command text.
 */
function renderReservations(projectId: ProjectId, reservations: readonly ScopeReservation[]): string {
  if (reservations.length === 0) {
    return `No scope reservations in project ${projectId}.`
  }
  const lines = [
    `Project ${projectId} — scope reservations, ${reservations.length}:`,
    ...reservations.map((reservation) => {
      const lifecycle = reservation.status === 'ACTIVE'
        ? `expires ${new Date(reservation.expiresAtMs).toISOString()}`
        : reservation.releasedAtMs === undefined
          ? 'expired'
          : `released at ${new Date(reservation.releasedAtMs).toISOString()}`
      return `- ${reservation.actorKey} holds ${reservation.scopeKind} "${reservation.scopeValue}" `
        + `on ${reservation.stableKey} — ${lifecycle}`
    }),
  ]
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
      case 'history': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        const history = readWorkItemHistory(db, projectId, command.itemRef)
        if (history === undefined) {
          throw new ProjectResolutionError(
            `No work item "${command.itemRef}" in project ${projectId}. Name a stable key or full id.`,
          )
        }
        return { kind: 'success', text: renderItemHistory(history) }
      }
      case 'replay': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderReplayReport(readProjectReplay(db, projectId)) }
      }
      case 'digest': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderDigest(readProjectDigest(db, projectId)) }
      }
      case 'export': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderEvidenceExport(readProjectDigest(db, projectId)) }
      }
      case 'decisions': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderDecisions(projectId, readProjectDecisions(db, projectId)) }
      }
      case 'approvals': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderApprovals(projectId, readProjectApprovals(db, projectId)) }
      }
      case 'resources': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderResources(projectId, readProjectResources(db, projectId)) }
      }
      case 'actors': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderActors(projectId, readProjectActors(db, projectId)) }
      }
      case 'assignments': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderAssignments(projectId, readProjectWorkAssignments(db, projectId)) }
      }
      case 'handoffs': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderHandoffs(projectId, readProjectHandoffs(db, projectId)) }
      }
      case 'reservations': {
        const projectId = resolveProjectId(listPlans(db), command.projectId)
        return { kind: 'success', text: renderReservations(projectId, readProjectScopeReservations(db, projectId)) }
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
    input: { hint: PROJECT_INPUT_HINT },
    handler: invocation => runProjectCommand(ctx, invocation.rawInput),
  }))
}
