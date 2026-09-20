/**
 * Physical schema of the project ledger database: the open/configure
 * sequence (owner-only files, pragmas, version stamp/reject), the shipped
 * adjacent migration steps, the v1 Ledger Core layout — plans, plan
 * versions, phases, work items, work item relations, external blockers,
 * acceptance criteria, verification specs, acceptance evaluations, project
 * events, plan imports, compile diagnostics, and work leases — the v1.6b
 * decision-domain layout (decision requests, options, decisions), its
 * approval layout (blueprint §24: approvals over a typed subject reference,
 * kept separate from decisions), its resource layout (blueprint
 * §25/§26/§27: requirements, instances, verifications), its actor/role
 * layout (blueprint §3/§4: actors, roles, and the assignments between them),
 * the v1.6d work-assignment layout (blueprint §18: an actor's duty on
 * one work item), the v1.6d handoff layout (blueprint §28: one recorded
 * pass of a work item between actors), and the v1.6d stage-B scope
 * reservation layout (blueprint §21: an actor's exclusive claim on one
 * project scope).
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
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'v1.6b decision domain (decision requests, options, decisions)',
    apply: createDecisionTables,
  },
  {
    fromVersion: 2,
    toVersion: 3,
    description: 'v1.6b approval domain (approvals)',
    apply: createApprovalTables,
  },
  {
    fromVersion: 3,
    toVersion: 4,
    description: 'v1.6b resource domain (resource requirements, instances, verifications)',
    apply: createResourceTables,
  },
  {
    fromVersion: 4,
    toVersion: 5,
    description: 'v1.6b actor/role domain (actors, roles, actor roles)',
    apply: createActorTables,
  },
  {
    fromVersion: 5,
    toVersion: 6,
    description: 'v1.6d work-assignment domain (work assignments)',
    apply: createWorkAssignmentTables,
  },
  {
    fromVersion: 6,
    toVersion: 7,
    description: 'v1.6d handoff domain (handoffs)',
    apply: createHandoffTables,
  },
  {
    fromVersion: 7,
    toVersion: 8,
    description: 'v1.6d stage-B scope-reservation domain (scope reservations)',
    apply: createScopeReservationTables,
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

/** Materialize the v1.6b decision-domain tables and indexes. Idempotent by design. */
function createDecisionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_requests (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL,
      plan_version_id   TEXT REFERENCES plan_versions(id),
      decision_key      TEXT NOT NULL,
      title             TEXT NOT NULL,
      question          TEXT NOT NULL,
      context           TEXT,
      blocking_level    TEXT NOT NULL CHECK(blocking_level IN (
        'BLOCKING','ADVISORY'
      )),
      status            TEXT NOT NULL CHECK(status IN (
        'OPEN','RESOLVED'
      )),
      raised_by         TEXT,
      created_at_ms     INTEGER NOT NULL,
      resolved_at_ms    INTEGER,
      UNIQUE(project_id, decision_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_decision_requests_project
      ON decision_requests(project_id, status, created_at_ms);

    CREATE TABLE IF NOT EXISTS decision_options (
      id                  TEXT PRIMARY KEY,
      decision_request_id TEXT NOT NULL REFERENCES decision_requests(id),
      option_key          TEXT NOT NULL,
      label               TEXT NOT NULL,
      description         TEXT,
      recommended         INTEGER NOT NULL DEFAULT 0 CHECK(recommended IN (0,1)),
      ordinal             INTEGER NOT NULL,
      UNIQUE(decision_request_id, option_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS decisions (
      id                  TEXT PRIMARY KEY,
      decision_request_id TEXT NOT NULL UNIQUE REFERENCES decision_requests(id),
      decided_by          TEXT NOT NULL,
      selected_option_id  TEXT REFERENCES decision_options(id),
      decision_text       TEXT NOT NULL,
      rationale           TEXT,
      decided_at_ms       INTEGER NOT NULL
    ) STRICT;
  `)
}

/**
 * Materialize the v1.6b approval-domain table and indexes (blueprint §24,
 * adapted like the decision domain: inline text, actor strings). Idempotent
 * by design.
 */
function createApprovalTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      subject_type    TEXT NOT NULL CHECK(subject_type IN (
        'plan-version','work-item','decision'
      )),
      subject_id      TEXT NOT NULL,
      required_role   TEXT,
      requested_by    TEXT,
      status          TEXT NOT NULL CHECK(status IN (
        'PENDING','APPROVED','REJECTED'
      )),
      decision_text   TEXT,
      decided_by      TEXT,
      requested_at_ms INTEGER NOT NULL,
      decided_at_ms   INTEGER,
      CHECK((status = 'PENDING') = (decided_by IS NULL)),
      CHECK((status = 'PENDING') = (decision_text IS NULL)),
      CHECK((status = 'PENDING') = (decided_at_ms IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_approvals_project
      ON approvals(project_id, status, requested_at_ms);
    CREATE INDEX IF NOT EXISTS idx_approvals_subject
      ON approvals(subject_type, subject_id);
  `)
}

/**
 * Materialize the v1.6b resource-domain tables and indexes (blueprint
 * §25/§26/§27, adapted like the decision and approval domains: inline spec
 * and JSON text, actor strings, project-scoped key uniqueness). Statuses
 * beyond the writer-reachable ones are reserved rows. Idempotent by design.
 */
function createResourceTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_requirements (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      plan_version_id TEXT REFERENCES plan_versions(id),
      requirement_key TEXT NOT NULL,
      requirement_kind TEXT NOT NULL,
      name            TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN (
        'OPEN','FULFILLED','CANCELLED'
      )),
      requested_from  TEXT,
      created_at_ms   INTEGER NOT NULL,
      UNIQUE(project_id, requirement_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_resource_requirements_project
      ON resource_requirements(project_id, status, created_at_ms);

    CREATE TABLE IF NOT EXISTS resource_instances (
      id              TEXT PRIMARY KEY,
      requirement_id  TEXT NOT NULL REFERENCES resource_requirements(id),
      provider        TEXT,
      label           TEXT NOT NULL,
      metadata_json   TEXT,
      status          TEXT NOT NULL CHECK(status IN (
        'AVAILABLE','RETIRED'
      )),
      provided_at_ms  INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_resource_instances_requirement
      ON resource_instances(requirement_id, status);

    CREATE TABLE IF NOT EXISTS resource_verifications (
      id                    TEXT PRIMARY KEY,
      resource_instance_id  TEXT NOT NULL REFERENCES resource_instances(id),
      verifier              TEXT,
      verifier_kind         TEXT NOT NULL CHECK(verifier_kind IN (
        'COMMAND','TEST','SQL_ASSERTION','GRAPH_ASSERTION','OWNER_CONFIRMATION'
      )),
      verification_spec     TEXT NOT NULL,
      observed_json         TEXT,
      result                TEXT NOT NULL CHECK(result IN ('PASS','FAIL')),
      verified_at_ms        INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_resource_verifications_instance
      ON resource_verifications(resource_instance_id, verified_at_ms);
  `)
}

/**
 * Materialize the v1.6b actor/role tables and indexes (blueprint §3/§4,
 * adapted like the other v1.6b domains: actor strings become the project
 * `actor_key` the decision, approval, and resource actor columns already
 * record; kinds and statuses use the ledger's uppercase controlled sets;
 * `INACTIVE` and a non-null `valid_to_ms` are reserved with no writer yet).
 * An actor holds a role at most once at a time, enforced by the partial
 * unique index over live assignments. Idempotent by design.
 */
function createActorTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actors (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL,
      actor_key         TEXT NOT NULL,
      actor_kind        TEXT NOT NULL CHECK(actor_kind IN (
        'HUMAN','AGENT','SERVICE','SYSTEM'
      )),
      display_name      TEXT NOT NULL,
      external_identity TEXT,
      metadata_json     TEXT,
      status            TEXT NOT NULL CHECK(status IN (
        'ACTIVE','INACTIVE'
      )),
      created_at_ms     INTEGER NOT NULL,
      UNIQUE(project_id, actor_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_actors_project_kind
      ON actors(project_id, actor_kind, status);

    CREATE TABLE IF NOT EXISTS roles (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL,
      role_name      TEXT NOT NULL,
      role_kind      TEXT NOT NULL CHECK(role_kind IN (
        'GOVERNANCE','EXECUTION'
      )),
      description    TEXT,
      created_at_ms  INTEGER NOT NULL,
      UNIQUE(project_id, role_name)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS actor_roles (
      id             TEXT PRIMARY KEY,
      actor_id       TEXT NOT NULL REFERENCES actors(id),
      role_id        TEXT NOT NULL REFERENCES roles(id),
      valid_from_ms  INTEGER NOT NULL,
      valid_to_ms    INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_assignment_per_pair
      ON actor_roles(actor_id, role_id)
      WHERE valid_to_ms IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actor_roles_actor
      ON actor_roles(actor_id, role_id);
  `)
}

/**
 * Materialize the v1.6d work-assignment table (blueprint §18, adapted like
 * the earlier domains: the blueprint's actor_id/role_id columns reference
 * the v1.6b actors/roles rows directly, the blueprint's six assignment
 * kinds close uppercase to the ledger convention, and `ENDED` plus the
 * acceptance and completion timestamps are reserved with no writer yet).
 * One work item holds at most one live PRIMARY assignment, enforced by the
 * partial unique index over live primary rows; the item/actor indexes cover
 * the blueprint §57 query requirement. Idempotent by design.
 */
function createWorkAssignmentTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_assignments (
      id               TEXT PRIMARY KEY,
      work_item_id     TEXT NOT NULL REFERENCES work_items(id),
      actor_id         TEXT NOT NULL REFERENCES actors(id),
      role_id          TEXT REFERENCES roles(id),
      assignment_kind  TEXT NOT NULL CHECK(assignment_kind IN (
        'PRIMARY','COLLABORATOR','REVIEWER','TESTER','OBSERVER','ACCOUNTABLE'
      )),
      status           TEXT NOT NULL CHECK(status IN (
        'ACTIVE','ENDED'
      )),
      assigned_at_ms   INTEGER NOT NULL,
      accepted_at_ms   INTEGER,
      completed_at_ms  INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_primary_per_work
      ON work_assignments(work_item_id)
      WHERE status = 'ACTIVE' AND assignment_kind = 'PRIMARY';
    CREATE INDEX IF NOT EXISTS idx_work_assignments_item
      ON work_assignments(work_item_id, status);
    CREATE INDEX IF NOT EXISTS idx_work_assignments_actor
      ON work_assignments(actor_id, status);
  `)
}

/**
 * Materialize the v1.6d handoff table (blueprint §28, adapted like the
 * earlier domains: `project_id` derives through the work item row, the
 * blueprint's `summary_content_id` indirection becomes inline summary text,
 * the unvalued `handoff_kind` closes uppercase to the ledger convention,
 * and `accepted_at_ms` is reserved with no writer yet). A handoff names
 * exactly one recipient — an actor or a role — enforced by the recipient
 * check. Idempotent by design.
 */
function createHandoffTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id                 TEXT PRIMARY KEY,
      work_item_id       TEXT NOT NULL REFERENCES work_items(id),
      from_actor_id      TEXT NOT NULL REFERENCES actors(id),
      to_actor_id        TEXT REFERENCES actors(id),
      to_role_id         TEXT REFERENCES roles(id),
      handoff_kind       TEXT NOT NULL CHECK(handoff_kind IN (
        'DELEGATE','RETURN'
      )),
      summary            TEXT NOT NULL,
      artifact_refs_json TEXT,
      memory_refs_json   TEXT,
      recorded_at_ms     INTEGER NOT NULL,
      accepted_at_ms     INTEGER,
      CHECK((to_actor_id IS NULL) <> (to_role_id IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_handoffs_item
      ON handoffs(work_item_id, recorded_at_ms);
  `)
}

/**
 * Materialize the v1.6d stage-B scope-reservation table (blueprint §21,
 * adapted like the earlier domains: `project_id` stays because the scope's
 * uniqueness is project-scoped, foreign keys reference the work-item and
 * actor rows directly, the blueprint's `mode` column is dropped — every
 * reservation ships exclusive — and the unvalued `scope_kind` closes
 * uppercase to the ledger convention). One project scope holds at most one
 * active reservation, enforced by the partial unique index; the blueprint's
 * `idx_scope_active` ships as-is and the expiry index mirrors the lease
 * reaper's scan. Idempotent by design.
 */
function createScopeReservationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope_reservations (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL,
      work_item_id   TEXT NOT NULL REFERENCES work_items(id),
      actor_id       TEXT NOT NULL REFERENCES actors(id),
      scope_kind     TEXT NOT NULL CHECK(scope_kind IN ('PATH')),
      scope_value    TEXT NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms  INTEGER NOT NULL,
      released_at_ms INTEGER,
      status         TEXT NOT NULL CHECK(status IN ('ACTIVE','RELEASED','EXPIRED'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_scope_active
      ON scope_reservations(project_id, status, scope_kind, scope_value);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_reservation_per_scope
      ON scope_reservations(project_id, scope_kind, scope_value)
      WHERE status = 'ACTIVE';
    CREATE INDEX IF NOT EXISTS idx_scope_reservation_expiry
      ON scope_reservations(status, expires_at_ms);
  `)
}
