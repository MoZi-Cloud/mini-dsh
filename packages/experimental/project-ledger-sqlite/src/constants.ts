/**
 * Identity constants of the project ledger: the physical schema version
 * stamped into `PRAGMA user_version` and the event envelope version written
 * into every `project_events` row.
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

/**
 * The event envelope version recorded in the `event_format_version` column
 * of every `project_events` row. Required-event additions bump it together
 * with the event codec; purely observational events must not.
 */
export const PROJECT_EVENT_FORMAT_VERSION = 1
