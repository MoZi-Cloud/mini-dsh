/**
 * Id allocation, brand constructors, and the branded id types for the project
 * memory store.
 *
 * Row ids are opaque `<prefix>_<random-uuid>` strings allocated by the store;
 * content ids are deterministic `sha256:<hex>` digests of the stored UTF-8
 * text, so identical content dedupes to one row. Each branded type makes
 * structurally identical strings non-interchangeable at the type level.
 *
 * @module @deepseek-ai/dsh-project-memory/ids
 */

import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Content-addressed text row in the `contents` store. */
export type ContentId = Branded<'ContentId'>

/** One registered repository (git worktree or pinned source tree). */
export type RepositoryId = Branded<'RepositoryId'>

/** One capture of a repository's state (pinned SHA, HEAD, or dirty worktree). */
export type SnapshotId = Branded<'SnapshotId'>

/** One indexed source file inside a snapshot. */
export type FileId = Branded<'FileId'>

/** Stable symbol identity that survives across snapshots of one repository. */
export type SymbolId = Branded<'SymbolId'>

/** Per-snapshot facts for one symbol (location, signature, flags). */
export type SymbolVersionId = Branded<'SymbolVersionId'>

/** One recorded module import of an indexed file. */
export type ImportId = Branded<'ImportId'>

/** One call expression recorded in the call graph. */
export type CallSiteId = Branded<'CallSiteId'>

/** One non-call identifier reference (type or import) between symbols. */
export type SymbolReferenceId = Branded<'SymbolReferenceId'>

/** One observed source-reality object in the `project_objects` tree. */
export type ProjectObjectId = Branded<'ProjectObjectId'>

/** One durable memory statement with optional source evidence. */
export type MemoryId = Branded<'MemoryId'>

/** One analysis unit (a research question, area, or task). */
export type AnalysisUnitId = Branded<'AnalysisUnitId'>

/** One recorded heading of an indexed document. */
export type DocumentHeadingId = Branded<'DocumentHeadingId'>

/**
 * Allocate an opaque row id under a table prefix.
 * @param prefix - short table prefix such as `snap` or `call`.
 * @returns a fresh unique id string.
 */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/** Allocate a repository row id. @returns the branded row id. */
export function RepositoryId(): RepositoryId {
  return brandString<RepositoryId>(newId('repo'))
}

/** Allocate a snapshot row id. @returns the branded row id. */
export function SnapshotId(): SnapshotId {
  return brandString<SnapshotId>(newId('snap'))
}

/** Allocate a file row id. @returns the branded row id. */
export function FileId(): FileId {
  return brandString<FileId>(newId('file'))
}

/** Allocate a symbol identity row id. @returns the branded row id. */
export function SymbolId(): SymbolId {
  return brandString<SymbolId>(newId('symb'))
}

/** Allocate a symbol-version row id. @returns the branded row id. */
export function SymbolVersionId(): SymbolVersionId {
  return brandString<SymbolVersionId>(newId('sv'))
}

/** Allocate an import row id. @returns the branded row id. */
export function ImportId(): ImportId {
  return brandString<ImportId>(newId('imp'))
}

/** Allocate a call-site row id. @returns the branded row id. */
export function CallSiteId(): CallSiteId {
  return brandString<CallSiteId>(newId('call'))
}

/** Allocate a symbol-reference row id. @returns the branded row id. */
export function SymbolReferenceId(): SymbolReferenceId {
  return brandString<SymbolReferenceId>(newId('sref'))
}

/** Allocate a project-object row id. @returns the branded row id. */
export function ProjectObjectId(): ProjectObjectId {
  return brandString<ProjectObjectId>(newId('pobj'))
}

/** Allocate a memory row id. @returns the branded row id. */
export function MemoryId(): MemoryId {
  return brandString<MemoryId>(newId('memo'))
}

/** Allocate a document-heading row id. @returns the branded row id. */
export function DocumentHeadingId(): DocumentHeadingId {
  return brandString<DocumentHeadingId>(newId('head'))
}

/** Allocate an analysis-unit row id. @returns the branded row id. */
export function AnalysisUnitId(): AnalysisUnitId {
  return brandString<AnalysisUnitId>(newId('unit'))
}

/**
 * Compute the deterministic content id for stored text: the `sha256:`
 * prefixed hex digest of the UTF-8 bytes.
 * @param text - the exact text that will be stored in `contents`.
 * @returns the content id for the text.
 */
export function contentId(text: string): ContentId {
  return brandString<ContentId>(`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`)
}
