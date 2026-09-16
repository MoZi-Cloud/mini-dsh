import { isAlias, isCollection, isScalar, parseDocument, visit } from 'yaml'
import { type PlanIssue, PlanDocumentError, positionAtOffset } from './plan-issues.js'

/**
 * Result of the strict YAML pass: the decoded source text (for later
 * position reporting) and the untyped parsed value (for schema validation).
 */
export interface ParsedPlanSource {
  /** UTF-8 decoded source with a leading byte-order mark removed. */
  readonly text: string
  /** The parsed YAML value; treat as untyped until `validatePlanSchema` passes. */
  readonly value: unknown
}

/**
 * Parse a plan document without interpreting it: YAML syntax, duplicate keys,
 * and the alias/anchor policy are enforced here with source positions.
 *
 * Parser policy for v1.6a: anchors and aliases are rejected outright. They are
 * the one YAML feature that can make two document paths share one mutable
 * object, and the ledger treats a plan document as inert data, so resolution
 * order must never be observable.
 *
 * This pass never interprets verifier fields and never executes anything.
 * @param source - UTF-8 bytes or an already-decoded string.
 * @returns the decoded text and the parsed value.
 * @throws {PlanDocumentError} with every parse issue and its source position.
 */
export function parsePlanDocument(source: string | Uint8Array): ParsedPlanSource {
  const text = decodeSource(source)
  const doc = parseDocument(text)
  const issues: PlanIssue[] = []
  for (const error of doc.errors) {
    const position = positionAtOffset(text, error.pos[0])
    issues.push({
      code: error.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'yaml-syntax',
      message: error.message,
      path: '$',
      ...(position ?? {}),
    })
  }
  issues.push(...collectPolicyIssues(doc, text))
  if (issues.length > 0) {
    throw new PlanDocumentError(issues)
  }
  return { text, value: doc.toJS() }
}

/** Collect every anchor and alias occurrence; both violate the v1.6a parser policy. */
function collectPolicyIssues(doc: ReturnType<typeof parseDocument>, text: string): PlanIssue[] {
  const issues: PlanIssue[] = []
  visit(doc, (_key, node) => {
    if (!isAlias(node) && !isScalar(node) && !isCollection(node)) {
      return
    }
    const located = positionAtOffset(text, node.range?.[0]) ?? {}
    if (isAlias(node)) {
      issues.push({
        code: 'alias-not-allowed',
        message: `alias '*${node.source}' is rejected by the plan parser policy; write the value out in full`,
        path: '$',
        ...located,
      })
      return
    }
    if (node.anchor !== undefined) {
      issues.push({
        code: 'anchor-not-allowed',
        message: `anchor '&${node.anchor}' is rejected by the plan parser policy; write the value out in full`,
        path: '$',
        ...located,
      })
    }
  })
  return issues
}

function decodeSource(source: string | Uint8Array): string {
  const decoded = typeof source === 'string' ? source : new TextDecoder('utf8').decode(source)
  return decoded.charCodeAt(0) === ByteOrderMark ? decoded.slice(1) : decoded
}

const ByteOrderMark = 0xfeff
