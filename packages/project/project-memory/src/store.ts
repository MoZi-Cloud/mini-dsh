/**
 * The typed data-access surface over the project memory database: content
 * store writes, source-reality inserts (repositories, snapshots, files,
 * symbols, imports, call sites, references, project objects), project
 * knowledge rows (memories, evidence, analysis units, run events), call-graph
 * queries, and the immediate-transaction wrapper every multi-row mutation
 * runs in.
 *
 * All row ids are branded at this boundary: values read from SQLite are plain
 * strings, and every accessor re-brands them so callers cannot mix id kinds.
 *
 * @module @deepseek-ai/dsh-project-memory/store
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AnalysisUnitId,
  CallSiteId,
  DocumentHeadingId,
  FileId,
  contentId,
  ImportId,
  MemoryId,
  ProjectObjectId,
  RepositoryId,
  SnapshotId,
  SymbolId,
  SymbolReferenceId,
  SymbolVersionId,
  type ContentId,
} from './ids.ts'
import { ProjectMemoryError } from './errors.ts'
import { openProjectMemoryDatabase, type SchemaJournalMode } from './schema.ts'
import type {
  AnalysisHistoryRow,
  AnalysisUnitRow,
  CallSiteRow,
  DocumentHeadingRow,
  FileRow,
  InsertDocumentHeadingInput,
  ImportRow,
  InsertAnalysisUnitInput,
  InsertCallSiteInput,
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
  ProjectObjectRow,
  RepositoryRow,
  RunEventRow,
  SnapshotRow,
  SnapshotStats,
  SymbolReferenceRow,
  SymbolRow,
  SymbolVersionRow,
  UpsertRepositoryInput,
} from './types.ts'

/** Options for opening a store. */
export interface OpenProjectMemoryOptions {
  /** Journal pragma; defaults to `wal`. */
  readonly journalMode?: SchemaJournalMode | undefined
}

/**
 * The project memory store. One instance owns one SQLite connection; it is
 * not safe to share across processes. Call {@link ProjectMemory.close} when
 * done — every method on a closed store fails with code `closed`.
 */
export class ProjectMemory {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private closed = false
  private inTransaction = false
  private savepointDepth = 0

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * Open (and create if missing) a project memory database.
   * @param path - database file path, or `:memory:` for a private in-memory store.
   * @param options - journal mode override.
   * @returns the open store.
   */
  static async open(path: string, options: OpenProjectMemoryOptions = {}): Promise<ProjectMemory> {
    const db = await openProjectMemoryDatabase(path, options.journalMode ?? 'wal')
    return new ProjectMemory(db)
  }

  /** Close the connection. Later calls fail with code `closed`. */
  close(): void {
    this.assertOpen()
    this.closed = true
    this.db.close()
  }

