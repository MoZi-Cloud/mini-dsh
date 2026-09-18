/**
 * The ledger's plan directory (v1.6a §5): the read seam that lists which
 * plans a database records and which plan version each names as current.
 * A caller that needs "the project" or "the version to inspect" resolves
 * it through this listing instead of re-owning `plans`-table semantics.
 * The directory only reads — writes to `plans` stay with import (row
 * creation) and supersede (the current-version pointer).
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger/plan-directory
 */

import type { DatabaseSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PlanId, PlanVersionId, ProjectId } from './plan-compile.js'

/** One `plans` row as the directory lists it. */
export interface PlanDirectoryEntry {
  /** Ledger id of the plan. */
  readonly planId: PlanId
  /** The project the plan belongs to. */
  readonly projectId: ProjectId
  /** Human-readable plan name. */
  readonly name: string
  /** The plan version named as current, or `null` while none is named. */
  readonly currentVersionId: PlanVersionId | null
}

/**
 * List every plan the ledger records with its current-version pointer,
 * ordered by project then plan id for a stable display.
 * @param db - open ledger database.
 * @returns one entry per `plans` row; empty exactly when no plan is recorded.
 */
export function listPlans(db: DatabaseSync): readonly PlanDirectoryEntry[] {
  const rows = db.prepare(
    'SELECT id, project_id, name, current_version_id FROM plans ORDER BY project_id, id',
  ).all() as { id: string; project_id: string; name: string; current_version_id: string | null }[]
  return rows.map(row => ({
    planId: brandString<PlanId>(row.id),
    projectId: brandString<ProjectId>(row.project_id),
    name: row.name,
    currentVersionId: row.current_version_id === null
      ? null
      : brandString<PlanVersionId>(row.current_version_id),
  }))
}
