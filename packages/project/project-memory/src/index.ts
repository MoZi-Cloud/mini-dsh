/**
 * The project memory store: a SQLite source of truth for repository
 * intelligence — snapshots, symbols, call graphs, project objects, memories
 * with evidence, and analysis units — plus the bounded context-packet
 * retrieval the 4K context lane is defined against.
 *
 * @module @deepseek-ai/dsh-project-memory
 */

export { ProjectMemoryError } from './errors.ts'
export type { ProjectMemoryErrorCode } from './errors.ts'
export { PROJECT_MEMORY_SCHEMA_VERSION, openProjectMemoryDatabase } from './schema.ts'
export type { SchemaJournalMode } from './schema.ts'
export { ProjectMemory } from './store.ts'
export type { OpenProjectMemoryOptions } from './store.ts'
export { CONTEXT_LANE_TOKEN_BUDGET, buildContextPacket, estimateTokens } from './context-packet.ts'
export type { ContextPacket, ContextQuery, ContextSection } from './context-packet.ts'
export {
  AnalysisUnitId,
  CallSiteId,
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
  contentId,
} from './ids.ts'
export type {
  AnalysisHistoryRow,
  AnalysisUnitKind,
  DocumentHeadingRow,
  AnalysisUnitRow,
  AnalysisUnitStatus,
  CallResolution,
  CallSiteRow,
  ExtractionLevel,
  FileRow,
  ImportRow,
  InsertAnalysisUnitInput,
  InsertCallSiteInput,
  InsertDocumentHeadingInput,
  InsertFileInput,
  InsertImportInput,
  InsertMemoryEvidenceInput,
  InsertMemoryInput,
  InsertProjectObjectInput,
  InsertSnapshotInput,
  InsertSymbolReferenceInput,
  InsertSymbolVersionInput,
  MemoryEvidenceRow,
  MemoryRow,
  MemoryStatus,
  ProjectObjectKind,
  ProjectObjectRow,
  ReferenceKind,
  RepositoryRow,
  RunEventRow,
  SnapshotKind,
  SnapshotRow,
  SnapshotStats,
  SymbolKind,
  SymbolReferenceRow,
  SymbolRow,
  SymbolVersionRow,
  UpsertRepositoryInput,
} from './types.ts'