  /**
   * Run a unit of writes inside one transaction. The outermost call opens
   * `BEGIN IMMEDIATE` and commits or rolls back atomically; nested calls
   * become SQLite savepoints, so composed helpers (such as
   * {@link ProjectMemory.upsertRepository}) join the caller's transaction
   * instead of failing. A thrown error rolls back to the matching
   * savepoint (or the whole transaction) and rethrows.
   * @param fn - the writes to commit together.
   * @returns whatever `fn` returned.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    if (!this.inTransaction) {
      this.inTransaction = true
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error: unknown) {
        this.db.exec('ROLLBACK')
        throw error
      } finally {
        this.inTransaction = false
      }
    }
    this.savepointDepth += 1
    const savepoint = `sp_${this.savepointDepth}`
    this.db.exec(`SAVEPOINT ${savepoint}`)
    try {
      const result = fn()
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error: unknown) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      throw error
    } finally {
      this.savepointDepth -= 1
    }
  }

  /**
   * Store text in the content store and return its content id. Identical text
   * maps to one row; the insert is idempotent.
   * @param text - exact text to store.
   * @param kind - whether the text is plain text or serialized JSON.
   * @returns the deterministic content id.
   */
  putContent(text: string, kind: 'text' | 'json' = 'text'): ContentId {
    const id = contentId(text)
    this.prepare('INSERT INTO contents(id, kind, byte_length, text) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(id, kind, Buffer.byteLength(text, 'utf8'), text)
    return id
  }

  /**
   * Read one stored content row.
   * @param id - the content id.
   * @returns the stored kind, byte length, and text, or `undefined` if absent.
   */
  getContent(id: ContentId): { readonly kind: 'text' | 'json'; readonly byteLength: number; readonly text: string } | undefined {
    const row = this.prepare('SELECT kind, byte_length, text FROM contents WHERE id = ?').get(id) as
      | { kind: 'text' | 'json'; byte_length: number; text: string }
      | undefined
    return row === undefined ? undefined : { kind: row.kind, byteLength: row.byte_length, text: row.text }
  }

  /**
   * Register or refresh a repository by slug. Existing rows keep their id and
   * creation time; provided fields overwrite, absent fields clear.
   * @param input - repository identity and location.
   * @returns the current repository row.
   */
  upsertRepository(input: UpsertRepositoryInput): RepositoryRow {
    const now = Date.now()
    return this.transaction(() => {
      const existing = this.prepare('SELECT id, created_at_ms FROM repositories WHERE slug = ?')
        .get(input.slug) as { id: string; created_at_ms: number } | undefined
      if (existing === undefined) {
        const id = RepositoryId()
        this.prepare('INSERT INTO repositories(id, slug, url, local_path, default_branch, created_at_ms, updated_at_ms) VALUES(?,?,?,?,?,?,?)')
          .run(id, input.slug, input.url ?? null, input.localPath ?? null, input.defaultBranch ?? null, now, now)
        return {
          id,
          slug: input.slug,
          url: input.url,
          localPath: input.localPath,
          defaultBranch: input.defaultBranch,
          createdAtMs: now,
          updatedAtMs: now,
        }
      }
      this.prepare('UPDATE repositories SET url = ?, local_path = ?, default_branch = ?, updated_at_ms = ? WHERE id = ?')
        .run(input.url ?? null, input.localPath ?? null, input.defaultBranch ?? null, now, existing.id)
      return {
        id: brandString<RepositoryId>(existing.id),
        slug: input.slug,
        url: input.url,
        localPath: input.localPath,
        defaultBranch: input.defaultBranch,
        createdAtMs: existing.created_at_ms,
        updatedAtMs: now,
      }
    })
  }

  /**
   * Look up a repository by slug.
   * @param slug - unique repository slug.
   * @returns the row, or `undefined` when no such repository exists.
   */
  getRepositoryBySlug(slug: string): RepositoryRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM repositories WHERE slug = ?').get(slug) as Record<string, unknown> | undefined,
      mapRepositoryRow,
    )
  }

  /**
   * Look up a repository by id.
   * @param id - repository row id.
   * @returns the row, or `undefined` when absent.
   */
  getRepository(id: RepositoryId): RepositoryRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Record<string, unknown> | undefined,
      mapRepositoryRow,
    )
  }

  /**
   * Record one snapshot capture of a repository.
   * @param input - snapshot kind, commit, and dirtiness.
   * @returns the inserted row.
   */
  insertSnapshot(input: InsertSnapshotInput): SnapshotRow {
    const id = SnapshotId()
    const capturedAtMs = Date.now()
    this.prepare('INSERT INTO repo_snapshots(id, repository_id, snapshot_kind, commit_sha, dirty, captured_at_ms) VALUES(?,?,?,?,?,?)')
      .run(id, input.repositoryId, input.snapshotKind, input.commitSha ?? null, input.dirty === true ? 1 : 0, capturedAtMs)
    return {
      id,
      repositoryId: input.repositoryId,
      snapshotKind: input.snapshotKind,
      commitSha: input.commitSha,
      dirty: input.dirty === true,
      capturedAtMs,
    }
  }

  /**
   * Look up a snapshot by id.
   * @param id - snapshot row id.
   * @returns the row, or `undefined` when absent.
   */
  getSnapshot(id: SnapshotId): SnapshotRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM repo_snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined,
      mapSnapshotRow,
    )
  }

  /**
   * Record one indexed source file.
   * @param input - file path, language, size, and optional stored content.
   * @returns the inserted row.
   */
  insertFile(input: InsertFileInput): FileRow {
    const id = FileId()
    this.prepare('INSERT INTO files(id, snapshot_id, path, language, byte_length, content_id) VALUES(?,?,?,?,?,?)')
      .run(id, input.snapshotId, input.path, input.language, input.byteLength, input.contentId ?? null)
    return {
      id,
      snapshotId: input.snapshotId,
      path: input.path,
      language: input.language,
      byteLength: input.byteLength,
      contentId: input.contentId,
    }
  }

  /**
   * Look up a file by id.
   * @param id - file row id.
   * @returns the row, or `undefined` when absent.
   */
  getFile(id: FileId): FileRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined,
      mapFileRow,
    )
  }

  /**
   * List the files of one snapshot carrying a given language tag, in path
   * order — the document index of a snapshot is `language = 'markdown'`.
   * @param snapshotId - snapshot to search.
   * @param language - exact language tag.
   * @returns matching file rows ordered by path.
   */
  findFilesByLanguage(snapshotId: SnapshotId, language: string): FileRow[] {
    return (this.prepare('SELECT * FROM files WHERE snapshot_id = ? AND language = ? ORDER BY path')
      .all(snapshotId, language) as Record<string, unknown>[]).map(mapFileRow)
  }

  /**
   * Record one ATX heading of an indexed document.
   * @param input - file, heading level, one-based line, and heading text.
   */
  insertDocumentHeading(input: InsertDocumentHeadingInput): void {
    this.prepare('INSERT INTO document_headings(id, file_id, level, line, text) VALUES(?,?,?,?,?)')
      .run(DocumentHeadingId(), input.fileId, input.level, input.line, input.text)
  }

  /**
   * List the headings recorded for one document file, in document order.
   * @param fileId - document file row id.
   * @returns heading rows ordered by line.
   */
  findDocumentHeadings(fileId: FileId): DocumentHeadingRow[] {
    return (this.prepare('SELECT * FROM document_headings WHERE file_id = ? ORDER BY line')
      .all(fileId) as Record<string, unknown>[]).map(mapDocumentHeadingRow)
  }

  /**
   * Get or create the stable symbol identity for one repository.
   * @param repositoryId - owning repository.
   * @param stableKey - repository-unique stable key of the symbol.
   * @returns the identity row (existing or newly created).
   */
  upsertSymbol(repositoryId: RepositoryId, stableKey: string): SymbolRow {
    const existing = this.prepare('SELECT * FROM symbols WHERE repository_id = ? AND stable_key = ?')
      .get(repositoryId, stableKey) as Record<string, unknown> | undefined
    if (existing !== undefined) return mapSymbolRow(existing)
    const id = SymbolId()
    this.prepare('INSERT INTO symbols(id, repository_id, stable_key) VALUES(?,?,?)').run(id, repositoryId, stableKey)
    return { id, repositoryId, stableKey }
  }

  /**
   * Record per-snapshot facts for one symbol.
   * @param input - location, kind, signature, and flags.
   * @returns the inserted row.
   */
  insertSymbolVersion(input: InsertSymbolVersionInput): SymbolVersionRow {
    const id = SymbolVersionId()
    this.prepare(`INSERT INTO symbol_versions(
      id, symbol_id, snapshot_id, file_id, name, qualified_name, symbol_kind,
      start_line, end_line, signature_text, is_exported, is_async, is_static, extraction_level
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id, input.symbolId, input.snapshotId, input.fileId, input.name, input.qualifiedName, input.symbolKind,
        input.startLine, input.endLine, input.signatureText, input.isExported ? 1 : 0, input.isAsync ? 1 : 0,
        input.isStatic ? 1 : 0, input.extractionLevel,
      )
    return {
      id,
      symbolId: input.symbolId,
      snapshotId: input.snapshotId,
      fileId: input.fileId,
      name: input.name,
      qualifiedName: input.qualifiedName,
      symbolKind: input.symbolKind,
      startLine: input.startLine,
      endLine: input.endLine,
      signatureText: input.signatureText,
      isExported: input.isExported,
      isAsync: input.isAsync,
      isStatic: input.isStatic,
      extractionLevel: input.extractionLevel,
    }
  }

  /**
   * Look up a symbol version by id.
   * @param id - symbol-version row id.
   * @returns the row, or `undefined` when absent.
   */
  getSymbolVersion(id: SymbolVersionId): SymbolVersionRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM symbol_versions WHERE id = ?').get(id) as Record<string, unknown> | undefined,
      mapSymbolVersionRow,
    )
  }

  /**
   * Find symbol versions in one snapshot by bare name.
   * @param snapshotId - snapshot to search.
   * @param name - exact symbol name.
   * @returns matching rows ordered by qualified name.
   */
  findSymbolVersionsByName(snapshotId: SnapshotId, name: string): SymbolVersionRow[] {
    return (this.prepare('SELECT * FROM symbol_versions WHERE snapshot_id = ? AND name = ? ORDER BY qualified_name')
      .all(snapshotId, name) as Record<string, unknown>[]).map(mapSymbolVersionRow)
  }

  /**
   * List symbol versions recorded for one file.
   * @param fileId - file row id.
   * @returns matching rows ordered by start line.
   */
  findSymbolVersionsByFile(fileId: FileId): SymbolVersionRow[] {
    return (this.prepare('SELECT * FROM symbol_versions WHERE file_id = ? ORDER BY start_line')
      .all(fileId) as Record<string, unknown>[]).map(mapSymbolVersionRow)
  }

  /**
   * Record one module import of a file.
   * @param input - specifier, type-only flag, and line.
   * @returns the inserted row.
   */
  insertImport(input: InsertImportInput): ImportRow {
    const id = ImportId()
    this.prepare('INSERT INTO imports(id, file_id, module_specifier, is_type_only, line) VALUES(?,?,?,?,?)')
      .run(id, input.fileId, input.moduleSpecifier, input.isTypeOnly ? 1 : 0, input.line)
    return {
      id,
      fileId: input.fileId,
      moduleSpecifier: input.moduleSpecifier,
      isTypeOnly: input.isTypeOnly,
      line: input.line,
    }
  }

  /**
   * Record one call-site edge in the call graph.
   * @param input - position, caller, callee name, resolution, and level.
   * @returns the inserted row.
   */
  insertCallSite(input: InsertCallSiteInput): CallSiteRow {
    const id = CallSiteId()
    this.prepare(`INSERT INTO call_sites(
      id, snapshot_id, file_id, line, column, caller_symbol_version_id,
      callee_name, callee_symbol_version_id, resolution, extraction_level
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id, input.snapshotId, input.fileId, input.line, input.column, input.callerSymbolVersionId ?? null,
        input.calleeName, input.calleeSymbolVersionId ?? null, input.resolution, input.extractionLevel,
      )
    return {
      id,
      snapshotId: input.snapshotId,
      fileId: input.fileId,
      line: input.line,
      column: input.column,
      callerSymbolVersionId: input.callerSymbolVersionId,
      calleeName: input.calleeName,
      calleeSymbolVersionId: input.calleeSymbolVersionId,
      resolution: input.resolution,
      extractionLevel: input.extractionLevel,
    }
  }

  /**
   * List call sites in one snapshot whose callee is the given symbol version.
   * @param snapshotId - snapshot to search.
   * @param calleeSymbolVersionId - callee symbol version.
   * @returns edges ordered by file path then line.
   */
  callersOf(snapshotId: SnapshotId, calleeSymbolVersionId: SymbolVersionId): CallSiteRow[] {
    return (this.prepare(`SELECT c.* FROM call_sites c JOIN files f ON f.id = c.file_id
      WHERE c.snapshot_id = ? AND c.callee_symbol_version_id = ? ORDER BY f.path, c.line`)
      .all(snapshotId, calleeSymbolVersionId) as Record<string, unknown>[]).map(mapCallSiteRow)
  }

  /**
   * List call sites in one snapshot made by the given symbol version.
   * @param snapshotId - snapshot to search.
   * @param callerSymbolVersionId - caller symbol version.
   * @returns edges ordered by line.
   */
  calleesOf(snapshotId: SnapshotId, callerSymbolVersionId: SymbolVersionId): CallSiteRow[] {
    return (this.prepare('SELECT * FROM call_sites WHERE snapshot_id = ? AND caller_symbol_version_id = ? ORDER BY line')
      .all(snapshotId, callerSymbolVersionId) as Record<string, unknown>[]).map(mapCallSiteRow)
  }

  /**
   * List every call site recorded in one snapshot.
   * @param snapshotId - snapshot to search.
   * @returns all edges ordered by file path then line.
   */
  callSitesInSnapshot(snapshotId: SnapshotId): CallSiteRow[] {
    return (this.prepare(`SELECT c.* FROM call_sites c JOIN files f ON f.id = c.file_id
      WHERE c.snapshot_id = ? ORDER BY f.path, c.line`)
      .all(snapshotId) as Record<string, unknown>[]).map(mapCallSiteRow)
  }

  /**
   * Record one non-call symbol reference.
   * @param input - position, referencing and referenced symbols, kind.
   * @returns the inserted row.
   */
  insertSymbolReference(input: InsertSymbolReferenceInput): SymbolReferenceRow {
    const id = SymbolReferenceId()
    this.prepare(`INSERT INTO symbol_references(
      id, snapshot_id, file_id, line, referencing_symbol_version_id, referenced_symbol_version_id, reference_kind
    ) VALUES(?,?,?,?,?,?,?)`)
      .run(
        id, input.snapshotId, input.fileId, input.line, input.referencingSymbolVersionId ?? null,
        input.referencedSymbolVersionId, input.referenceKind,
      )
    return {
      id,
      snapshotId: input.snapshotId,
      fileId: input.fileId,
      line: input.line,
      referencingSymbolVersionId: input.referencingSymbolVersionId,
      referencedSymbolVersionId: input.referencedSymbolVersionId,
      referenceKind: input.referenceKind,
    }
  }

  /**
   * List references in one snapshot that target the given symbol version.
   * @param snapshotId - snapshot to search.
   * @param referencedSymbolVersionId - referenced symbol version.
   * @returns rows ordered by line.
   */
  referencesTo(snapshotId: SnapshotId, referencedSymbolVersionId: SymbolVersionId): SymbolReferenceRow[] {
    return (this.prepare('SELECT * FROM symbol_references WHERE snapshot_id = ? AND referenced_symbol_version_id = ? ORDER BY line')
      .all(snapshotId, referencedSymbolVersionId) as Record<string, unknown>[]).map(mapSymbolReferenceRow)
  }

  /**
   * Record one observed source-reality object.
   * @param input - kind, stable key, name, and optional parent/symbol links.
   * @returns the inserted row.
   */
  insertProjectObject(input: InsertProjectObjectInput): ProjectObjectRow {
    const id = ProjectObjectId()
    this.prepare(`INSERT INTO project_objects(
      id, repository_id, snapshot_id, object_kind, stable_key, name, parent_id, symbol_version_id
    ) VALUES(?,?,?,?,?,?,?,?)`)
      .run(
        id, input.repositoryId, input.snapshotId, input.objectKind, input.stableKey, input.name,
        input.parentId ?? null, input.symbolVersionId ?? null,
      )
    return {
      id,
      repositoryId: input.repositoryId,
      snapshotId: input.snapshotId,
      objectKind: input.objectKind,
      stableKey: input.stableKey,
      name: input.name,
      parentId: input.parentId,
      symbolVersionId: input.symbolVersionId,
    }
  }

  /**
   * Look up a project object by its snapshot-unique stable key.
   * @param snapshotId - snapshot to search.
   * @param stableKey - snapshot-unique stable key.
   * @returns the row, or `undefined` when absent.
   */
  findProjectObjectByStableKey(snapshotId: SnapshotId, stableKey: string): ProjectObjectRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM project_objects WHERE snapshot_id = ? AND stable_key = ?')
        .get(snapshotId, stableKey) as Record<string, unknown> | undefined,
      mapProjectObjectRow,
    )
  }

  /**
   * Record one durable memory with its text stored in the content store.
   * @param input - scope, text, and optional origin snapshot.
   * @returns the inserted row.
   */
  insertMemory(input: InsertMemoryInput): MemoryRow {
    const id = MemoryId()
    const content = this.putContent(input.content)
    const now = Date.now()
    this.prepare(`INSERT INTO memories(id, repository_id, snapshot_id, scope, content_id, status, created_at_ms, updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, input.repositoryId, input.snapshotId ?? null, input.scope, content, input.status ?? 'active', now, now)
    return {
      id,
      repositoryId: input.repositoryId,
      snapshotId: input.snapshotId,
      scope: input.scope,
      contentId: content,
      status: input.status ?? 'active',
      createdAtMs: now,
      updatedAtMs: now,
    }
  }

  /**
   * Look up a memory by id.
   * @param id - memory row id.
   * @returns the row, or `undefined` when absent.
   */
  getMemory(id: MemoryId): MemoryRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined,
      mapMemoryRow,
    )
  }

  /**
   * Attach one piece of source evidence to a memory.
   * @param input - optional snapshot, file, symbol, line range, and quote.
   */
  attachMemoryEvidence(input: InsertMemoryEvidenceInput): void {
    const quote = input.quote === undefined ? null : this.putContent(input.quote)
    this.prepare(`INSERT INTO memory_evidence(
      id, memory_id, snapshot_id, file_id, symbol_version_id, line_start, line_end, quote_content_id
    ) VALUES(?,?,?,?,?,?,?,?)`)
      .run(
        MemoryEvidenceRowId(), input.memoryId, input.snapshotId ?? null, input.fileId ?? null,
        input.symbolVersionId ?? null, input.lineStart ?? null, input.lineEnd ?? null, quote,
      )
  }

  /**
   * List the evidence rows attached to one memory.
   * @param memoryId - memory row id.
   * @returns rows ordered by insert rowid.
   */
  listMemoryEvidence(memoryId: MemoryId): MemoryEvidenceRow[] {
    return (this.prepare('SELECT rowid AS sort, * FROM memory_evidence WHERE memory_id = ? ORDER BY sort')
      .all(memoryId) as Record<string, unknown>[]).map(mapMemoryEvidenceRow)
  }

  /**
   * Record one analysis unit with its optional question text stored as content.
   * @param input - kind, title, question, and status.
   * @returns the inserted row.
   */
  insertAnalysisUnit(input: InsertAnalysisUnitInput): AnalysisUnitRow {
    const id = AnalysisUnitId()
    const question = input.question === undefined ? null : this.putContent(input.question)
    const now = Date.now()
    this.prepare(`INSERT INTO analysis_units(id, repository_id, unit_kind, title, question_content_id, status, created_at_ms, updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, input.repositoryId, input.unitKind, input.title, question, input.status ?? 'open', now, now)
    return {
      id,
      repositoryId: input.repositoryId,
      unitKind: input.unitKind,
      title: input.title,
      questionContentId: question ?? undefined,
      status: input.status ?? 'open',
      createdAtMs: now,
      updatedAtMs: now,
    }
  }

  /**
   * Look up an analysis unit by id.
   * @param id - analysis-unit row id.
   * @returns the row, or `undefined` when absent.
   */
  getAnalysisUnit(id: AnalysisUnitId): AnalysisUnitRow | undefined {
    return mapOptional(
      this.prepare('SELECT * FROM analysis_units WHERE id = ?').get(id) as Record<string, unknown> | undefined,
      mapAnalysisUnitRow,
    )
  }

  /**
   * Append one history event to an analysis unit.
   * @param unitId - analysis-unit row id.
   * @param event - short event label.
   * @param detail - optional detail text stored as content.
   */
  appendAnalysisHistory(unitId: AnalysisUnitId, event: string, detail?: string): void {
    const detailId = detail === undefined ? null : this.putContent(detail)
    this.prepare('INSERT INTO analysis_history(id, unit_id, event, detail_content_id, created_at_ms) VALUES(?,?,?,?,?)')
      .run(AnalysisHistoryRowId(), unitId, event, detailId, Date.now())
  }

  /**
   * List the history rows of one analysis unit.
   * @param unitId - analysis-unit row id.
   * @returns rows oldest first.
   */
  listAnalysisHistory(unitId: AnalysisUnitId): AnalysisHistoryRow[] {
    return (this.prepare('SELECT * FROM analysis_history WHERE unit_id = ? ORDER BY created_at_ms, rowid')
      .all(unitId) as Record<string, unknown>[]).map(mapAnalysisHistoryRow)
  }

  /**
   * Record one run event with optional JSON payload stored as content.
   * @param repositoryId - owning repository.
   * @param eventKind - short event label.
   * @param payload - optional payload; serialized as JSON content.
   */
  recordRunEvent(repositoryId: RepositoryId, eventKind: string, payload?: unknown): void {
    const payloadId = payload === undefined ? null : this.putContent(JSON.stringify(payload), 'json')
    this.prepare('INSERT INTO run_events(id, repository_id, event_kind, payload_content_id, created_at_ms) VALUES(?,?,?,?,?)')
      .run(RunEventRowId(), repositoryId, eventKind, payloadId, Date.now())
  }

  /**
   * List run events of one repository.
   * @param repositoryId - owning repository.
   * @returns rows oldest first.
   */
  listRunEvents(repositoryId: RepositoryId): RunEventRow[] {
    return (this.prepare('SELECT * FROM run_events WHERE repository_id = ? ORDER BY created_at_ms, rowid')
      .all(repositoryId) as Record<string, unknown>[]).map(mapRunEventRow)
  }

  /**
   * Aggregate counts describing one indexed snapshot.
   * @param snapshotId - snapshot to summarize.
   * @returns file, symbol, call-site (by resolution), and object counts.
   */
  snapshotStats(snapshotId: SnapshotId): SnapshotStats {
    const count = (sql: string): number =>
      (this.prepare(sql).get(snapshotId) as { n: number }).n
    return {
      files: count('SELECT COUNT(*) AS n FROM files WHERE snapshot_id = ?'),
      documents: count("SELECT COUNT(*) AS n FROM files WHERE snapshot_id = ? AND language = 'markdown'"),
      documentHeadings: count(
        'SELECT COUNT(*) AS n FROM document_headings h JOIN files f ON f.id = h.file_id WHERE f.snapshot_id = ?',
      ),
      symbols: count('SELECT COUNT(*) AS n FROM symbol_versions WHERE snapshot_id = ?'),
      callSites: count('SELECT COUNT(*) AS n FROM call_sites WHERE snapshot_id = ?'),
      resolvedCalls: count("SELECT COUNT(*) AS n FROM call_sites WHERE snapshot_id = ? AND resolution = 'resolved'"),
      externalCalls: count("SELECT COUNT(*) AS n FROM call_sites WHERE snapshot_id = ? AND resolution = 'external'"),
      unresolvedCalls: count("SELECT COUNT(*) AS n FROM call_sites WHERE snapshot_id = ? AND resolution = 'unresolved'"),
      dynamicCalls: count("SELECT COUNT(*) AS n FROM call_sites WHERE snapshot_id = ? AND resolution = 'dynamic'"),
      projectObjects: count('SELECT COUNT(*) AS n FROM project_objects WHERE snapshot_id = ?'),
    }
  }

  private prepare(sql: string): StatementSync {
    this.assertOpen()
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private assertOpen(): void {
    if (this.closed) throw new ProjectMemoryError('closed', 'this project memory store is closed')
  }
}

/** Allocate an unbranded evidence-row id (rows of this table are listed, never addressed individually by callers). */
function MemoryEvidenceRowId(): string {
  return `evid_${randomUUID()}`
}

/** Allocate an unbranded analysis-history-row id. */
function AnalysisHistoryRowId(): string {
  return `hist_${randomUUID()}`
}

/** Allocate an unbranded run-event-row id. */
function RunEventRowId(): string {
  return `run_${randomUUID()}`
}

function mapOptional<T>(row: Record<string, unknown> | undefined, map: (row: Record<string, unknown>) => T): T | undefined {
  return row === undefined ? undefined : map(row)
}

function text(row: Record<string, unknown>, key: string): string {
  return row[key] as string
}

function optionalText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return value === null || value === undefined ? undefined : (value as string)
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  return row[key] as number
}

function optionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key]
  return value === null || value === undefined ? undefined : (value as number)
}

function flag(row: Record<string, unknown>, key: string): boolean {
  return (row[key] as number) !== 0
}

function mapRepositoryRow(row: Record<string, unknown>): RepositoryRow {
  return {
    id: brandString<RepositoryId>(text(row, 'id')),
    slug: text(row, 'slug'),
    url: optionalText(row, 'url'),
    localPath: optionalText(row, 'local_path'),
    defaultBranch: optionalText(row, 'default_branch'),
    createdAtMs: numberColumn(row, 'created_at_ms'),
    updatedAtMs: numberColumn(row, 'updated_at_ms'),
  }
}

function mapSnapshotRow(row: Record<string, unknown>): SnapshotRow {
  return {
    id: brandString<SnapshotId>(text(row, 'id')),
    repositoryId: brandString<RepositoryId>(text(row, 'repository_id')),
    snapshotKind: text(row, 'snapshot_kind') as SnapshotRow['snapshotKind'],
    commitSha: optionalText(row, 'commit_sha'),
    dirty: flag(row, 'dirty'),
    capturedAtMs: numberColumn(row, 'captured_at_ms'),
  }
}

function mapFileRow(row: Record<string, unknown>): FileRow {
  const content = optionalText(row, 'content_id')
  return {
    id: brandString<FileId>(text(row, 'id')),
    snapshotId: brandString<SnapshotId>(text(row, 'snapshot_id')),
    path: text(row, 'path'),
    language: text(row, 'language'),
    byteLength: numberColumn(row, 'byte_length'),
    contentId: content === undefined ? undefined : brandString<ContentId>(content),
  }
}

