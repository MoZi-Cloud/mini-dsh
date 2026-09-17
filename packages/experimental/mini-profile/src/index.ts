/**
 * The mini profile's Project Ledger provider (v1.6a §4/§5.4): one service
 * that owns the opened ledger database for a `dsh --profile mini` process.
 * The database opens through the SQLite store's fail-closed open — a version
 * newer than this build refuses rather than downgrades — and closes when the
 * plugin unloads. Consumers call the `dsh-experimental-project-ledger` seam
 * functions against the exposed handle; this plugin owns identity, open
 * order, configuration, and lifecycle, never ledger semantics, and nothing
 * here executes a verifier command or activates a plan.
 *
 * @module @deepseek-ai/dsh-experimental-mini-profile
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import type { DatabaseSync } from 'node:sqlite'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'mini-project-ledger'

/** Plugin config: where the ledger lives and how long writes wait. */
export interface Config {
  /**
   * Path of the ledger database file. The mini patch resolves it from
   * `DSH_MINI_LEDGER_PATH` with a dsh-home fallback, and a profile's
   * cordis.patch.yml may pin any path; an empty value fails the load.
   */
  readonly ledgerPath: string
  /** Milliseconds a write waits on a competing writer; omitted keeps the store default. */
  readonly busyTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  ledgerPath: z.string().required(),
  busyTimeoutMs: z.number(),
})

/** The mounted Project Ledger capability, exposed as `ctx.projectLedger`. */
export class MiniProjectLedger extends Service {
  static Config: z<Config> = Config

  /** The resolved ledger path this process owns. */
  readonly ledgerPath: string
  /** The optional write-wait override handed to the store's open. */
  readonly busyTimeoutMs: number | undefined

  /** The opened ledger handle; assigned during {@link Service.init} before availability. */
  db!: DatabaseSync

  constructor(ctx: Context, config: Config) {
    super(ctx, 'projectLedger')
    // Schemastery validated and narrowed the config before construction.
    const validated = config as Required<Config> & { busyTimeoutMs?: number }
    this.ledgerPath = validated.ledgerPath
    this.busyTimeoutMs = validated.busyTimeoutMs
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    const db = await openProjectLedgerDatabase(
      this.ledgerPath,
      this.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.busyTimeoutMs },
    )
    this.db = db
    yield () => {
      db.close()
    }
  }
}

export default MiniProjectLedger

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mini profile's opened Project Ledger database. */
    projectLedger: MiniProjectLedger
  }
}
