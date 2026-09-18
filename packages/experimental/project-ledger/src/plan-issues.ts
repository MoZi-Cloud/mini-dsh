/**
 * Rejection type shared by plan parsing, schema validation, and semantic
 * validation. All three collect every independent issue before failing loud,
 * so an owner can fix a malformed plan in one pass.
 */

/** One-based line/column position in the decoded plan source text. */
export interface PlanSourcePosition {
  line: number
  column: number
}

/** Closed set of rejection reasons across parse, schema, and semantic passes. */
export type PlanIssueCode =
  // parse pass
  | 'yaml-syntax'
  | 'duplicate-key'
  | 'anchor-not-allowed'
  | 'alias-not-allowed'
  // schema pass
  | 'root-not-mapping'
  | 'schema-version-unsupported'
  | 'schema-invalid'
  // semantic pass
  | 'duplicate-phase-id'
  | 'duplicate-phase-ordinal'
  | 'duplicate-work-item-id'
  | 'duplicate-relation'
  | 'unknown-phase-reference'
  | 'unknown-parent-reference'
  | 'unknown-relation-reference'
  | 'hierarchy-cycle'
  | 'relation-cycle'
  | 'self-relation'
  | 'acceptance-verifier-kind-mismatch'
  // compile pass
  | 'duplicate-criterion-id'

/** One concrete rejection with its dotted document path and optional source position. */
export interface PlanIssue {
  code: PlanIssueCode
  message: string
  /** Dotted path to the offending value, e.g. `workItems[2].acceptance[0].verifier.command`. */
  path: string
  line?: number
  column?: number
}

/**
 * Thrown when a plan document is rejected. Carries every independent issue
 * found by the pass that rejected it; the message names the first issue.
 */
export class PlanDocumentError extends Error {
  /** Every issue found by the rejecting pass; never empty. */
  readonly issues: readonly PlanIssue[]

  /** @param issues - every issue found by the rejecting pass; never empty. */
  constructor(issues: readonly PlanIssue[]) {
    super(PlanDocumentError.summarize(issues))
    this.name = 'PlanDocumentError'
    this.issues = issues
  }

  private static summarize(issues: readonly PlanIssue[]): string {
    const first = issues[0]
    if (first === undefined) {
      return 'plan document rejected'
    }
    const location = first.line === undefined ? '' : ` (line ${first.line}, column ${first.column})`
    return `plan document rejected with ${issues.length} issue(s); first ${first.code} at ${first.path}${location}: ${first.message}`
  }
}

/**
 * Map a character offset in the decoded source text to a one-based
 * line/column position.
 * @param text - the decoded source text the offset refers to.
 * @param offset - character offset reported by the YAML parser, if any.
 * @returns the position, or `undefined` when the offset is out of range.
 */
export function positionAtOffset(text: string, offset: number | undefined): PlanSourcePosition | undefined {
  if (offset === undefined || offset < 0 || offset > text.length) {
    return undefined
  }
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}