function mapDocumentHeadingRow(row: Record<string, unknown>): DocumentHeadingRow {
  return {
    id: brandString<DocumentHeadingId>(text(row, 'id')),
    fileId: brandString<FileId>(text(row, 'file_id')),
    level: numberColumn(row, 'level'),
    line: numberColumn(row, 'line'),
    text: text(row, 'text'),
  }
}

function mapSymbolRow(row: Record<string, unknown>): SymbolRow {
  return {
    id: brandString<SymbolId>(text(row, 'id')),
    repositoryId: brandString<RepositoryId>(text(row, 'repository_id')),
    stableKey: text(row, 'stable_key'),
  }
}

function mapSymbolVersionRow(row: Record<string, unknown>): SymbolVersionRow {
  return {
    id: brandString<SymbolVersionId>(text(row, 'id')),
    symbolId: brandString<SymbolId>(text(row, 'symbol_id')),
    snapshotId: brandString<SnapshotId>(text(row, 'snapshot_id')),
    fileId: brandString<FileId>(text(row, 'file_id')),
    name: text(row, 'name'),
    qualifiedName: text(row, 'qualified_name'),
    symbolKind: text(row, 'symbol_kind') as SymbolVersionRow['symbolKind'],
    startLine: numberColumn(row, 'start_line'),
    endLine: numberColumn(row, 'end_line'),
    signatureText: text(row, 'signature_text'),
    isExported: flag(row, 'is_exported'),
    isAsync: flag(row, 'is_async'),
    isStatic: flag(row, 'is_static'),
    extractionLevel: text(row, 'extraction_level') as SymbolVersionRow['extractionLevel'],
  }
}

