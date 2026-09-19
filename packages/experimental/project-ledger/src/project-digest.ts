/**
 * The ledger's owner evidence digest: one read-only pass that aggregates the
 * evidence the other read seams expose one slice at a time into a
 * whole-project summary — the plans with every version's lifecycle status and
 * pinned baseline, every work item's completion over its acceptance criteria
 * (each criterion with its latest evaluation, the attempts before it
 * collapsed away), and the replay audit verdict over the same database. The
 * digest reports recorded facts; it never mutates, never executes a verifier
 * command, and never decides acceptance.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/project-digest
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PlanId, PlanVersionId, ProjectId, WorkItemId } from './plan-compile.js'
import type { PlanWorkItemStatus } from './plan-document.js'
import { readProjectReplay, type ProjectReplayReport } from './project-replay.js'
import type { PlanVersionStatus } from './versioning.js'
import {
  latestEvaluationPerCriterion,
  reviewedCriterionOf,
  type CriterionRecord,
  type EvaluationRecord,
  type ReviewedCriterion,
} from './work-item-review.js'

/** One plan version the digest lists, in version order. */
export interface DigestPlanVersion {
  /** Ledger id of the plan version. */
  readonly versionId: PlanVersionId
  /** Version number within its plan. */
  readonly versionNo: number
  /** Lifecycle status of the version (`DRAFT`, `ACTIVE`, `SUPERSEDED`, ...). */
  readonly status: PlanVersionStatus
  /** Pinned repository head of the version's baseline, or `null` when the version pinned none. */
  readonly baselineRepoHead: string | null
  /** Wall-clock stamp of the version row's creation. */
  readonly createdAtMs: number
  /** Wall-clock stamp of the version's activation, or `null` while never activated. */
  readonly activatedAtMs: number | null
  /** Wall-clock stamp of the version's supersede, or `null` while current. */
  readonly supersededAtMs: number | null
}

/** One plan of the project with every version the ledger records for it. */
export interface DigestPlan {
  /** Ledger id of the plan. */
  readonly planId: PlanId
  /** Human-readable plan name. */
  readonly planName: string
  /** Version the plan's `current_version_id` names, or `null` when it names none. */
  readonly currentVersionId: PlanVersionId | null
  /** The plan's versions in version order. */
  readonly versions: readonly DigestPlanVersion[]
}

/** One work item's digest row: identity and status over its acceptance criteria. */
export interface DigestItem {
  /** Ledger id of the work item. */
  readonly workItemId: WorkItemId
  /** Stable key of the item within its project. */
  readonly stableKey: string
  /** Human-readable title. */
  readonly title: string
  /** Projection status of the item. */
  readonly status: PlanWorkItemStatus
  /** Executor separation label (`AGENT`, `OWNER`, ...). */
  readonly executorKind: string
  /** Priority ordering value. */
  readonly priority: number
  /** Plan version the item belongs to, or `null` for a backlog item. */
  readonly planVersionId: PlanVersionId | null
  /** The item's acceptance criteria in ordinal order, each over its latest evaluation. */
  readonly criteria: readonly ReviewedCriterion[]
  /** Wall clock of the item's newest recorded evaluation, or `null` while none was recorded. */
  readonly lastEvaluatedAtMs: number | null
}

/** The owner evidence digest of one project. */
export interface ProjectDigest {
  /** Project whose evidence is digested. */
  readonly projectId: ProjectId
  /** The project's plans in id order. */
  readonly plans: readonly DigestPlan[]
  /** The project's work items in stable-key order. */
  readonly items: readonly DigestItem[]
  /** The replay audit verdict over the same database. */
  readonly replay: ProjectReplayReport
}

/** One `acceptance_criteria` row the digest reads, in select order. */
interface CriterionRow extends CriterionRecord {
  readonly work_item_id: string
}

/** One `acceptance_evaluations` row the digest reads, in select order. */
interface EvaluationRow extends EvaluationRecord {
  readonly work_item_id: string
}

/**
 * Read one project's owner evidence digest: the plans with every version's
 * lifecycle status and baseline, every work item's completion over its
 * criteria with the latest verdict counts, and the replay audit verdict.
 * @param db - open ledger database.
 * @param projectId - project whose evidence is digested; the caller resolves the id (the plan directory lists projects).
 * @returns the digest; a project the ledger records no plan for reads as empty plans, empty items, and a clean empty audit.
 */
