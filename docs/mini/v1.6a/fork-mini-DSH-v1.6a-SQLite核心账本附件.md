# mini-DSH v1.6a SQLite 核心账本附件
## Project Ledger Core Schema / Runtime Contract

**配套：`fork-mini-DSH改造方案-v1.6a.md`**

本附件只定义 v1.6a 最小 Ledger Core，不假装 v1.4/v1.5 的大数据库已经实现。

---

# 1. Runtime constants

概念常量：

```text
PROJECT_LEDGER_SCHEMA_VERSION = 1
PROJECT_EVENT_FORMAT_VERSION = 1
```

数据库：

```text
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL (default; validated durable alternatives may be configured)
PRAGMA busy_timeout = config.busyTimeoutMs
PRAGMA user_version = PROJECT_LEDGER_SCHEMA_VERSION
```

Project Ledger 是 source-of-truth persistence：未知 schema 版本拒绝，不自动删库重建。

---

# 2. `plans`

```sql
CREATE TABLE plans (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  name               TEXT NOT NULL,
  current_version_id TEXT,
  created_at_ms      INTEGER NOT NULL,
  UNIQUE(project_id, name)
) STRICT;
```

没有 `status`，避免和 plan_versions 双权威。

---

# 3. `plan_versions`

```sql
CREATE TABLE plan_versions (
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

CREATE INDEX idx_plan_versions_plan_status
ON plan_versions(plan_id, status, version_no DESC);
```

---

# 4. `phases`

```sql
CREATE TABLE phases (
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
```

---

# 5. `work_items`

```sql
CREATE TABLE work_items (
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

CREATE INDEX idx_work_items_ready
ON work_items(project_id, executor_kind, status, priority DESC, created_at_ms);

CREATE INDEX idx_work_items_phase
ON work_items(phase_id, status);

CREATE INDEX idx_work_items_parent
ON work_items(parent_work_item_id);
```

`plan_version_id` 可为 NULL，允许计划外 backlog/discovered work。

---

# 6. `work_item_relations`

```sql
CREATE TABLE work_item_relations (
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

CREATE INDEX idx_work_rel_from
ON work_item_relations(from_work_item_id, relation_kind);

CREATE INDEX idx_work_rel_to
ON work_item_relations(to_work_item_id, relation_kind);
```

cycle prevention 由 compile/doctor + transactional write guard 负责。

---

# 7. `work_external_blockers`

```sql
CREATE TABLE work_external_blockers (
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

CREATE INDEX idx_external_blockers_work
ON work_external_blockers(work_item_id, status);
```

v1.6b 将用 typed decisions/resources 替代部分 generic blocker；本表保留作统一 readiness projection。

---

# 8. `acceptance_criteria`

```sql
CREATE TABLE acceptance_criteria (
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
```

---

# 9. `verification_specs`

SQL 层采用 tagged rows；Plan schema 使用真正 discriminated union。

```sql
CREATE TABLE verification_specs (
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
```

Project Ledger 自身不得直接执行 `command_text`。

---

# 10. `acceptance_evaluations`

```sql
CREATE TABLE acceptance_evaluations (
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

CREATE INDEX idx_accept_eval_criterion
ON acceptance_evaluations(criterion_id, evaluated_at_ms DESC);
```

历史 append-only；current criterion status 是 projection。

---

# 11. `project_events`

```sql
CREATE TABLE project_events (
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

CREATE INDEX idx_project_events_type
ON project_events(project_id, event_type, sequence_no);
```

sequence_no 必须在 `BEGIN IMMEDIATE` 内分配。

未知 required event -> read fail；未知 ignorable event -> preserve/skip projection。

---

# 12. `plan_imports`

```sql
CREATE TABLE plan_imports (
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
```

---

# 13. `plan_compile_diagnostics`

```sql
CREATE TABLE plan_compile_diagnostics (
  id                 TEXT PRIMARY KEY,
  plan_import_id     TEXT NOT NULL REFERENCES plan_imports(id),
  severity           TEXT NOT NULL CHECK(severity IN ('ERROR','WARNING','INFO')),
  code               TEXT NOT NULL,
  source_path        TEXT,
  source_line        INTEGER,
  source_column      INTEGER,
  message            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_plan_diag_import
ON plan_compile_diagnostics(plan_import_id, severity);
```

有 ERROR 时禁止 import/activation。

---

# 14. `work_leases`

```sql
CREATE TABLE work_leases (
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

CREATE UNIQUE INDEX uq_one_active_lease_per_work
ON work_leases(work_item_id)
WHERE status = 'ACTIVE';

CREATE INDEX idx_lease_expiry
ON work_leases(status, expires_at_ms);
```

claim/reap 必须短 `BEGIN IMMEDIATE` 事务。

---

# 15. Current projection rules

物化表保存 current projection，但每次改变必须先/同时追加 project event，事务内原子完成。

概念顺序：

```text
BEGIN IMMEDIATE
  validate precondition
  allocate project event sequence
  insert project event
  mutate current projection
COMMIT
```

失败则全部 rollback。

---

# 16. Event vocabulary v1

required events 第一版至少：

```text
plan/imported
plan/version-activated
plan/version-superseded
work/created
work/status-changed
work/blocked
work/unblocked
work/claimed
work/lease-heartbeat
work/lease-expired
work/lease-released
acceptance/evaluated
project/work-packet-prepared
baseline/drift-detected
```

新增 required event 需要 PROJECT_EVENT_FORMAT_VERSION / codec 演进；纯观察性扩展可使用 `ignorable=true`，但不能偷渡影响 projection 的语义。

---

# 17. Work readiness SQL inputs

readiness 不是单一 status 字段真理。

至少读取：

```text
work status
plan version status
phase status
blocking relations
external blockers
active lease
```

`READY` materialized status 只是 projection；claim 事务必须重新计算关键条件，不能只信 stale READY。

---

# 18. Project status query

不返回单个虚假百分比。

输出：

```text
plan/version
phases by status
work by status/executor_kind
open blockers
required acceptance failing/pending
active leases
baseline drift
```

---

# 19. Migration rule

Project Ledger 是事实源：

```text
schema v1 -> v2 -> v3 adjacent explicit migration
```

禁止：

```text
unknown version -> reset
modify already shipped migration
```

每个 migration fixture：

```text
open old
migrate one step
foreign_key_check
integrity_check
project event row parity
projection replay parity
```

---

# 20. Security

DB/dir owner-only。

plan verifier 是潜在执行面：

```text
parse/import/activate != execute
```

所有 command/test execution 交给 DSH shell/tool seam。

Plan source 不得通过 verifier 字段绕过 sandbox/approval。

---

# 21. Performance indexes / query-plan tests

P0 query：

```text
next ready work
todo by executor kind
blocking dependencies
open blockers
latest acceptance
active lease/reap
project event replay range
```

synthetic：

```text
100k work_items
1m project_events
```

所有 P0 query 都有 `EXPLAIN QUERY PLAN` snapshot/semantic assertion。

---

# 22. v1.6a Schema DoD

- [ ] STRICT tables；
- [ ] FK coverage；
- [ ] foreign_keys ON；
- [ ] user_version monotonic；
- [ ] version mismatch fail；
- [ ] plans 无 status 双权威；
- [ ] work plan_version nullable backlog；
- [ ] hierarchy/dependency 分离；
- [ ] typed acceptance/verifier；
- [ ] append-only evaluations；
- [ ] versioned project events；
- [ ] one active lease partial unique index；
- [ ] claim/reap BEGIN IMMEDIATE；
- [ ] query-plan gates；
- [ ] replay parity；
- [ ] historical migration fixture。
