/** The mini profile's Project Ledger provider: open, serve, and close. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  compilePlan,
  importPlanVersion,
  parsePlanDocument,
  replayProjectEvents,
  validatePlanSchema,
  type CompiledPlan,
  type ProjectId,
} from '@deepseek-ai/dsh-experimental-project-ledger'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import MiniProjectLedger from '../src/index.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GOLDEN_PLAN_TEXT = new TextDecoder('utf8').decode(
  readFileSync(`${REPO_ROOT}/docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml`),
)

/** Compile the golden plan document. */
function compileGolden(): CompiledPlan {
  const { value } = parsePlanDocument(GOLDEN_PLAN_TEXT)
  return compilePlan(validatePlanSchema(value), { sourceText: GOLDEN_PLAN_TEXT })
}

describe('MiniProjectLedger', () => {
  it('opens a fail-closed ledger at the configured path and closes it on disposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mini-'))
    try {
      const ctx = new Context()
      const fiber = await ctx.plugin(MiniProjectLedger, { ledgerPath: join(root, 'nested', 'ledger.sqlite') })
      try {
        const service = ctx.projectLedger
        expect(service.ledgerPath).toBe(join(root, 'nested', 'ledger.sqlite'))
        // A migrated, stamped ledger answers reads through the raw handle.
        expect(service.db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toEqual({ n: 0 })

        // The mounted capability serves the ledger seam against its handle.
        const result = importPlanVersion(service.db, compileGolden())
        expect(result.planVersionId).toBe('plv:mini-dsh-v1.6a-ledger:v1')
        const replayed = replayProjectEvents(service.db, brandString<ProjectId>('mini-dsh'))
        expect(replayed.workItems.size).toBe(15)
      } finally {
        await fiber.dispose()
      }
      // The provider owns the lifecycle: the handle is closed after disposal.
      expect(() => ctx.projectLedger.db.prepare('SELECT 1').get()).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('honors the busyTimeoutMs override from config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-mini-'))
    try {
      const ctx = new Context()
      const fiber = await ctx.plugin(MiniProjectLedger, {
        ledgerPath: join(root, 'ledger.sqlite'),
        busyTimeoutMs: 1234,
      })
      try {
        const row = ctx.projectLedger.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
        expect(row.timeout).toBe(1234)
      } finally {
        await fiber.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the load when the config names no ledger path', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(MiniProjectLedger, { ledgerPath: undefined as unknown as string }))
      .rejects.toThrow()
  })
})
