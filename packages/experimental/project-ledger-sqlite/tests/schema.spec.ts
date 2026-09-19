import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LEDGER_BUSY_TIMEOUT_MS,
  PROJECT_LEDGER_MIGRATIONS,
  PROJECT_LEDGER_SCHEMA_VERSION,
  ProjectLedgerError,
  applyProjectLedgerMigrations,
  openProjectLedgerDatabase,
} from '../src/index.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-ledger-'))
  roots.push(root)
  return join(root, name)
}

function rawVersion(path: string): number {
  const raw = new DatabaseSync(path)
  try {
    return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    raw.close()
  }
}

function userVersionOf(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

const LEDGER_TABLES = [
  'acceptance_criteria',
  'acceptance_evaluations',
  'actor_roles',
  'actors',
  'approvals',
  'decision_options',
  'decision_requests',
  'decisions',
  'phases',
  'plan_compile_diagnostics',
  'plan_imports',
  'plan_versions',
  'plans',
  'project_events',
  'resource_instances',
  'resource_requirements',
  'resource_verifications',
  'roles',
  'verification_specs',
  'work_assignments',
  'work_external_blockers',
  'work_item_relations',
  'work_items',
  'work_leases',
]

const LEDGER_INDEXES = [
  'idx_accept_eval_criterion',
  'idx_actor_roles_actor',
  'idx_actors_project_kind',
  'idx_approvals_project',
  'idx_approvals_subject',
  'idx_decision_requests_project',
  'idx_external_blockers_work',
  'idx_lease_expiry',
  'idx_plan_diag_import',
  'idx_plan_versions_plan_status',
  'idx_project_events_type',
  'idx_resource_instances_requirement',
  'idx_resource_requirements_project',
  'idx_resource_verifications_instance',
  'idx_work_assignments_actor',
  'idx_work_assignments_item',
  'idx_work_items_parent',
  'idx_work_items_phase',
  'idx_work_items_ready',
  'idx_work_rel_from',
  'idx_work_rel_to',
  'uq_one_active_lease_per_work',
  'uq_one_live_assignment_per_pair',
  'uq_one_live_primary_per_work',
]

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map(row => row.name)
}

function indexNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map(row => row.name)
}

/** Populate one plan → version → phase → work item chain of valid rows. */
function insertFixtureChain(db: DatabaseSync): void {
  db.exec("INSERT INTO plans(id, project_id, name, created_at_ms) VALUES('plan_1','proj_1','golden',1)")
  db.exec("INSERT INTO plan_versions(id, plan_id, version_no, status, source_document_hash, compiled_ir_hash, created_at_ms) VALUES('pv_1','plan_1',1,'DRAFT','hash-source','hash-ir',1)")
  db.exec("INSERT INTO phases(id, plan_version_id, stable_key, title, ordinal, status) VALUES('phase_1','pv_1','w02','Ledger SQLite runtime',2,'PLANNED')")
  db.exec("INSERT INTO work_items(id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, executor_kind, title, priority, status, created_at_ms, updated_at_ms) VALUES('work_1','proj_1','pv_1','phase_1',NULL,'DB-001','IMPLEMENTATION','AGENT','Ledger SQLite runtime',85,'PROPOSED',1,1)")
}

function insertCriterion(db: DatabaseSync, id: string, ordinal: number, kind: string): void {
  db.exec(`INSERT INTO acceptance_criteria(id, work_item_id, ordinal, criterion_kind, description, required, status)
    VALUES('${id}','work_1',${ordinal},'${kind}','fixture criterion',1,'PENDING')`)
}

function insertLease(db: DatabaseSync, id: string, workItemId: string): void {
  db.exec(`INSERT INTO work_leases(
    id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms
  ) VALUES('${id}','${workItemId}','worker-a','token-${id}','ACTIVE',1,1,100)`)
}

const WORK_ITEM_INSERT_SQL = 'INSERT INTO work_items('
  + 'id, project_id, plan_version_id, phase_id, parent_work_item_id, stable_key, work_type, '
  + 'executor_kind, title, status, created_at_ms, updated_at_ms)'

