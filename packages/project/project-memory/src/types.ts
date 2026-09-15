/**
 * Type-only surface of the project memory store: branded ids, row shapes,
 * insert inputs, and the controlled vocabularies stored in the schema's
 * CHECK constraints. No runtime code lives here.
 *
 * Ids are opaque strings at the SQLite boundary and branded in TypeScript so
 * a {@link FileId} cannot be passed where a {@link SymbolVersionId} is
 * expected; see `ids.ts` for the brand constructors and id allocation.
 *
 * @module @deepseek-ai/dsh-project-memory/types
 */

import type {
  AnalysisUnitId,
  CallSiteId,
  ContentId,
  DocumentHeadingId,
  FileId,
  ImportId,
  MemoryId,
  ProjectObjectId,
  RepositoryId,
  SnapshotId,
  SymbolId,
  SymbolReferenceId,
  SymbolVersionId,
} from './ids.ts'

/** How a snapshot was captured. */
export type SnapshotKind = 'pinned' | 'head' | 'worktree'

/** Declared kind of a symbol, as extracted from source. */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'enum_member'
  | 'property'
  | 'getter'
  | 'setter'
  | 'variable'

/** How a recorded call site's callee was determined. */
export type CallResolution = 'resolved' | 'unresolved' | 'external' | 'dynamic'

/** Which extractor pass produced a fact. */
export type ExtractionLevel = 'syntactic' | 'typechecker'

/** Kind of a non-call symbol reference. */
export type ReferenceKind = 'type' | 'import'

/** Node kind in the `project_objects` tree. */
export type ProjectObjectKind = 'workspace' | 'package_group' | 'package' | 'directory' | 'file' | 'symbol'

/** Lifecycle status of a memory row. */
export type MemoryStatus = 'active' | 'retired'

/** Lifecycle status of an analysis unit. */
export type AnalysisUnitStatus = 'open' | 'answered' | 'abandoned'

/** Kind of an analysis unit. */
export type AnalysisUnitKind = 'question' | 'area' | 'task'

