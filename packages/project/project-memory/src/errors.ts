/**
 * The error type every project-memory failure throws.
 *
 * @module @deepseek-ai/dsh-project-memory/errors
 */

/** Failure kinds the store reports. */
export type ProjectMemoryErrorCode =
  | 'version-mismatch'
  | 'closed'
  | 'not-found'
  | 'invalid-argument'

/** A project memory store failure, carrying a stable machine-readable code. */
export class ProjectMemoryError extends Error {
  /** Stable failure kind for programmatic handling. */
  readonly code: ProjectMemoryErrorCode

  /**
   * Build a store error.
   * @param code - stable failure kind for programmatic handling.
   * @param message - human-readable failure description.
   */
  constructor(code: ProjectMemoryErrorCode, message: string) {
    super(message)
    this.name = 'ProjectMemoryError'
    this.code = code
  }
}