describe('open and configure', () => {
  it('creates a fresh on-disk database stamped with the current schema version', async () => {
    const path = tmpFile('ledger.sqlite')
    const db = await openProjectLedgerDatabase(path)
    expect(userVersionOf(db)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    db.close()
    expect(rawVersion(path)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
  })

  it('materializes exactly the Ledger Core, decision-, and approval-domain tables and indexes', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    expect(tableNames(db)).toEqual(LEDGER_TABLES)
    expect(indexNames(db)).toEqual(LEDGER_INDEXES)
    db.close()
  })

  it('creates owner-only directories and database files', async () => {
    const path = tmpFile('nested/ledger.sqlite')
    const db = await openProjectLedgerDatabase(path)
    db.close()
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    }
  })

  it('opens an in-memory database without touching the filesystem', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    expect(userVersionOf(db)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    expect(tableNames(db)).toEqual(LEDGER_TABLES)
    db.close()
  })

  it('defaults the busy timeout and journal mode to the durable WAL configuration', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(timeout.timeout).toBe(DEFAULT_LEDGER_BUSY_TIMEOUT_MS)
    db.close()
    const path = tmpFile('wal.sqlite')
    const fileDb = await openProjectLedgerDatabase(path)
    const mode = fileDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
    fileDb.close()
  })

  it('honors busy timeout and journal mode overrides', async () => {
    const path = tmpFile('rollback-journal.sqlite')
    const db = await openProjectLedgerDatabase(path, { busyTimeoutMs: 250, journalMode: 'delete' })
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(timeout.timeout).toBe(250)
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('delete')
    db.close()
  })

  it('rejects a busy timeout that is not a non-negative integer', async () => {
    await expect(openProjectLedgerDatabase(':memory:', { busyTimeoutMs: -1 }))
      .rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(openProjectLedgerDatabase(':memory:', { busyTimeoutMs: 1.5 }))
      .rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('fails loud when the database path is an existing directory', async () => {
    const path = tmpFile('occupant')
    mkdirSync(path)
    await expect(openProjectLedgerDatabase(path)).rejects.toThrow()
  })

  it('fails loud when the database file cannot be created', async () => {
    // A filename beyond the filesystem's per-component limit fails the
    // exclusive create with something other than EEXIST, which must propagate.
    const path = tmpFile('x'.repeat(300))
    await expect(openProjectLedgerDatabase(path)).rejects.toThrow()
  })
})

describe('schema version handling', () => {
  it('rejects a database stamped with an unknown newer version and leaves it untouched', async () => {
    const path = tmpFile('from-the-future.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 999')
    raw.close()
    await expect(openProjectLedgerDatabase(path)).rejects.toThrow(ProjectLedgerError)
    await expect(openProjectLedgerDatabase(path)).rejects.toMatchObject({ code: 'version-mismatch' })
    expect(rawVersion(path)).toBe(999)
    const untouched = new DatabaseSync(path)
    try {
      expect(tableNames(untouched)).toEqual([])
    } finally {
      untouched.close()
    }
  })

  it('reopens an already-current database without restamping', async () => {
    const path = tmpFile('reopen.sqlite')
    const first = await openProjectLedgerDatabase(path)
    insertFixtureChain(first)
    first.close()
    const second = await openProjectLedgerDatabase(path)
    const plans = second.prepare('SELECT COUNT(*) AS n FROM plans').get() as { n: number }
    expect(plans.n).toBe(1)
    expect(userVersionOf(second)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    second.close()
  })
})

describe('adjacent migration fixture', () => {
  it('upgrades an interrupted v1 materialization without losing rows', async () => {
    const path = tmpFile('interrupted.sqlite')
    const first = await openProjectLedgerDatabase(path)
    insertFixtureChain(first)
    first.close()

    // Simulate the crash window: the layout exists but the version stamp never landed.
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 0')
    raw.close()

    const reopened = await openProjectLedgerDatabase(path)
    expect(userVersionOf(reopened)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    const counts = reopened.prepare('SELECT (SELECT COUNT(*) FROM plans) AS plans, (SELECT COUNT(*) FROM plan_versions) AS versions, (SELECT COUNT(*) FROM phases) AS phases, (SELECT COUNT(*) FROM work_items) AS items').get() as {
      plans: number
      versions: number
      phases: number
      items: number
    }
    expect(counts).toEqual({ plans: 1, versions: 1, phases: 1, items: 1 })
    const foreignKeyViolations = reopened.prepare('PRAGMA foreign_key_check').all()
    expect(foreignKeyViolations).toEqual([])
    const integrity = reopened.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    expect(integrity.integrity_check).toBe('ok')
    reopened.close()
  })

  it('upgrades a v1 database through the shipped 1→2 step without losing rows', async () => {
    const path = tmpFile('v1-to-v2.sqlite')
    // A real v1 database: the shipped 0→1 step's own layout, stamped as v1.
    const coreStep = PROJECT_LEDGER_MIGRATIONS[0]
    if (coreStep === undefined) throw new Error('test setup: the registry ships no core step')
    const raw = new DatabaseSync(path)
    coreStep.apply(raw)
    raw.exec('PRAGMA user_version = 1')
    raw.close()

    const reopened = await openProjectLedgerDatabase(path)
    expect(userVersionOf(reopened)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    expect(tableNames(reopened)).toEqual(LEDGER_TABLES)
    expect(indexNames(reopened)).toEqual(LEDGER_INDEXES)
    reopened.close()
  })

  it('upgrades a v2 database through the shipped 2→3 step without losing rows', async () => {
    const path = tmpFile('v2-to-v3.sqlite')
    // A real v2 database: the shipped 0→1 and 1→2 steps' own layout, stamped
    // as v2 and carrying one decision row.
    const [coreStep, decisionStep] = PROJECT_LEDGER_MIGRATIONS
    if (coreStep === undefined || decisionStep === undefined) {
      throw new Error('test setup: the registry ships no core or decision step')
    }
    const raw = new DatabaseSync(path)
    coreStep.apply(raw)
    decisionStep.apply(raw)
    raw.exec(
      'INSERT INTO decision_requests '
      + '(id, project_id, plan_version_id, decision_key, title, question, blocking_level, status, created_at_ms) '
      + "VALUES ('dr:p:v1.6b-entry', 'p', NULL, 'v1.6b-entry', 'Entry', 'Q?', 'BLOCKING', 'RESOLVED', 1)",
    )
    raw.exec('PRAGMA user_version = 2')
    raw.close()

    const reopened = await openProjectLedgerDatabase(path)
    expect(userVersionOf(reopened)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    expect(tableNames(reopened)).toEqual(LEDGER_TABLES)
    expect(indexNames(reopened)).toEqual(LEDGER_INDEXES)
    const decisions = reopened.prepare('SELECT COUNT(*) AS n FROM decision_requests').get() as { n: number }
    expect(decisions.n).toBe(1)
    const approvals = reopened.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }
    expect(approvals.n).toBe(0)
    reopened.close()
  })

  it('upgrades a v3 database through the shipped 3→4 step without losing rows', async () => {
    const path = tmpFile('v3-to-v4.sqlite')
    // A real v3 database: the shipped steps' own layout, stamped as v3 and
    // carrying one approval row.
    const [coreStep, decisionStep, approvalStep] = PROJECT_LEDGER_MIGRATIONS
    if (coreStep === undefined || decisionStep === undefined || approvalStep === undefined) {
      throw new Error('test setup: the registry ships a missing step')
    }
    const raw = new DatabaseSync(path)
    coreStep.apply(raw)
    decisionStep.apply(raw)
    approvalStep.apply(raw)
    raw.exec(
      'INSERT INTO approvals '
      + '(id, project_id, subject_type, subject_id, required_role, requested_by, status, requested_at_ms) '
      + "VALUES ('ap:p:1', 'p', 'plan-version', 'plv:x:v1', NULL, 'owner', 'PENDING', 1)",
    )
    raw.exec('PRAGMA user_version = 3')
    raw.close()

    const reopened = await openProjectLedgerDatabase(path)
    expect(userVersionOf(reopened)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    expect(tableNames(reopened)).toEqual(LEDGER_TABLES)
    expect(indexNames(reopened)).toEqual(LEDGER_INDEXES)
    const approvals = reopened.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }
    expect(approvals.n).toBe(1)
    const requirements = reopened.prepare('SELECT COUNT(*) AS n FROM resource_requirements').get() as { n: number }
    expect(requirements.n).toBe(0)
    reopened.close()
  })

  it('upgrades a v4 database through the shipped 4→5 step without losing rows', async () => {
    const path = tmpFile('v4-to-v5.sqlite')
    // A real v4 database: the shipped steps' own layout, stamped as v4 and
    // carrying one resource row.
    const [coreStep, decisionStep, approvalStep, resourceStep] = PROJECT_LEDGER_MIGRATIONS
    if (coreStep === undefined || decisionStep === undefined || approvalStep === undefined
      || resourceStep === undefined) {
      throw new Error('test setup: the registry ships a missing step')
    }
    const raw = new DatabaseSync(path)
    coreStep.apply(raw)
    decisionStep.apply(raw)
    approvalStep.apply(raw)
    resourceStep.apply(raw)
    raw.exec(
      'INSERT INTO resource_requirements '
      + '(id, project_id, plan_version_id, requirement_key, requirement_kind, name, constraints_json, status, created_at_ms) '
      + "VALUES ('rr:p:1', 'p', NULL, 'k', 'K', 'N', '{}', 'OPEN', 1)",
    )
    raw.exec('PRAGMA user_version = 4')
    raw.close()

    const reopened = await openProjectLedgerDatabase(path)
    expect(userVersionOf(reopened)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    expect(tableNames(reopened)).toEqual(LEDGER_TABLES)
    expect(indexNames(reopened)).toEqual(LEDGER_INDEXES)
    const requirements = reopened.prepare('SELECT COUNT(*) AS n FROM resource_requirements').get() as { n: number }
    expect(requirements.n).toBe(1)
    const actors = reopened.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }
    expect(actors.n).toBe(0)
    reopened.close()
  })

  it('upgrades a v5 database through the shipped 5→6 step without losing rows', async () => {
    const path = tmpFile('v5-to-v6.sqlite')
    // A real v5 database: the shipped steps' own layout, stamped as v5 and
    // carrying one actor row.
    const [coreStep, decisionStep, approvalStep, resourceStep, actorStep] = PROJECT_LEDGER_MIGRATIONS
    if (coreStep === undefined || decisionStep === undefined || approvalStep === undefined
      || resourceStep === undefined || actorStep === undefined) {
      throw new Error('test setup: the registry ships a missing step')
    }
    const raw = new DatabaseSync(path)
    coreStep.apply(raw)
    decisionStep.apply(raw)
    approvalStep.apply(raw)
    resourceStep.apply(raw)
    actorStep.apply(raw)
    raw.exec(
      'INSERT INTO actors '
      + '(id, project_id, actor_key, actor_kind, display_name, status, created_at_ms) '
      + "VALUES ('actor:p:1', 'p', 'k', 'AGENT', 'A', 'ACTIVE', 1)",
    )
    raw.exec('PRAGMA user_version = 5')
    raw.close()

    const reopened = await openProjectLedgerDatabase(path)
    expect(userVersionOf(reopened)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
    expect(tableNames(reopened)).toEqual(LEDGER_TABLES)
    expect(indexNames(reopened)).toEqual(LEDGER_INDEXES)
    const actors = reopened.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }
    expect(actors.n).toBe(1)
    const assignments = reopened.prepare('SELECT COUNT(*) AS n FROM work_assignments').get() as { n: number }
    expect(assignments.n).toBe(0)
    reopened.close()
  })

  it('upgrades the committed v1 fixture databases through the same steps', async () => {
    const fixtureRoot = resolve(REPO_ROOT, 'fixtures/project-ledger')
    for (const name of ['v1.6a-empty.db', 'v1.6a-populated.db']) {
      const path = tmpFile(`fixture-${name}`)
      copyFileSync(join(fixtureRoot, name), path)
      const db = await openProjectLedgerDatabase(path)
      try {
        expect(userVersionOf(db)).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
        const decisions = db.prepare('SELECT COUNT(*) AS n FROM decision_requests').get() as { n: number }
        expect(decisions.n).toBe(0)
        const events = db.prepare('SELECT COUNT(*) AS n FROM project_events').get() as { n: number }
        expect(events.n).toBe(name === 'v1.6a-populated.db' ? 28 : 0)
      } finally {
        db.close()
      }
    }
  })

  it('rejects a migration registry with a version gap', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => applyProjectLedgerMigrations(db, 0, ':memory:', [
      { fromVersion: 0, toVersion: 1, description: 'ok', apply: () => undefined },
      { fromVersion: 2, toVersion: 3, description: 'gap', apply: () => undefined },
    ])).toThrow(ProjectLedgerError)
    db.close()
  })

  it('rejects a registry that stops below the build schema version', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => applyProjectLedgerMigrations(db, 0, ':memory:', [])).toThrow(ProjectLedgerError)
    db.close()
  })

  it('rolls back a failed migration step and rethrows', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => applyProjectLedgerMigrations(db, 0, ':memory:', [
      {
        fromVersion: 0,
        toVersion: 1,
        description: 'explodes halfway',
        apply: (handle) => {
          handle.exec('CREATE TABLE should_rollback (a INTEGER)')
          throw new Error('boom')
        },
      },
    ])).toThrow('boom')
    expect(userVersionOf(db)).toBe(0)
    expect(tableNames(db)).toEqual([])
    db.close()
  })
})

