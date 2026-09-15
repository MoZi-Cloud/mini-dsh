/**
 * Bounded context retrieval over the project memory store: the Context-Light
 * primitive that turns a query into a token-budgeted text packet, plus the
 * deterministic token estimator the 4K context lane is defined against.
 *
 * The lane contract: every packet this module produces for a representative
 * query fits the reviewed budget constant below. Sections are added in
 * priority order until the budget is exhausted; what did not fit is reported
 * as elided, never silently truncated mid-section.
 *
 * @module @deepseek-ai/dsh-project-memory/context-packet
 */

import { ProjectMemoryError } from './errors.ts'
import type { SnapshotId, SymbolVersionId } from './ids.ts'
import type { ProjectMemory } from './store.ts'

/**
 * The reviewed 4K context-lane budget, in estimated tokens. This is a source
 * constant: it cannot be raised from the environment, and widening it to 8K
 * is a reviewed decision, not a configuration change.
 */
export const CONTEXT_LANE_TOKEN_BUDGET = 4096

/**
 * Estimate the token count of text. Deterministic: the UTF-8 byte length
 * divided by four, rounded up — a deliberately conservative approximation
 * for source code and identifiers (dense UTF-8 scripts such as CJK average
 * one token per three to four bytes, ASCII code slightly more), so a packet
 * that fits the estimate fits real tokenizers.
 * @param text - the text to measure.
 * @returns the estimated token count, at least `0`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

/** One titled block of packet text. */
export interface ContextSection {
  readonly title: string
  readonly body: string
}

/** A query the packet builder answers from stored snapshot facts. */
export type ContextQuery =
  | { readonly kind: 'symbol'; readonly snapshotId: SnapshotId; readonly name: string }
  | { readonly kind: 'callers'; readonly snapshotId: SnapshotId; readonly callee: SymbolVersionId }
  | { readonly kind: 'callees'; readonly snapshotId: SnapshotId; readonly caller: SymbolVersionId }

/** A budgeted answer to one {@link ContextQuery}. */
export interface ContextPacket {
  readonly query: ContextQuery
  readonly text: string
  readonly tokenEstimate: number
  readonly budget: number
  readonly overflow: boolean
  readonly includedSections: readonly string[]
  readonly elidedSections: readonly string[]
}

/**
 * Build a bounded context packet for one query.
 *
 * Sections are added in the store's deterministic order until the next
 * section would exceed the budget; remaining sections are reported as
 * elided. `overflow` is set only when even the packet header does not fit —
 * with the default budget this cannot happen for stored facts, and callers
 * treat `overflow` as a lane violation.
 * @param memory - the store to query.
 * @param query - the fact to retrieve.
 * @param budget - token budget; defaults to {@link CONTEXT_LANE_TOKEN_BUDGET}.
 * @returns the packet with its assembled text and section accounting.
 */
export function buildContextPacket(
  memory: ProjectMemory,
  query: ContextQuery,
  budget: number = CONTEXT_LANE_TOKEN_BUDGET,
): ContextPacket {
  const sections = sectionsFor(memory, query)
  const header = `context packet: ${query.kind} query on snapshot ${query.snapshotId}\n`
  const included: string[] = []
  const elided: string[] = []
  let text = header
  for (const section of sections) {
    const candidate = `${text}\n## ${section.title}\n${section.body}\n`
    if (estimateTokens(candidate) > budget) {
      elided.push(section.title)
      continue
    }
    text = candidate
    included.push(section.title)
  }
  const overflow = estimateTokens(text) > budget
  return {
    query,
    text,
    tokenEstimate: estimateTokens(text),
    budget,
    overflow,
    includedSections: included,
    elidedSections: elided,
  }
}

function sectionsFor(memory: ProjectMemory, query: ContextQuery): ContextSection[] {
  switch (query.kind) {
    case 'symbol':
      return symbolSections(memory, query.snapshotId, query.name)
    case 'callers':
      return callerSections(memory, query.snapshotId, query.callee)
    case 'callees':
      return calleeSections(memory, query.snapshotId, query.caller)
  }
}

function symbolSections(memory: ProjectMemory, snapshotId: SnapshotId, name: string): ContextSection[] {
  const versions = memory.findSymbolVersionsByName(snapshotId, name)
  if (versions.length === 0) {
    throw new ProjectMemoryError('not-found', `no symbol named ${JSON.stringify(name)} in snapshot ${snapshotId}`)
  }
  return versions.map((version) => {
    const file = memory.getFile(version.fileId)
    return {
      title: `${version.qualifiedName} (${version.symbolKind})`,
      body: [
        `file: ${file === undefined ? '(missing file row)' : file.path}`,
        `lines: ${version.startLine}-${version.endLine}`,
        `signature: ${version.signatureText}`,
        `exported: ${version.isExported}${version.isAsync ? ', async' : ''}${version.isStatic ? ', static' : ''}`,
      ].join('\n'),
    }
  })
}

function callerSections(memory: ProjectMemory, snapshotId: SnapshotId, callee: SymbolVersionId): ContextSection[] {
  const sites = memory.callersOf(snapshotId, callee)
  return sites.map((site) => {
    const caller = site.callerSymbolVersionId === undefined ? undefined : memory.getSymbolVersion(site.callerSymbolVersionId)
    const file = memory.getFile(site.fileId)
    return {
      title: `call at ${file === undefined ? '(missing file row)' : file.path}:${site.line}`,
      body: [
        `caller: ${caller === undefined ? '(unresolved caller)' : caller.qualifiedName}`,
        `callee name: ${site.calleeName}`,
        `resolution: ${site.resolution}`,
      ].join('\n'),
    }
  })
}

function calleeSections(memory: ProjectMemory, snapshotId: SnapshotId, caller: SymbolVersionId): ContextSection[] {
  const sites = memory.calleesOf(snapshotId, caller)
  return sites.map((site) => {
    const callee = site.calleeSymbolVersionId === undefined ? undefined : memory.getSymbolVersion(site.calleeSymbolVersionId)
    return {
      title: `call ${site.calleeName} at line ${site.line}`,
      body: [
        `callee: ${callee === undefined ? site.calleeName : callee.qualifiedName}`,
        `resolution: ${site.resolution}`,
      ].join('\n'),
    }
  })
}
