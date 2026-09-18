/**
 * The error type every project ledger database failure throws.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger-sqlite/errors
 */

/** Failure kinds the ledger database layer reports. */
export type ProjectLedgerErrorCode =
  | 'version-mismatch'
  | 'invalid-argument'

/** A project ledger database failure, carrying a stable machine-readable code. */
export class ProjectLedgerError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ProjectLedgerErrorCode

  /**
   * Build a ledger database error.
   * @param code - stable failure kind for programmatic handling.
   * @param message - human-readable failure description.
   */
  constructor(code: ProjectLedgerErrorCode, message: string) {
    super(message)
    this.name = 'ProjectLedgerError'
    this.code = code
  }
}