describe('Ledger Core schema contract', () => {
  it('keeps plans free of a second status authority', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    const columns = (db.prepare('PRAGMA table_info(plans)').all() as { name: string }[]).map(row => row.name)
    expect(columns).toEqual(['id', 'project_id', 'name', 'current_version_id', 'created_at_ms'])
    db.close()
  })

  it('enforces STRICT column types', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    expect(() => {
      db.exec("INSERT INTO plans(id, project_id, name, created_at_ms) VALUES('plan_bad','proj_1','bad','not-a-number')")
    }).toThrow()
    db.close()
  })

  it('enforces foreign keys across child tables', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    insertFixtureChain(db)
    insertCriterion(db, 'ac_1', 0, 'COMMAND')
    db.exec("INSERT INTO verification_specs(id, criterion_id, verifier_kind, command_text) VALUES('spec_1','ac_1','COMMAND','true')")
    const orphanInserts: [string, string][] = [
      ['plan_versions.plan_id', "INSERT INTO plan_versions(id, plan_id, version_no, status, source_document_hash, compiled_ir_hash, created_at_ms) VALUES('pv_x','missing',1,'DRAFT','h','h',1)"],
      ['phases.plan_version_id', "INSERT INTO phases(id, plan_version_id, stable_key, title, ordinal, status) VALUES('phase_x','missing','k','t',1,'PLANNED')"],
      ['work_items.plan_version_id', `${WORK_ITEM_INSERT_SQL} VALUES('work_x','proj_1','missing','phase_1',NULL,'K-1','IMPLEMENTATION','AGENT','t','PROPOSED',1,1)`],
      ['work_items.phase_id', `${WORK_ITEM_INSERT_SQL} VALUES('work_x','proj_1','pv_1','missing',NULL,'K-1','IMPLEMENTATION','AGENT','t','PROPOSED',1,1)`],
      ['work_items.parent_work_item_id', `${WORK_ITEM_INSERT_SQL} VALUES('work_x','proj_1','pv_1','phase_1','missing','K-1','IMPLEMENTATION','AGENT','t','PROPOSED',1,1)`],
      ['work_item_relations.from_work_item_id', "INSERT INTO work_item_relations(id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) VALUES('rel_x','missing','work_1','BLOCKS',1)"],
      ['work_item_relations.to_work_item_id', "INSERT INTO work_item_relations(id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) VALUES('rel_x','work_1','missing','BLOCKS',1)"],
      ['work_external_blockers.work_item_id', "INSERT INTO work_external_blockers(id, work_item_id, blocker_kind, title, status, created_at_ms) VALUES('block_x','missing','OWNER','waiting','OPEN',1)"],
      ['acceptance_criteria.work_item_id', "INSERT INTO acceptance_criteria(id, work_item_id, ordinal, criterion_kind, description, required, status) VALUES('ac_x','missing',0,'COMMAND','d',1,'PENDING')"],
      ['verification_specs.criterion_id', "INSERT INTO verification_specs(id, criterion_id, verifier_kind, command_text) VALUES('spec_x','missing','COMMAND','true')"],
      ['acceptance_evaluations.criterion_id', "INSERT INTO acceptance_evaluations(id, criterion_id, work_item_id, result, evaluated_by, evaluated_at_ms) VALUES('ev_x','missing','work_1','PASS','fixture',1)"],
      ['acceptance_evaluations.work_item_id', "INSERT INTO acceptance_evaluations(id, criterion_id, work_item_id, result, evaluated_by, evaluated_at_ms) VALUES('ev_x','ac_1','missing','PASS','fixture',1)"],
      ['plan_imports.plan_version_id', "INSERT INTO plan_imports(id, project_id, source_hash, schema_version, parser_version, compiler_version, status, plan_version_id) VALUES('imp_x','proj_1','h',1,'p','c','IMPORTED','missing')"],
      ['plan_compile_diagnostics.plan_import_id', "INSERT INTO plan_compile_diagnostics(id, plan_import_id, severity, code, message) VALUES('diag_x','missing','ERROR','C','m')"],
      ['work_leases.work_item_id', "INSERT INTO work_leases(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms) VALUES('lease_x','missing','worker','token','ACTIVE',1,1,2)"],
      ['work_assignments.work_item_id', "INSERT INTO work_assignments(id, work_item_id, actor_id, role_id, assignment_kind, status, assigned_at_ms) VALUES('wa_x','missing','actor_x',NULL,'PRIMARY','ACTIVE',1)"],
      ['work_assignments.actor_id', "INSERT INTO work_assignments(id, work_item_id, actor_id, role_id, assignment_kind, status, assigned_at_ms) VALUES('wa_x','work_1','actor_x',NULL,'PRIMARY','ACTIVE',1)"],
      ['work_assignments.role_id', "INSERT INTO actors(id, project_id, actor_key, actor_kind, display_name, status, created_at_ms) VALUES('actor_1','proj_1','a','AGENT','A','ACTIVE',1); INSERT INTO work_assignments(id, work_item_id, actor_id, role_id, assignment_kind, status, assigned_at_ms) VALUES('wa_x','work_1','actor_1','role_x','PRIMARY','ACTIVE',1)"],
    ]
    for (const [edge, sql] of orphanInserts) {
      try {
        db.exec(sql)
      } catch (error) {
        expect(error, edge).toMatchObject({ message: 'FOREIGN KEY constraint failed' })
        continue
      }
      throw new Error(`expected the insert to violate ${edge}`)
    }
    db.close()
  })

  it('rejects values outside the controlled enums', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    insertFixtureChain(db)
    db.exec(`${WORK_ITEM_INSERT_SQL} VALUES('work_b','proj_1',NULL,NULL,NULL,'BACKLOG-B','RESEARCH','AGENT','second item','PROPOSED',1,1)`)
    db.exec("INSERT INTO plan_imports(id, project_id, source_hash, schema_version, parser_version, compiler_version, status) VALUES('imp_1','proj_1','h',1,'p','c','PARSED')")
    insertCriterion(db, 'ac_1', 0, 'COMMAND')
    const badEnums: [string, string][] = [
      ['plan_versions.status', "INSERT INTO plan_versions(id, plan_id, version_no, status, source_document_hash, compiled_ir_hash, created_at_ms) VALUES('pv_e','plan_1',2,'MAYBE','h','h',1)"],
      ['work_items.work_type', `${WORK_ITEM_INSERT_SQL} VALUES('work_e','proj_1',NULL,NULL,NULL,'K-2','SPRINT','AGENT','t','PROPOSED',1,1)`],
      ['work_items.executor_kind', `${WORK_ITEM_INSERT_SQL} VALUES('work_e','proj_1',NULL,NULL,NULL,'K-2','TEST','ROBOT','t','PROPOSED',1,1)`],
      ['work_items.status', `${WORK_ITEM_INSERT_SQL} VALUES('work_e','proj_1',NULL,NULL,NULL,'K-2','TEST','AGENT','t','SORT_OF_DONE',1,1)`],
      ['work_item_relations.relation_kind', "INSERT INTO work_item_relations(id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) VALUES('rel_e','work_1','work_b','LIKES',1)"],
      ['work_external_blockers.blocker_kind', "INSERT INTO work_external_blockers(id, work_item_id, blocker_kind, title, status, created_at_ms) VALUES('block_e','work_1','WEATHER','snow','OPEN',1)"],
      ['acceptance_evaluations.result', "INSERT INTO acceptance_evaluations(id, criterion_id, work_item_id, result, evaluated_by, evaluated_at_ms) VALUES('ev_e','ac_1','work_1','SO_PASS','fixture',1)"],
      ['plan_compile_diagnostics.severity', "INSERT INTO plan_compile_diagnostics(id, plan_import_id, severity, code, message) VALUES('diag_e','imp_1','FATAL','C','m')"],
      ['work_leases.status', "INSERT INTO work_leases(id, work_item_id, worker_identity, lease_token_hash, status, acquired_at_ms, heartbeat_at_ms, expires_at_ms) VALUES('lease_e','work_1','worker','token','LOST',1,1,2)"],
    ]
    for (const [column, sql] of badEnums) {
      try {
        db.exec(sql)
      } catch (error) {
        expect((error as Error).message, column).toContain('constraint failed')
        continue
      }
      throw new Error(`expected the insert to violate the ${column} CHECK`)
    }
    db.close()
  })

  it('keeps verification specs a tagged-row variant table', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    insertFixtureChain(db)
    const variants: [string, string | null, string | null, boolean][] = [
      ['COMMAND', "'pnpm exec vitest run fixture.spec.ts'", null, true],
      ['TEST', "'pnpm exec vitest run fixture.spec.ts'", null, true],
      ['SQL_ASSERTION', null, "'SELECT 1 AS one'", true],
      ['GRAPH_ASSERTION', null, "'MATCH (a)-[:CALLS]->(b)'", true],
      ['OWNER_CONFIRMATION', null, null, true],
    ]
    for (const [index, [kind, commandText, queryText, valid]] of variants.entries()) {
      const criterionId = `ac_${index}`
      const ownerInstruction = kind === 'OWNER_CONFIRMATION' ? "'please confirm'" : 'NULL'
      insertCriterion(db, criterionId, index, kind)
      const sql = `INSERT INTO verification_specs(
        id, criterion_id, verifier_kind, command_text, query_text, owner_instruction
      ) VALUES('spec_${index}','${criterionId}','${kind}',${commandText ?? 'NULL'},${queryText ?? 'NULL'},${ownerInstruction})`
      if (valid) {
        db.exec(sql)
      } else {
        expect(() => { db.exec(sql) }).toThrow()
      }
    }
    const defaults = db.prepare("SELECT sandbox_required, approval_required FROM verification_specs WHERE verifier_kind = 'COMMAND'").get() as {
      sandbox_required: number
      approval_required: number
    }
    expect(defaults).toEqual({ sandbox_required: 1, approval_required: 0 })
    insertCriterion(db, 'ac_commandless', 5, 'COMMAND')
    expect(() => {
      db.exec("INSERT INTO verification_specs(id, criterion_id, verifier_kind) VALUES('spec_commandless','ac_commandless','COMMAND')")
    }).toThrow()
    insertCriterion(db, 'ac_ownerless', 6, 'OWNER_CONFIRMATION')
    expect(() => {
      db.exec("INSERT INTO verification_specs(id, criterion_id, verifier_kind) VALUES('spec_ownerless','ac_ownerless','OWNER_CONFIRMATION')")
    }).toThrow()
    db.close()
  })

  it('rejects a work item relation that loops on itself', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    insertFixtureChain(db)
    expect(() => {
      db.exec("INSERT INTO work_item_relations(id, from_work_item_id, to_work_item_id, relation_kind, created_at_ms) VALUES('rel_self','work_1','work_1','RELATES_TO',1)")
    }).toThrow()
    db.close()
  })

  it('allows backlog work items without a plan version or phase', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    db.exec(`${WORK_ITEM_INSERT_SQL} VALUES('work_backlog','proj_1',NULL,NULL,NULL,'BACKLOG-1','RESEARCH','AGENT','out-of-plan work','PROPOSED',1,1)`)
    const row = db.prepare("SELECT plan_version_id, phase_id, parent_work_item_id, priority, lock_version FROM work_items WHERE id = 'work_backlog'").get() as {
      plan_version_id: null
      phase_id: null
      parent_work_item_id: null
      priority: number
      lock_version: number
    }
    expect(row).toEqual({
      plan_version_id: null,
      phase_id: null,
      parent_work_item_id: null,
      priority: 0,
      lock_version: 0,
    })
    db.close()
  })

  it('keeps one active lease per work item', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    insertFixtureChain(db)
    db.exec(`${WORK_ITEM_INSERT_SQL} VALUES('work_2','proj_1',NULL,NULL,NULL,'K-3','TEST','AGENT','second item','PROPOSED',1,1)`)
    insertLease(db, 'lease_1', 'work_1')
    expect(() => { insertLease(db, 'lease_2', 'work_1') }).toThrow()
    insertLease(db, 'lease_3', 'work_2')
    db.exec("UPDATE work_leases SET status = 'RELEASED', released_at_ms = 50 WHERE id = 'lease_1'")
    insertLease(db, 'lease_4', 'work_1')
    const activeOnWork1 = db.prepare("SELECT COUNT(*) AS n FROM work_leases WHERE work_item_id = 'work_1' AND status = 'ACTIVE'").get() as { n: number }
    expect(activeOnWork1.n).toBe(1)
    db.close()
  })

  it('keeps one live PRIMARY work assignment per work item and rejects bad kinds and statuses', async () => {
    const db = await openProjectLedgerDatabase(':memory:')
    insertFixtureChain(db)
    db.exec(`${WORK_ITEM_INSERT_SQL} VALUES('work_2','proj_1',NULL,NULL,NULL,'K-3','TEST','AGENT','second item','PROPOSED',1,1)`)
    db.exec("INSERT INTO actors(id, project_id, actor_key, actor_kind, display_name, status, created_at_ms) VALUES('actor_1','proj_1','a','AGENT','A','ACTIVE',1)")
    db.exec("INSERT INTO actors(id, project_id, actor_key, actor_kind, display_name, status, created_at_ms) VALUES('actor_2','proj_1','b','AGENT','B','ACTIVE',1)")
    const insert = (id: string, itemId: string, actorId: string, kind: string, status = 'ACTIVE'): void => {
      db.exec(`INSERT INTO work_assignments(id, work_item_id, actor_id, role_id, assignment_kind, status, assigned_at_ms)
        VALUES('${id}','${itemId}','${actorId}',NULL,'${kind}','${status}',1)`)
    }
    insert('wa_1', 'work_1', 'actor_1', 'PRIMARY')
    expect(() => { insert('wa_2', 'work_1', 'actor_2', 'PRIMARY') }).toThrow()
    insert('wa_3', 'work_1', 'actor_2', 'COLLABORATOR')
    insert('wa_4', 'work_2', 'actor_2', 'PRIMARY')
    db.exec("UPDATE work_assignments SET status = 'ENDED' WHERE id = 'wa_1'")
    insert('wa_5', 'work_1', 'actor_1', 'PRIMARY')
    expect(() => { insert('wa_6', 'work_1', 'actor_2', 'LEAD') }).toThrow()
    expect(() => { insert('wa_6', 'work_1', 'actor_2', 'PRIMARY', 'DONE') }).toThrow()
    const livePrimaryOnWork1 = db.prepare(
      "SELECT COUNT(*) AS n FROM work_assignments WHERE work_item_id = 'work_1' AND status = 'ACTIVE' AND assignment_kind = 'PRIMARY'",
    ).get() as { n: number }
    expect(livePrimaryOnWork1.n).toBe(1)
    db.close()
  })
})

describe('migration registry', () => {
  it('is contiguous from the empty database to the current schema version', () => {
    expect(PROJECT_LEDGER_MIGRATIONS.length).toBeGreaterThan(0)
    let expected = 0
    for (const step of PROJECT_LEDGER_MIGRATIONS) {
      expect(step.fromVersion).toBe(expected)
      expect(step.toVersion).toBeGreaterThan(step.fromVersion)
      expected = step.toVersion
    }
    expect(expected).toBe(PROJECT_LEDGER_SCHEMA_VERSION)
  })
})