function mapCallSiteRow(row: Record<string, unknown>): CallSiteRow {
  const caller = optionalText(row, 'caller_symbol_version_id')
  const callee = optionalText(row, 'callee_symbol_version_id')
  return {
    id: brandString<CallSiteId>(text(row, 'id')),
    snapshotId: brandString<SnapshotId>(text(row, 'snapshot_id')),
    fileId: brandString<FileId>(text(row, 'file_id')),
    line: numberColumn(row, 'line'),
    column: numberColumn(row, 'column'),
    callerSymbolVersionId: caller === undefined ? undefined : brandString<SymbolVersionId>(caller),
    calleeName: text(row, 'callee_name'),
    calleeSymbolVersionId: callee === undefined ? undefined : brandString<SymbolVersionId>(callee),
    resolution: text(row, 'resolution') as CallSiteRow['resolution'],
    extractionLevel: text(row, 'extraction_level') as CallSiteRow['extractionLevel'],
  }
}

function mapSymbolReferenceRow(row: Record<string, unknown>): SymbolReferenceRow {
  const referencing = optionalText(row, 'referencing_symbol_version_id')
  return {
    id: brandString<SymbolReferenceId>(text(row, 'id')),
    snapshotId: brandString<SnapshotId>(text(row, 'snapshot_id')),
    fileId: brandString<FileId>(text(row, 'file_id')),
    line: numberColumn(row, 'line'),
    referencingSymbolVersionId: referencing === undefined ? undefined : brandString<SymbolVersionId>(referencing),
    referencedSymbolVersionId: brandString<SymbolVersionId>(text(row, 'referenced_symbol_version_id')),
    referenceKind: text(row, 'reference_kind') as SymbolReferenceRow['referenceKind'],
  }
}

