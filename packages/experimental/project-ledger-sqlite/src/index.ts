/**
 * The project ledger SQLite layer: identity constants, the fail-closed open
 * sequence for the Ledger Core database, and the shipped adjacent migration
 * steps (v1.6a W02).
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger-sqlite
 */

export { PROJECT_LEDGER_SCHEMA_VERSION } from './constants.ts'
export { ProjectLedgerError } from './errors.ts'
export type { ProjectLedgerErrorCode } from './errors.ts'
export {
  DEFAULT_LEDGER_BUSY_TIMEOUT_MS,
  PROJECT_LEDGER_MIGRATIONS,
  applyProjectLedgerMigrations,
  openProjectLedgerDatabase,
} from './schema.ts'
export type {
  OpenProjectLedgerDatabaseOptions,
  ProjectLedgerMigration,
  SchemaJournalMode,
} from './schema.ts'
