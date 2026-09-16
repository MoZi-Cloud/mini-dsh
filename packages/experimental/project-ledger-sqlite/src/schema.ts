/**
 * Physical schema of the project ledger database: the open/configure
 * sequence (owner-only files, pragmas, version stamp/reject), the shipped
 * adjacent migration steps, and the v1 Ledger Core layout — plans, plan
 * versions, phases, work items, work item relations, external blockers,
 * acceptance criteria, verification specs, acceptance evaluations, project
 * events, plan imports, compile diagnostics, and work leases.
 *
 * The database is a source of truth, not a rebuildable index: a stamped
 * `user_version` newer than this build rejects, upgrades advance one
 * adjacent migration step at a time, and nothing resets or rewrites
 * committed generations.
 *
 * @module @deepseek-ai/dsh-experimental-project-ledger-sqlite/schema
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { PROJECT_LEDGER_SCHEMA_VERSION } from './constants.ts'
import { ProjectLedgerError } from './errors.ts'

/**
 * Journal modes the ledger runs under. `wal` is the default; the
 * rollback-journal modes exist for filesystems where WAL's shared-memory
 * files do not work (network mounts). `memory`/`off` are excluded because
 * silently dropping journal durability contradicts the ledger's role as the
 * durable project source of truth.
 */
export type SchemaJournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/**
 * `busy_timeout` applied when the caller does not pass one: the ledger is a
 * contended source of truth, so writers wait briefly for a competing writer
 * instead of failing on the first lock.
 */
export const DEFAULT_LEDGER_BUSY_TIMEOUT_MS = 5000

/** Options for opening a ledger database. */
export interface OpenProjectLedgerDatabaseOptions {
  /** Journal pragma; defaults to `wal`. */
  readonly journalMode?: SchemaJournalMode | undefined
  /** Milliseconds a write waits on a competing writer; defaults to {@link DEFAULT_LEDGER_BUSY_TIMEOUT_MS}. */
  readonly busyTimeoutMs?: number | undefined
}

/** One shipped step upgrading the ledger layout from one version to the next. */
export interface ProjectLedgerMigration {
  /** Layout version the database must carry before this step applies. */
  readonly fromVersion: number
  /** Layout version the database carries after this step commits. */
  readonly toVersion: number
  /** Human-readable summary of what the step changes. */
  readonly description: string
  /**
   * Apply the step inside the caller's `BEGIN IMMEDIATE` transaction. The
   * step must be idempotent: a crash between `COMMIT` and the version stamp
   * leaves the old version stamped and re-runs the step on the next open.
   */
  apply(db: DatabaseSync): void
}

/**
 * Every shipped migration step, in order. Steps are adjacent (`0 → 1 → … →
 * {@link PROJECT_LEDGER_SCHEMA_VERSION}`); shipped entries are frozen and new
 * layout versions append exactly one step.
 */
export const PROJECT_LEDGER_MIGRATIONS: readonly ProjectLedgerMigration[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    description: 'initial Ledger Core layout (thirteen tables)',
    apply: createLedgerCoreTables,
  },
]

/**
 * Open the project ledger database and apply its schema and pragmas. Missing
 * directories and database files are created owner-only (`:memory:` skips
 * filesystem setup). A database below the current version migrates through
 * the shipped adjacent steps; a version newer than this build rejects rather
 * than downgrades.
 * @param path - the SQLite database file to open, or `:memory:`.
 * @param options - journal mode and busy timeout overrides.
 * @returns the open handle with pragmas applied and the current layout ensured.
 */
export async function openProjectLedgerDatabase(
  path: string,
  options: OpenProjectLedgerDatabaseOptions = {},
): Promise<DatabaseSync> {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_LEDGER_BUSY_TIMEOUT_MS
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new ProjectLedgerError(
      'invalid-argument',
      `busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`,
    )
  }
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual, options.journalMode ?? 'wal', busyTimeoutMs)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

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

