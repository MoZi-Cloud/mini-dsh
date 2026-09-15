/**
 * Physical schema of the project memory database: the layout version, the
 * open/configure sequence (permissions, pragmas, version stamp/reject), and
 * the v1 table set — content store, source reality (repositories, snapshots,
 * files, symbols, imports, call sites, references, project objects), and
 * project knowledge (memories, evidence, analysis units, run events).
 *
 * The database is a source of truth, not a rebuildable index: a stamped
 * `user_version` other than the current one rejects, and future layout
 * changes ship as adjacent migration steps, never in-place rewrites.
 *
 * @module @deepseek-ai/dsh-project-memory/schema
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ProjectMemoryError } from './errors.ts'

/**
 * The on-disk physical layout version, stored in `PRAGMA user_version`.
 * Bumped only on a breaking change to the table layout; any other stamped
 * version rejects — no migration path exists for this first version.
 */
export const PROJECT_MEMORY_SCHEMA_VERSION = 1

/**
 * Journal modes the store runs under. `wal` is the default; the
 * rollback-journal modes exist for filesystems where WAL's shared-memory
 * files do not work (network mounts). `memory`/`off` are excluded because
 * silently dropping journal durability contradicts the store's role as the
 * durable project source of truth.
 */
export type SchemaJournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST`
 * propagate.
 * @param path - absolute path of the database file to create.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open the project memory database and apply its schema and pragmas. Missing
 * directories and database files are created owner-only (`:memory:` skips
 * filesystem setup). A zero `user_version` is stamped with
 * {@link PROJECT_MEMORY_SCHEMA_VERSION}; every other non-current version
 * rejects rather than being migrated in place.
 * @param path - the SQLite database file to open, or `:memory:`.
 * @param journalMode - validated journal pragma.
 * @returns the open handle with pragmas applied and the v1 tables ensured.
 */
export async function openProjectMemoryDatabase(
  path: string,
  journalMode: SchemaJournalMode,
): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual, journalMode)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: SchemaJournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== PROJECT_MEMORY_SCHEMA_VERSION) {
    throw new ProjectMemoryError(
      'version-mismatch',
      `project memory database at "${path}" has schema version ${onDisk}, incompatible with this build (${PROJECT_MEMORY_SCHEMA_VERSION})`,
    )
  }
  createTables(db)
  if (onDisk === 0) {
    // Stamp fresh databases LAST: the stamp asserts the layout is complete,
    // so a failure above must leave the medium unstamped (a re-open after
    // the obstruction is cleared retries materialization from scratch).
    db.exec(`PRAGMA user_version = ${PROJECT_MEMORY_SCHEMA_VERSION}`)
  }
}

function createTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contents (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('text','json')),
      byte_length INTEGER NOT NULL,
      text        TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS repositories (
      id              TEXT PRIMARY KEY,
      slug            TEXT NOT NULL UNIQUE,
      url             TEXT,
      local_path      TEXT,
      default_branch  TEXT,
      created_at_ms   INTEGER NOT NULL,
      updated_at_ms   INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS repo_snapshots (
      id            TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('pinned','head','worktree')),
      commit_sha    TEXT,
      dirty         INTEGER NOT NULL DEFAULT 0,
      captured_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_repo_snapshots_repo
      ON repo_snapshots(repository_id, captured_at_ms);

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES repo_snapshots(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,
      language    TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      content_id  TEXT REFERENCES contents(id),
      UNIQUE(snapshot_id, path)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS symbols (
      id            TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      stable_key    TEXT NOT NULL,
      UNIQUE(repository_id, stable_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS symbol_versions (
      id                TEXT PRIMARY KEY,
      symbol_id         TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      snapshot_id       TEXT NOT NULL REFERENCES repo_snapshots(id) ON DELETE CASCADE,
      file_id           TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      qualified_name    TEXT NOT NULL,
      symbol_kind       TEXT NOT NULL CHECK (symbol_kind IN (
        'function','method','class','interface','type_alias','enum','enum_member',
        'property','getter','setter','variable')),
      start_line        INTEGER NOT NULL,
      end_line          INTEGER NOT NULL,
      signature_text    TEXT NOT NULL,
      is_exported       INTEGER NOT NULL DEFAULT 0,
      is_async          INTEGER NOT NULL DEFAULT 0,
      is_static         INTEGER NOT NULL DEFAULT 0,
      extraction_level  TEXT NOT NULL CHECK (extraction_level IN ('syntactic','typechecker')),
      UNIQUE(symbol_id, snapshot_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_symbol_versions_name
      ON symbol_versions(snapshot_id, name);
    CREATE INDEX IF NOT EXISTS idx_symbol_versions_file
      ON symbol_versions(file_id);

    CREATE TABLE IF NOT EXISTS imports (
      id                TEXT PRIMARY KEY,
      file_id           TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      module_specifier  TEXT NOT NULL,
      is_type_only      INTEGER NOT NULL DEFAULT 0,
      line              INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);

    CREATE TABLE IF NOT EXISTS call_sites (
      id                         TEXT PRIMARY KEY,
      snapshot_id                TEXT NOT NULL REFERENCES repo_snapshots(id) ON DELETE CASCADE,
      file_id                    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      line                       INTEGER NOT NULL,
      column                     INTEGER NOT NULL,
      caller_symbol_version_id   TEXT REFERENCES symbol_versions(id) ON DELETE CASCADE,
      callee_name                TEXT NOT NULL,
      callee_symbol_version_id   TEXT REFERENCES symbol_versions(id) ON DELETE CASCADE,
      resolution                 TEXT NOT NULL CHECK (resolution IN ('resolved','unresolved','external','dynamic')),
      extraction_level           TEXT NOT NULL CHECK (extraction_level IN ('syntactic','typechecker'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_call_sites_callee
      ON call_sites(snapshot_id, callee_symbol_version_id);
    CREATE INDEX IF NOT EXISTS idx_call_sites_caller
      ON call_sites(snapshot_id, caller_symbol_version_id);

    CREATE TABLE IF NOT EXISTS symbol_references (
      id                            TEXT PRIMARY KEY,
      snapshot_id                   TEXT NOT NULL REFERENCES repo_snapshots(id) ON DELETE CASCADE,
      file_id                       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      line                          INTEGER NOT NULL,
      referencing_symbol_version_id TEXT REFERENCES symbol_versions(id) ON DELETE CASCADE,
      referenced_symbol_version_id  TEXT NOT NULL REFERENCES symbol_versions(id) ON DELETE CASCADE,
      reference_kind                TEXT NOT NULL CHECK (reference_kind IN ('type','import'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_symbol_refs_referenced
      ON symbol_references(snapshot_id, referenced_symbol_version_id);

    CREATE TABLE IF NOT EXISTS project_objects (
      id                  TEXT PRIMARY KEY,
      repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      snapshot_id         TEXT NOT NULL REFERENCES repo_snapshots(id) ON DELETE CASCADE,
      object_kind         TEXT NOT NULL CHECK (object_kind IN (
        'workspace','package_group','package','directory','file','symbol')),
      stable_key          TEXT NOT NULL,
      name                TEXT NOT NULL,
      parent_id           TEXT REFERENCES project_objects(id) ON DELETE CASCADE,
      symbol_version_id   TEXT REFERENCES symbol_versions(id) ON DELETE CASCADE,
      UNIQUE(snapshot_id, stable_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_project_objects_parent
      ON project_objects(parent_id);

    CREATE TABLE IF NOT EXISTS document_headings (
      id       TEXT PRIMARY KEY,
      file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      level    INTEGER NOT NULL CHECK (level BETWEEN 1 AND 6),
      line     INTEGER NOT NULL,
      text     TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_document_headings_file
      ON document_headings(file_id, line);

    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      snapshot_id   TEXT REFERENCES repo_snapshots(id) ON DELETE SET NULL,
      scope         TEXT NOT NULL,
      content_id    TEXT NOT NULL REFERENCES contents(id),
      status        TEXT NOT NULL CHECK (status IN ('active','retired')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_evidence (
      id                   TEXT PRIMARY KEY,
      memory_id            TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      snapshot_id          TEXT REFERENCES repo_snapshots(id) ON DELETE SET NULL,
      file_id              TEXT REFERENCES files(id) ON DELETE CASCADE,
      symbol_version_id    TEXT REFERENCES symbol_versions(id) ON DELETE CASCADE,
      line_start           INTEGER,
      line_end             INTEGER,
      quote_content_id     TEXT REFERENCES contents(id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS analysis_units (
      id                   TEXT PRIMARY KEY,
      repository_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      unit_kind            TEXT NOT NULL CHECK (unit_kind IN ('question','area','task')),
      title                TEXT NOT NULL,
      question_content_id  TEXT REFERENCES contents(id),
      status               TEXT NOT NULL CHECK (status IN ('open','answered','abandoned')),
      created_at_ms        INTEGER NOT NULL,
      updated_at_ms        INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS analysis_history (
      id                  TEXT PRIMARY KEY,
      unit_id             TEXT NOT NULL REFERENCES analysis_units(id) ON DELETE CASCADE,
      event               TEXT NOT NULL,
      detail_content_id   TEXT REFERENCES contents(id),
      created_at_ms       INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS run_events (
      id                  TEXT PRIMARY KEY,
      repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      event_kind          TEXT NOT NULL,
      payload_content_id  TEXT REFERENCES contents(id),
      created_at_ms       INTEGER NOT NULL
    ) STRICT;
  `)
}