/** A row of `repositories`. */
export interface RepositoryRow {
  readonly id: RepositoryId
  readonly slug: string
  readonly url: string | undefined
  readonly localPath: string | undefined
  readonly defaultBranch: string | undefined
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/** A row of `repo_snapshots`. */
export interface SnapshotRow {
  readonly id: SnapshotId
  readonly repositoryId: RepositoryId
  readonly snapshotKind: SnapshotKind
  readonly commitSha: string | undefined
  readonly dirty: boolean
  readonly capturedAtMs: number
}

/** A row of `files`. */
export interface FileRow {
  readonly id: FileId
  readonly snapshotId: SnapshotId
  readonly path: string
  readonly language: string
  readonly byteLength: number
  readonly contentId: ContentId | undefined
}

/** A row of `symbols` (identity only; facts live on symbol versions). */
export interface SymbolRow {
  readonly id: SymbolId
  readonly repositoryId: RepositoryId
  readonly stableKey: string
}

/** A row of `symbol_versions`. */
export interface SymbolVersionRow {
  readonly id: SymbolVersionId
  readonly symbolId: SymbolId
  readonly snapshotId: SnapshotId
  readonly fileId: FileId
  readonly name: string
  readonly qualifiedName: string
  readonly symbolKind: SymbolKind
  readonly startLine: number
  readonly endLine: number
  readonly signatureText: string
  readonly isExported: boolean
  readonly isAsync: boolean
  readonly isStatic: boolean
  readonly extractionLevel: ExtractionLevel
}

/** A row of `imports`. */
export interface ImportRow {
  readonly id: ImportId
  readonly fileId: FileId
  readonly moduleSpecifier: string
  readonly isTypeOnly: boolean
  readonly line: number
}

/** A row of `call_sites`. */
export interface CallSiteRow {
  readonly id: CallSiteId
  readonly snapshotId: SnapshotId
  readonly fileId: FileId
  readonly line: number
  readonly column: number
  readonly callerSymbolVersionId: SymbolVersionId | undefined
  readonly calleeName: string
  readonly calleeSymbolVersionId: SymbolVersionId | undefined
  readonly resolution: CallResolution
  readonly extractionLevel: ExtractionLevel
}

/** A row of `symbol_references`. */
export interface SymbolReferenceRow {
  readonly id: SymbolReferenceId
  readonly snapshotId: SnapshotId
  readonly fileId: FileId
  readonly line: number
  readonly referencingSymbolVersionId: SymbolVersionId | undefined
  readonly referencedSymbolVersionId: SymbolVersionId
  readonly referenceKind: ReferenceKind
}

/** A row of `project_objects`. */
export interface ProjectObjectRow {
  readonly id: ProjectObjectId
  readonly repositoryId: RepositoryId
  readonly snapshotId: SnapshotId
  readonly objectKind: ProjectObjectKind
  readonly stableKey: string
  readonly name: string
  readonly parentId: ProjectObjectId | undefined
  readonly symbolVersionId: SymbolVersionId | undefined
}

/** A row of `document_headings` — one ATX heading of an indexed document. */
export interface DocumentHeadingRow {
  readonly id: DocumentHeadingId
  readonly fileId: FileId
  readonly level: number
  readonly line: number
  readonly text: string
}

/** Input for one document-heading row. */
export interface InsertDocumentHeadingInput {
  readonly fileId: FileId
  readonly level: number
  readonly line: number
  readonly text: string
}

/** A row of `memories`. */
export interface MemoryRow {
  readonly id: MemoryId
  readonly repositoryId: RepositoryId
  readonly snapshotId: SnapshotId | undefined
  readonly scope: string
  readonly contentId: ContentId
  readonly status: MemoryStatus
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/** A row of `analysis_units`. */
export interface AnalysisUnitRow {
  readonly id: AnalysisUnitId
  readonly repositoryId: RepositoryId
  readonly unitKind: AnalysisUnitKind
  readonly title: string
  readonly questionContentId: ContentId | undefined
  readonly status: AnalysisUnitStatus
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/** A row of `memory_evidence`. */
export interface MemoryEvidenceRow {
  readonly id: string
  readonly memoryId: MemoryId
  readonly snapshotId: SnapshotId | undefined
  readonly fileId: FileId | undefined
  readonly symbolVersionId: SymbolVersionId | undefined
  readonly lineStart: number | undefined
  readonly lineEnd: number | undefined
  readonly quoteContentId: ContentId | undefined
}

/** A row of `analysis_history`. */
export interface AnalysisHistoryRow {
  readonly id: string
  readonly unitId: AnalysisUnitId
  readonly event: string
  readonly detailContentId: ContentId | undefined
  readonly createdAtMs: number
}

/** A row of `run_events`. */
export interface RunEventRow {
  readonly id: string
  readonly repositoryId: RepositoryId
  readonly eventKind: string
  readonly payloadContentId: ContentId | undefined
  readonly createdAtMs: number
}

/** Input for {@link RepositoryRow} registration; `slug` identifies the repository. */
export interface UpsertRepositoryInput {
  readonly slug: string
  readonly url?: string | undefined
  readonly localPath?: string | undefined
  readonly defaultBranch?: string | undefined
}

/** Input for one snapshot capture. */
export interface InsertSnapshotInput {
  readonly repositoryId: RepositoryId
  readonly snapshotKind: SnapshotKind
  readonly commitSha?: string | undefined
  readonly dirty?: boolean | undefined
}

/** Input for one indexed file. */
export interface InsertFileInput {
  readonly snapshotId: SnapshotId
  readonly path: string
  readonly language: string
  readonly byteLength: number
  readonly contentId?: ContentId | undefined
}

/** Input for one symbol-version fact row. */
export interface InsertSymbolVersionInput {
  readonly symbolId: SymbolId
  readonly snapshotId: SnapshotId
  readonly fileId: FileId
  readonly name: string
  readonly qualifiedName: string
  readonly symbolKind: SymbolKind
  readonly startLine: number
  readonly endLine: number
  readonly signatureText: string
  readonly isExported: boolean
  readonly isAsync: boolean
  readonly isStatic: boolean
  readonly extractionLevel: ExtractionLevel
}

/** Input for one import row. */
export interface InsertImportInput {
  readonly fileId: FileId
  readonly moduleSpecifier: string
  readonly isTypeOnly: boolean
  readonly line: number
}

/** Input for one call-site row. */
export interface InsertCallSiteInput {
  readonly snapshotId: SnapshotId
  readonly fileId: FileId
  readonly line: number
  readonly column: number
  readonly callerSymbolVersionId?: SymbolVersionId | undefined
  readonly calleeName: string
  readonly calleeSymbolVersionId?: SymbolVersionId | undefined
  readonly resolution: CallResolution
  readonly extractionLevel: ExtractionLevel
}

/** Input for one symbol-reference row. */
export interface InsertSymbolReferenceInput {
  readonly snapshotId: SnapshotId
  readonly fileId: FileId
  readonly line: number
  readonly referencingSymbolVersionId?: SymbolVersionId | undefined
  readonly referencedSymbolVersionId: SymbolVersionId
  readonly referenceKind: ReferenceKind
}

/** Input for one project-object row. */
export interface InsertProjectObjectInput {
  readonly repositoryId: RepositoryId
  readonly snapshotId: SnapshotId
  readonly objectKind: ProjectObjectKind
  readonly stableKey: string
  readonly name: string
  readonly parentId?: ProjectObjectId | undefined
  readonly symbolVersionId?: SymbolVersionId | undefined
}

/** Input for one memory row. */
export interface InsertMemoryInput {
  readonly repositoryId: RepositoryId
  readonly snapshotId?: SnapshotId | undefined
  readonly scope: string
  readonly content: string
  readonly status?: MemoryStatus | undefined
}

/** Input for one memory-evidence row. */
export interface InsertMemoryEvidenceInput {
  readonly memoryId: MemoryId
  readonly snapshotId?: SnapshotId | undefined
  readonly fileId?: FileId | undefined
  readonly symbolVersionId?: SymbolVersionId | undefined
  readonly lineStart?: number | undefined
  readonly lineEnd?: number | undefined
  readonly quote?: string | undefined
}

/** Input for one analysis-unit row. */
export interface InsertAnalysisUnitInput {
  readonly repositoryId: RepositoryId
  readonly unitKind: AnalysisUnitKind
  readonly title: string
  readonly question?: string | undefined
  readonly status?: AnalysisUnitStatus | undefined
}

/** Aggregated counts describing one indexed snapshot. */
export interface SnapshotStats {
  readonly files: number
  readonly documents: number
  readonly documentHeadings: number
  readonly symbols: number
  readonly callSites: number
  readonly resolvedCalls: number
  readonly externalCalls: number
  readonly unresolvedCalls: number
  readonly dynamicCalls: number
  readonly projectObjects: number
}