function configureDatabase(
  db: DatabaseSync,
  path: string,
  journalMode: SchemaJournalMode,
  busyTimeoutMs: number,
): void {
  db.exec('PRAGMA foreign_keys = ON')
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  // The integer was validated in openProjectLedgerDatabase; PRAGMAs do not bind.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk > PROJECT_LEDGER_SCHEMA_VERSION) {
    throw new ProjectLedgerError(
      'version-mismatch',
      `project ledger database at "${path}" has schema version ${onDisk}, newer than this build `
        + `(${PROJECT_LEDGER_SCHEMA_VERSION}); a source-of-truth ledger never downgrades`,
    )
  }
  applyProjectLedgerMigrations(db, onDisk, path)
  if (onDisk !== PROJECT_LEDGER_SCHEMA_VERSION) {
    // Stamp LAST: the stamp asserts the migrated layout is complete, so a
    // failure above must leave the old version stamped (a re-open after the
    // obstruction is cleared retries the migration from that version).
    db.exec(`PRAGMA user_version = ${PROJECT_LEDGER_SCHEMA_VERSION}`)
  }
}

/**
 * Apply every shipped migration step newer than the stamped version, each in
 * its own `BEGIN IMMEDIATE` transaction. A step whose `fromVersion` does not
 * match the database (a gap in the shipped registry) fails loud instead of
 * guessing.
 * @param db - the open database handle.
 * @param onDiskVersion - layout version currently stamped on the database.
 * @param path - database path for error messages (`:memory:` allowed).
 * @param migrations - shipped steps; defaults to {@link PROJECT_LEDGER_MIGRATIONS}.
 * @returns the layout version after the applied steps.
 */