export function readProjectDigest(db: DatabaseSync, projectId: ProjectId): ProjectDigest {
  const planRows = db.prepare('SELECT id, name, current_version_id FROM plans WHERE project_id = ? ORDER BY id')
    .all(projectId) as unknown as { id: string; name: string; current_version_id: string | null }[]
  const versionRows = db.prepare(
    'SELECT plan_id, id, version_no, status, baseline_repo_head, created_at_ms, activated_at_ms, superseded_at_ms '
      + 'FROM plan_versions WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?) ORDER BY plan_id, version_no',
  ).all(projectId) as unknown as {
    plan_id: string
    id: string
    version_no: number
    status: PlanVersionStatus
    baseline_repo_head: string | null
    created_at_ms: number
    activated_at_ms: number | null
    superseded_at_ms: number | null
  }[]
  const versionsByPlan = new Map<string, DigestPlanVersion[]>()
  for (const row of versionRows) {
    const version: DigestPlanVersion = {
      versionId: brandString<PlanVersionId>(row.id),
      versionNo: row.version_no,
      status: row.status,
      baselineRepoHead: row.baseline_repo_head,
      createdAtMs: row.created_at_ms,
      activatedAtMs: row.activated_at_ms,
      supersededAtMs: row.superseded_at_ms,
    }
    entryOf(versionsByPlan, row.plan_id, () => [] as DigestPlanVersion[]).push(version)
  }
  const plans: DigestPlan[] = planRows.map(row => ({
    planId: brandString<PlanId>(row.id),
    planName: row.name,
    currentVersionId: row.current_version_id === null
      ? null
      : brandString<PlanVersionId>(row.current_version_id),
    versions: versionsByPlan.get(row.id) ?? [],
  }))
  const itemRows = db.prepare(
    'SELECT id, plan_version_id, stable_key, title, status, executor_kind, priority FROM work_items '
      + 'WHERE project_id = ? ORDER BY stable_key',
  ).all(projectId) as unknown as {
    id: string
    plan_version_id: string | null
    stable_key: string
    title: string
    status: PlanWorkItemStatus
    executor_kind: string
    priority: number
  }[]
  const criteriaByItem = new Map<string, CriterionRow[]>()
  for (const row of db.prepare(
    'SELECT c.work_item_id, c.id, c.criterion_kind, c.description, c.required, c.status FROM acceptance_criteria c '
      + 'JOIN work_items w ON w.id = c.work_item_id WHERE w.project_id = ? ORDER BY c.work_item_id, c.ordinal',
  ).all(projectId) as unknown as CriterionRow[]) {
    entryOf(criteriaByItem, row.work_item_id, () => [] as CriterionRow[]).push(row)
  }
  const evaluationRows = db.prepare(
    'SELECT e.criterion_id, e.work_item_id, e.result, e.observed_json, e.evaluated_by, e.evaluated_at_ms '
      + 'FROM acceptance_evaluations e JOIN work_items w ON w.id = e.work_item_id WHERE w.project_id = ? '
      + 'ORDER BY e.evaluated_at_ms DESC, e.rowid DESC',
  ).all(projectId) as unknown as EvaluationRow[]
  const latestByCriterion = latestEvaluationPerCriterion(evaluationRows)
  const lastEvidenceByItem = new Map<string, number>()
  for (const evaluation of latestByCriterion.values()) {
    // The newest-first stream makes this row the item's newest evaluation;
    // every later row of the bucket is an earlier attempt by construction.
    entryOf(lastEvidenceByItem, evaluation.work_item_id, () => evaluation.evaluated_at_ms)
  }
  const items: DigestItem[] = itemRows.map(row => ({
    workItemId: brandString<WorkItemId>(row.id),
    stableKey: row.stable_key,
    title: row.title,
    status: row.status,
    executorKind: row.executor_kind,
    priority: row.priority,
    planVersionId: row.plan_version_id === null ? null : brandString<PlanVersionId>(row.plan_version_id),
    criteria: (criteriaByItem.get(row.id) ?? []).map(
      criterion => reviewedCriterionOf(criterion, latestByCriterion),
    ),
    lastEvaluatedAtMs: lastEvidenceByItem.get(row.id) ?? null,
  }))
  return {
    projectId,
    plans,
    items,
    // The digest embeds the audit rather than paraphrasing it, so the owner
    // reads the same parity facts the replay seam reports.
    replay: readProjectReplay(db, projectId),
  }
}

/**
 * Read one map entry, creating and storing it first when absent.
 * @param map - the map to read through.
 * @param key - the entry to read.
 * @param make - constructs the missing entry exactly once.
 * @returns the stored entry for `key`.
 */
function entryOf<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const created = make()
  map.set(key, created)
  return created
}
