/**
 * Regenerate the pinned v1.6a Project Ledger fixtures (docs/mini/v1.6a §2):
 * `fixtures/project-ledger/v1.6a-empty.db` — a database at the current
 * schema version with no data, for open/migration/downgrade probes — and
 * `fixtures/project-ledger/v1.6a-populated.db` — the golden plan imported
 * with fixed stamps and one work item driven to DONE through the real
 * writers, so every ledger table carries rows. Both files are committed
 * artifacts; this script rewrites them and the populated fixture ends with
 * a doctor pass that must report zero issues (BOOT-01).
 *
 * Run from the repository root: `pnpm exec tsx scripts/gen-project-ledger-fixtures.ts`
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import {
  changeWorkStatus,
  claimWorkItem,
  compilePlan,
  evaluateAcceptanceCriterion,
  importPlanVersion,
  parsePlanDocument,
  planDoctor,
  validatePlanSchema,
  type AcceptanceCriterionId,
  type PlanVersionId,
  type WorkItemId,
} from '@deepseek-ai/dsh-experimental-project-ledger'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'fixtures/project-ledger')
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(resolve(ROOT, 'docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml')),
)

/** One fixed stamp base so regenerated fixtures carry identical row times. */
const BASE_MS = 1_750_000_000_000
const GOLDEN_VERSION = brandString<PlanVersionId>('plv:mini-dsh-v1.6a-ledger:v1')

async function writeEmpty(): Promise<void> {
  const path = resolve(OUT_DIR, 'v1.6a-empty.db')
  const db = await openProjectLedgerDatabase(path, { journalMode: 'delete' })
  db.close()
  process.stdout.write(`wrote ${path}\n`)
}

async function writePopulated(): Promise<void> {
  const path = resolve(OUT_DIR, 'v1.6a-populated.db')
  const db = await openProjectLedgerDatabase(path, { journalMode: 'delete' })
  try {
    const compiled = compilePlan(validatePlanSchema(parsePlanDocument(GOLDEN_PLAN_TEXT).value), {
      sourceText: GOLDEN_PLAN_TEXT,
    })
    importPlanVersion(db, compiled, { sourcePath: 'docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml', nowMs: BASE_MS })
    // The owner seam: v1.6a ships no activation writer, so the fixture
    // performs the owner's activation and phase opening directly.
    db.prepare('UPDATE plan_versions SET status = ?').run('ACTIVE')
    db.prepare('UPDATE phases SET status = ? WHERE stable_key = ?').run('ACTIVE', 'W01')
    // Real completions through every writer, so the replayed projection
    // equals the materialized rows and the doctor pass stays clean: first
    // the two BLOCKS sources, then the featured item.
    let step = 100
    for (const [stableKey, criterion] of [['OWNER-REVIEW-001', 'AC-OWNER-001'], ['PRE-001', 'AC-PRE-001']] as const) {
      claimWorkItem(db, brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`), 'fixtures/generator', {
        nowMs: BASE_MS + step,
        actorRef: 'fixtures/generator',
        leaseConfig: { ttlMs: 3_600_000, heartbeatIntervalMs: 600_000 },
      })
      changeWorkStatus(db, brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`), 'VERIFYING', {
        nowMs: BASE_MS + step + 10,
        actorRef: 'fixtures/generator',
      })
      evaluateAcceptanceCriterion(
        db,
        brandString<AcceptanceCriterionId>(`ac:wi:mini-dsh:${stableKey}:${criterion}`),
        'WAIVED',
        { nowMs: BASE_MS + step + 20, evaluatedBy: 'fixtures/generator', attemptRef: 'fixtures/v1.6a' },
      )
      changeWorkStatus(db, brandString<WorkItemId>(`wi:mini-dsh:${stableKey}`), 'DONE', {
        nowMs: BASE_MS + step + 30,
        actorRef: 'fixtures/generator',
      })
      step += 100
    }
    claimWorkItem(db, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'fixtures/generator', {
      nowMs: BASE_MS + step,
      actorRef: 'fixtures/generator',
      leaseConfig: { ttlMs: 3_600_000, heartbeatIntervalMs: 600_000 },
    })
    changeWorkStatus(db, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'VERIFYING', {
      nowMs: BASE_MS + step + 10,
      actorRef: 'fixtures/generator',
    })
    evaluateAcceptanceCriterion(
      db,
      brandString<AcceptanceCriterionId>('ac:wi:mini-dsh:SCHEMA-001:AC-SCHEMA-001'),
      'PASS',
      { nowMs: BASE_MS + step + 20, evaluatedBy: 'fixtures/generator', attemptRef: 'fixtures/v1.6a' },
    )
    changeWorkStatus(db, brandString<WorkItemId>('wi:mini-dsh:SCHEMA-001'), 'DONE', {
      nowMs: BASE_MS + step + 30,
      actorRef: 'fixtures/generator',
    })
    const report = planDoctor(db, GOLDEN_VERSION)
    if (report.issues.length > 0) {
      throw new Error(`populated fixture fails its doctor pass: ${JSON.stringify(report.issues)}`)
    }
    process.stdout.write(`wrote ${path} (doctor: 0 issues, events: ${String(report.counts.events)})\n`)
  } finally {
    db.close()
  }
}

mkdirSync(OUT_DIR, { recursive: true })
await writeEmpty()
await writePopulated()