export function applyProjectLedgerMigrations(
  db: DatabaseSync,
  onDiskVersion: number,
  path: string,
  migrations: readonly ProjectLedgerMigration[] = PROJECT_LEDGER_MIGRATIONS,
): number {
  let version = onDiskVersion
  for (const step of migrations) {
    if (step.toVersion <= version) continue
    if (step.fromVersion !== version) {
      throw new ProjectLedgerError(
        'version-mismatch',
        `project ledger database at "${path}" has schema version ${version}, and the shipped migrations `
          + `skip from ${step.fromVersion} to ${step.toVersion}`,
      )
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      step.apply(db)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
    version = step.toVersion
  }
  if (version !== PROJECT_LEDGER_SCHEMA_VERSION) {
    throw new ProjectLedgerError(
      'version-mismatch',
      `project ledger database at "${path}" has schema version ${onDiskVersion}, and the shipped migrations `
        + `stop at ${version} while this build needs ${PROJECT_LEDGER_SCHEMA_VERSION}`,
    )
  }
  return version
}

/** Materialize the v1 Ledger Core tables and indexes. Idempotent by design. */
function createLedgerCoreTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL,
      name               TEXT NOT NULL,
      current_version_id TEXT,
      created_at_ms      INTEGER NOT NULL,
      UNIQUE(project_id, name)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plan_versions (
      id                       TEXT PRIMARY KEY,
      plan_id                  TEXT NOT NULL REFERENCES plans(id),
      version_no               INTEGER NOT NULL,
      status                   TEXT NOT NULL CHECK(status IN (
        'DRAFT','APPROVED','ACTIVE','SUPERSEDED','REJECTED'
      )),
      baseline_repo_head       TEXT,
      baseline_worktree_hash   TEXT,
      source_document_hash     TEXT NOT NULL,
      compiled_ir_hash         TEXT NOT NULL,
      created_at_ms            INTEGER NOT NULL,
      activated_at_ms          INTEGER,
      superseded_at_ms         INTEGER,
      UNIQUE(plan_id, version_no)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_plan_versions_plan_status
      ON plan_versions(plan_id, status, version_no DESC);

    CREATE TABLE IF NOT EXISTS phases (
      id                 TEXT PRIMARY KEY,
      plan_version_id    TEXT NOT NULL REFERENCES plan_versions(id),
      stable_key         TEXT NOT NULL,
      title              TEXT NOT NULL,
      ordinal            INTEGER NOT NULL,
      status             TEXT NOT NULL CHECK(status IN (
        'PLANNED','READY','ACTIVE','BLOCKED','DONE','CANCELLED','SUPERSEDED'
      )),
      description        TEXT,
      UNIQUE(plan_version_id, stable_key),
      UNIQUE(plan_version_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS work_items (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL,
      plan_version_id    TEXT REFERENCES plan_versions(id),
      phase_id           TEXT REFERENCES phases(id),
      parent_work_item_id TEXT REFERENCES work_items(id),
      stable_key         TEXT NOT NULL,
      work_type          TEXT NOT NULL CHECK(work_type IN (
        'IMPLEMENTATION','BUG','RESEARCH','DESIGN','TEST','BENCHMARK',
        'DOCUMENTATION','REVIEW','OWNER_ACTION','ENVIRONMENT_SETUP','MAINTENANCE'
      )),
      executor_kind      TEXT NOT NULL CHECK(executor_kind IN (
        'AGENT','OWNER','SYSTEM','EXTERNAL'
      )),
      title              TEXT NOT NULL,
      description        TEXT,
      priority           INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL CHECK(status IN (
        'PROPOSED','READY','BLOCKED','IN_PROGRESS','VERIFYING','DONE',
        'FAILED','CANCELLED','SUPERSEDED'
      )),
      lock_version       INTEGER NOT NULL DEFAULT 0,
      created_at_ms      INTEGER NOT NULL,
      updated_at_ms      INTEGER NOT NULL,
      UNIQUE(project_id, stable_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_work_items_ready
      ON work_items(project_id, executor_kind, status, priority DESC, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_work_items_phase
      ON work_items(phase_id, status);
    CREATE INDEX IF NOT EXISTS idx_work_items_parent
      ON work_items(parent_work_item_id);

    CREATE TABLE IF NOT EXISTS work_item_relations (
      id                 TEXT PRIMARY KEY,
      from_work_item_id  TEXT NOT NULL REFERENCES work_items(id),
      to_work_item_id    TEXT NOT NULL REFERENCES work_items(id),
      relation_kind      TEXT NOT NULL CHECK(relation_kind IN (
        'BLOCKS','PRECEDES','RELATES_TO','DUPLICATES','SUPERSEDES'
      )),
      created_at_ms      INTEGER NOT NULL,
      CHECK(from_work_item_id <> to_work_item_id),
      UNIQUE(from_work_item_id, to_work_item_id, relation_kind)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_work_rel_from
      ON work_item_relations(from_work_item_id, relation_kind);
    CREATE INDEX IF NOT EXISTS idx_work_rel_to
      ON work_item_relations(to_work_item_id, relation_kind);

    CREATE TABLE IF NOT EXISTS work_external_blockers (
      id                 TEXT PRIMARY KEY,
      work_item_id       TEXT NOT NULL REFERENCES work_items(id),
      blocker_kind       TEXT NOT NULL CHECK(blocker_kind IN (
        'OWNER','ENVIRONMENT','APPROVAL','EXTERNAL','BASELINE_DRIFT'
      )),
      title              TEXT NOT NULL,
      detail             TEXT,
      status             TEXT NOT NULL CHECK(status IN (
        'OPEN','RESOLVED','WAIVED','SUPERSEDED'
      )),
      external_ref       TEXT,
      created_at_ms      INTEGER NOT NULL,
      resolved_at_ms     INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_external_blockers_work
      ON work_external_blockers(work_item_id, status);

    CREATE TABLE IF NOT EXISTS acceptance_criteria (
      id                 TEXT PRIMARY KEY,
      work_item_id       TEXT NOT NULL REFERENCES work_items(id),
      ordinal            INTEGER NOT NULL,
      criterion_kind     TEXT NOT NULL CHECK(criterion_kind IN (
        'COMMAND','TEST','SQL_ASSERTION','GRAPH_ASSERTION','OWNER_CONFIRMATION'
      )),
      description        TEXT NOT NULL,
      required           INTEGER NOT NULL CHECK(required IN (0,1)),
      status             TEXT NOT NULL CHECK(status IN (
        'PENDING','PASSING','FAILING','BLOCKED','WAIVED'
      )),
      UNIQUE(work_item_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS verification_specs (
      id                 TEXT PRIMARY KEY,
      criterion_id       TEXT NOT NULL UNIQUE REFERENCES acceptance_criteria(id),
      verifier_kind      TEXT NOT NULL CHECK(verifier_kind IN (
        'COMMAND','TEST','SQL_ASSERTION','GRAPH_ASSERTION','OWNER_CONFIRMATION'
      )),
      command_text       TEXT,
      expected_exit_code INTEGER,
      query_text         TEXT,
      expected_json      TEXT,
      owner_instruction  TEXT,
      sandbox_required   INTEGER NOT NULL DEFAULT 1 CHECK(sandbox_required IN (0,1)),
      approval_required  INTEGER NOT NULL DEFAULT 0 CHECK(approval_required IN (0,1)),
      CHECK(
        (verifier_kind IN ('COMMAND','TEST') AND command_text IS NOT NULL)
        OR (verifier_kind IN ('SQL_ASSERTION','GRAPH_ASSERTION') AND query_text IS NOT NULL)
        OR (verifier_kind = 'OWNER_CONFIRMATION' AND owner_instruction IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS acceptance_evaluations (
      id                 TEXT PRIMARY KEY,
      criterion_id       TEXT NOT NULL REFERENCES acceptance_criteria(id),
      work_item_id       TEXT NOT NULL REFERENCES work_items(id),
      attempt_ref        TEXT,
      repo_head          TEXT,
      worktree_hash      TEXT,
      result             TEXT NOT NULL CHECK(result IN (
        'PASS','FAIL','BLOCKED','ERROR','WAIVED'
      )),
      observed_json      TEXT,
      verification_ref   TEXT,
      evaluated_by       TEXT NOT NULL,
      evaluated_at_ms    INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_accept_eval_criterion
      ON acceptance_evaluations(criterion_id, evaluated_at_ms DESC);

    CREATE TABLE IF NOT EXISTS project_events (
      project_id         TEXT NOT NULL,
      sequence_no        INTEGER NOT NULL,
      event_format_version INTEGER NOT NULL,
      event_type         TEXT NOT NULL,
      ignorable          INTEGER NOT NULL DEFAULT 0 CHECK(ignorable IN (0,1)),
      entity_type        TEXT,
      entity_id          TEXT,
      actor_ref          TEXT,
      payload_json       TEXT NOT NULL,
      created_at_ms      INTEGER NOT NULL,
      PRIMARY KEY(project_id, sequence_no)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_project_events_type
      ON project_events(project_id, event_type, sequence_no);

    CREATE TABLE IF NOT EXISTS plan_imports (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL,
      source_path        TEXT,
      source_hash        TEXT NOT NULL,
      schema_version     INTEGER NOT NULL,
      parser_version     TEXT NOT NULL,
      compiler_version   TEXT NOT NULL,
      status             TEXT NOT NULL CHECK(status IN (
        'PARSED','VALIDATED','COMPILED','IMPORTED','REJECTED'
      )),
      plan_version_id    TEXT REFERENCES plan_versions(id),
      imported_at_ms     INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS plan_compile_diagnostics (
      id                 TEXT PRIMARY KEY,
      plan_import_id     TEXT NOT NULL REFERENCES plan_imports(id),
      severity           TEXT NOT NULL CHECK(severity IN ('ERROR','WARNING','INFO')),
      code               TEXT NOT NULL,
      source_path        TEXT,
      source_line        INTEGER,
      source_column      INTEGER,
      message            TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_plan_diag_import
      ON plan_compile_diagnostics(plan_import_id, severity);

    CREATE TABLE IF NOT EXISTS work_leases (
      id                 TEXT PRIMARY KEY,
      work_item_id       TEXT NOT NULL REFERENCES work_items(id),
      worker_identity    TEXT NOT NULL,
      lease_token_hash   TEXT NOT NULL,
      status             TEXT NOT NULL CHECK(status IN (
        'ACTIVE','RELEASED','EXPIRED','REVOKED'
      )),
      acquired_at_ms     INTEGER NOT NULL,
      heartbeat_at_ms    INTEGER NOT NULL,
      expires_at_ms      INTEGER NOT NULL,
      released_at_ms     INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_lease_per_work
      ON work_leases(work_item_id)
      WHERE status = 'ACTIVE';
    CREATE INDEX IF NOT EXISTS idx_lease_expiry
      ON work_leases(status, expires_at_ms);
  `)
}
