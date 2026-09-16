/**
 * Identity constants of the project ledger: the physical schema version
 * stamped into `PRAGMA user_version`. The event envelope version lives with
 * the event codec in `@deepseek-ai/dsh-experimental-project-ledger`.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger-sqlite/constants
 */

/**
 * The on-disk physical layout version, stored in `PRAGMA user_version`.
 * Bumped only on a breaking change to the table layout; databases on older
 * versions upgrade through the shipped adjacent migration steps, and any
 * version newer than this build rejects.
 */
export const PROJECT_LEDGER_SCHEMA_VERSION = 1