function mapProjectObjectRow(row: Record<string, unknown>): ProjectObjectRow {
  const parent = optionalText(row, 'parent_id')
  const symbol = optionalText(row, 'symbol_version_id')
  return {
    id: brandString<ProjectObjectId>(text(row, 'id')),
    repositoryId: brandString<RepositoryId>(text(row, 'repository_id')),
    snapshotId: brandString<SnapshotId>(text(row, 'snapshot_id')),
    objectKind: text(row, 'object_kind') as ProjectObjectRow['objectKind'],
    stableKey: text(row, 'stable_key'),
    name: text(row, 'name'),
    parentId: parent === undefined ? undefined : brandString<ProjectObjectId>(parent),
    symbolVersionId: symbol === undefined ? undefined : brandString<SymbolVersionId>(symbol),
  }
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRow {
  const snapshot = optionalText(row, 'snapshot_id')
  return {
    id: brandString<MemoryId>(text(row, 'id')),
    repositoryId: brandString<RepositoryId>(text(row, 'repository_id')),
    snapshotId: snapshot === undefined ? undefined : brandString<SnapshotId>(snapshot),
    scope: text(row, 'scope'),
    contentId: brandString<ContentId>(text(row, 'content_id')),
    status: text(row, 'status') as MemoryRow['status'],
    createdAtMs: numberColumn(row, 'created_at_ms'),
    updatedAtMs: numberColumn(row, 'updated_at_ms'),
  }
}

function mapMemoryEvidenceRow(row: Record<string, unknown>): MemoryEvidenceRow {
  const snapshot = optionalText(row, 'snapshot_id')
  const file = optionalText(row, 'file_id')
  const symbol = optionalText(row, 'symbol_version_id')
  const quote = optionalText(row, 'quote_content_id')
  return {
    id: text(row, 'id'),
    memoryId: brandString<MemoryId>(text(row, 'memory_id')),
    snapshotId: snapshot === undefined ? undefined : brandString<SnapshotId>(snapshot),
    fileId: file === undefined ? undefined : brandString<FileId>(file),
    symbolVersionId: symbol === undefined ? undefined : brandString<SymbolVersionId>(symbol),
    lineStart: optionalNumber(row, 'line_start'),
    lineEnd: optionalNumber(row, 'line_end'),
    quoteContentId: quote === undefined ? undefined : brandString<ContentId>(quote),
  }
}

function mapAnalysisUnitRow(row: Record<string, unknown>): AnalysisUnitRow {
  const question = optionalText(row, 'question_content_id')
  return {
    id: brandString<AnalysisUnitId>(text(row, 'id')),
    repositoryId: brandString<RepositoryId>(text(row, 'repository_id')),
    unitKind: text(row, 'unit_kind') as AnalysisUnitRow['unitKind'],
    title: text(row, 'title'),
    questionContentId: question === undefined ? undefined : brandString<ContentId>(question),
    status: text(row, 'status') as AnalysisUnitRow['status'],
    createdAtMs: numberColumn(row, 'created_at_ms'),
    updatedAtMs: numberColumn(row, 'updated_at_ms'),
  }
}

function mapAnalysisHistoryRow(row: Record<string, unknown>): AnalysisHistoryRow {
  const detail = optionalText(row, 'detail_content_id')
  return {
    id: text(row, 'id'),
    unitId: brandString<AnalysisUnitId>(text(row, 'unit_id')),
    event: text(row, 'event'),
    detailContentId: detail === undefined ? undefined : brandString<ContentId>(detail),
    createdAtMs: numberColumn(row, 'created_at_ms'),
  }
}

function mapRunEventRow(row: Record<string, unknown>): RunEventRow {
  const payload = optionalText(row, 'payload_content_id')
  return {
    id: text(row, 'id'),
    repositoryId: brandString<RepositoryId>(text(row, 'repository_id')),
    eventKind: text(row, 'event_kind'),
    payloadContentId: payload === undefined ? undefined : brandString<ContentId>(payload),
    createdAtMs: numberColumn(row, 'created_at_ms'),
  }
}
