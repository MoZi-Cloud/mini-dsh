# mini-DSH v1.6 SQLite 数据库架构附件
## Project Execution Ledger / Design Intent / Function Contract / Multi-Agent Schema Delta

- **配套：`fork-mini-DSH改造方案-v1.6.md`**

**基础：v1.4 + v1.5 schema 全部继续保留。**

本附件只描述 v1.6 delta。

---

# 0. Delta Domains

v1.6 新增：

```text
projects / project_repositories
actors / roles / actor_roles
project_events / projection cursors
objectives / target assertions
plans / plan_versions / plan changes
phases / milestones
work_items / hierarchy / relations
assignments / attempts / leases / scopes
owner requests / decisions / approvals
resources / instances / verifications
workflows / nodes / edges / runs
handoffs / conflicts
design_objects / change_specs
function_contracts / parameters / effects
planned_call_edges
implementation_bindings
acceptance_criteria / verification_specs / evaluations
contract_diff_runs / items
work_item_artifacts
plan_imports / diagnostics
```

---

# 1. projects

```sql
CREATE TABLE projects (
    id                  TEXT PRIMARY KEY,
    slug                TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    description_content_id TEXT,
    status              TEXT NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    updated_at_ms       INTEGER NOT NULL
) STRICT;
```

---

# 2. project_repositories

```sql
CREATE TABLE project_repositories (
    project_id          TEXT NOT NULL,
    repository_id       TEXT NOT NULL,
    role                TEXT NOT NULL,
    -- primary | upstream | fixture | benchmark | dependency
    PRIMARY KEY(project_id, repository_id, role),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(repository_id) REFERENCES repositories(id) ON DELETE CASCADE
) STRICT;
```

---

# 3. actors

```sql
CREATE TABLE actors (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    actor_kind          TEXT NOT NULL,
    -- human | agent | service | system
    display_name        TEXT NOT NULL,
    external_identity   TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    metadata_json       TEXT,
    created_at_ms       INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_actors_project_kind
ON actors(project_id, actor_kind, status);
```

---

# 4. roles / actor_roles

```sql
CREATE TABLE roles (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    name                TEXT NOT NULL,
    role_kind           TEXT NOT NULL,
    description_content_id TEXT,
    UNIQUE(project_id, name),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE actor_roles (
    actor_id            TEXT NOT NULL,
    role_id             TEXT NOT NULL,
    valid_from_ms       INTEGER NOT NULL,
    valid_to_ms         INTEGER,
    PRIMARY KEY(actor_id, role_id, valid_from_ms),
    FOREIGN KEY(actor_id) REFERENCES actors(id) ON DELETE CASCADE,
    FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE
) STRICT;
```

---

# 5. project_events

项目级 append-only history。

```sql
CREATE TABLE project_events (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    sequence_no         INTEGER NOT NULL,
    event_type          TEXT NOT NULL,
    actor_id            TEXT,
    entity_type         TEXT,
    entity_id           TEXT,
    payload_content_id  TEXT,
    created_at_ms       INTEGER NOT NULL,
    correlation_id      TEXT,
    causation_event_id  TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, sequence_no)
) STRICT;

CREATE INDEX idx_project_events_type
ON project_events(project_id, event_type, sequence_no);
```

---

# 6. project_projection_state

```sql
CREATE TABLE project_projection_state (
    project_id          TEXT NOT NULL,
    projection_name     TEXT NOT NULL,
    last_sequence_no    INTEGER NOT NULL,
    projection_version  INTEGER NOT NULL,
    rebuilt_at_ms       INTEGER,
    status              TEXT NOT NULL,
    PRIMARY KEY(project_id, projection_name)
) STRICT;
```

---

# 7. project_objectives

```sql
CREATE TABLE project_objectives (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    parent_objective_id TEXT,
    title               TEXT NOT NULL,
    description_content_id TEXT NOT NULL,
    objective_kind      TEXT NOT NULL,
    priority            INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL,
    created_by_actor_id TEXT,
    created_at_ms       INTEGER NOT NULL,
    achieved_at_ms      INTEGER,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_objective_id) REFERENCES project_objectives(id) ON DELETE SET NULL
) STRICT;
```

---

# 8. target_state_assertions

```sql
CREATE TABLE target_state_assertions (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    objective_id        TEXT,
    plan_version_id     TEXT,
    target_kind         TEXT NOT NULL,
    subject_type        TEXT,
    subject_id          TEXT,
    assertion_content_id TEXT NOT NULL,
    priority            INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL,
    verification_spec_id TEXT,
    superseded_by_id    TEXT,
    created_at_ms       INTEGER NOT NULL,
    updated_at_ms       INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_targets_project_status
ON target_state_assertions(project_id, status, priority DESC);
```

---

# 9. plans

```sql
CREATE TABLE plans (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_key            TEXT NOT NULL,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL,
    current_version_id  TEXT,
    UNIQUE(project_id, plan_key),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;
```

---

# 10. plan_versions

```sql
CREATE TABLE plan_versions (
    id                  TEXT PRIMARY KEY,
    plan_id             TEXT NOT NULL,
    version_label       TEXT NOT NULL,
    version_no          INTEGER NOT NULL,
    base_repo_snapshot_id TEXT,
    source_plan_content_id TEXT NOT NULL,
    source_plan_hash    TEXT NOT NULL,
    summary_content_id  TEXT,
    rationale_content_id TEXT,
    created_by_actor_id TEXT,
    status              TEXT NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    activated_at_ms     INTEGER,
    superseded_at_ms    INTEGER,
    UNIQUE(plan_id, version_no),
    UNIQUE(plan_id, version_label),
    FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
) STRICT;
```

---

# 11. plan_version_changes

```sql
CREATE TABLE plan_version_changes (
    id                  TEXT PRIMARY KEY,
    from_plan_version_id TEXT,
    to_plan_version_id  TEXT NOT NULL,
    change_kind         TEXT NOT NULL,
    entity_type         TEXT NOT NULL,
    entity_key          TEXT NOT NULL,
    reason_content_id   TEXT,
    diff_content_id     TEXT,
    created_at_ms       INTEGER NOT NULL
) STRICT;
```

---

# 12. phases

```sql
CREATE TABLE phases (
    id                  TEXT PRIMARY KEY,
    plan_version_id     TEXT NOT NULL,
    phase_key           TEXT NOT NULL,
    ordinal             INTEGER NOT NULL,
    title               TEXT NOT NULL,
    objective_content_id TEXT,
    status              TEXT NOT NULL,
    entry_gate_spec_id  TEXT,
    exit_gate_spec_id   TEXT,
    UNIQUE(plan_version_id, phase_key),
    UNIQUE(plan_version_id, ordinal),
    FOREIGN KEY(plan_version_id) REFERENCES plan_versions(id) ON DELETE CASCADE
) STRICT;
```

---

# 13. milestones

```sql
CREATE TABLE milestones (
    id                  TEXT PRIMARY KEY,
    plan_version_id     TEXT NOT NULL,
    phase_id            TEXT,
    milestone_key       TEXT NOT NULL,
    ordinal             INTEGER NOT NULL,
    title               TEXT NOT NULL,
    status              TEXT NOT NULL,
    acceptance_group_key TEXT,
    UNIQUE(plan_version_id, milestone_key)
) STRICT;
```

---

# 14. work_items

```sql
CREATE TABLE work_items (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT NOT NULL,
    phase_id            TEXT,
    milestone_id        TEXT,
    work_key            TEXT NOT NULL,
    work_type           TEXT NOT NULL,
    executor_kind       TEXT NOT NULL,
    title               TEXT NOT NULL,
    description_content_id TEXT,
    priority            INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL,
    accountable_actor_id TEXT,
    requested_role_id   TEXT,
    lock_version        INTEGER NOT NULL DEFAULT 0,
    created_at_ms       INTEGER NOT NULL,
    updated_at_ms       INTEGER NOT NULL,
    started_at_ms       INTEGER,
    completed_at_ms     INTEGER,
    UNIQUE(plan_version_id, work_key),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_work_ready
ON work_items(project_id, status, priority DESC, created_at_ms);
```

---

# 15. work_item_hierarchy

```sql
CREATE TABLE work_item_hierarchy (
    parent_work_item_id TEXT NOT NULL,
    child_work_item_id  TEXT NOT NULL,
    ordinal             INTEGER,
    PRIMARY KEY(parent_work_item_id, child_work_item_id),
    CHECK(parent_work_item_id <> child_work_item_id)
) STRICT;
```

Hierarchy 必须 DAG/树 policy 校验。

---

# 16. work_item_relations

```sql
CREATE TABLE work_item_relations (
    id                  TEXT PRIMARY KEY,
    from_work_item_id   TEXT NOT NULL,
    to_work_item_id     TEXT NOT NULL,
    relation_kind       TEXT NOT NULL,
    -- blocks | requires | precedes | relates | duplicates | conflicts
    lag_ms              INTEGER,
    description_content_id TEXT,
    created_at_ms       INTEGER NOT NULL,
    CHECK(from_work_item_id <> to_work_item_id)
) STRICT;

CREATE INDEX idx_work_rel_from
ON work_item_relations(from_work_item_id, relation_kind);

CREATE INDEX idx_work_rel_to
ON work_item_relations(to_work_item_id, relation_kind);
```

---

# 17. work_external_blockers

Work item 对 decision/resource/approval 等非 work item blocker。

```sql
CREATE TABLE work_external_blockers (
    work_item_id        TEXT NOT NULL,
    blocker_type        TEXT NOT NULL,
    blocker_id          TEXT NOT NULL,
    blocking_level      TEXT NOT NULL,
    PRIMARY KEY(work_item_id, blocker_type, blocker_id)
) STRICT;
```

---

# 18. assignments

```sql
CREATE TABLE assignments (
    id                  TEXT PRIMARY KEY,
    work_item_id        TEXT NOT NULL,
    actor_id            TEXT NOT NULL,
    role_id             TEXT,
    assignment_kind     TEXT NOT NULL,
    -- primary | collaborator | reviewer | tester | observer | accountable
    status              TEXT NOT NULL,
    assigned_at_ms      INTEGER NOT NULL,
    accepted_at_ms      INTEGER,
    completed_at_ms     INTEGER,
    FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
    FOREIGN KEY(actor_id) REFERENCES actors(id) ON DELETE CASCADE
) STRICT;
```

---

# 19. work_attempts

```sql
CREATE TABLE work_attempts (
    id                  TEXT PRIMARY KEY,
    work_item_id        TEXT NOT NULL,
    actor_id            TEXT NOT NULL,
    agent_run_id        TEXT,
    attempt_no          INTEGER NOT NULL,
    repo_snapshot_start_id TEXT,
    repo_snapshot_end_id TEXT,
    started_at_ms       INTEGER NOT NULL,
    ended_at_ms         INTEGER,
    status              TEXT NOT NULL,
    result_content_id   TEXT,
    failure_id          TEXT,
    UNIQUE(work_item_id, attempt_no),
    FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
) STRICT;
```

---

# 20. work_leases

```sql
CREATE TABLE work_leases (
    id                  TEXT PRIMARY KEY,
    work_item_id        TEXT NOT NULL,
    actor_id            TEXT NOT NULL,
    lease_token_hash    TEXT NOT NULL,
    acquired_at_ms      INTEGER NOT NULL,
    heartbeat_at_ms     INTEGER NOT NULL,
    expires_at_ms       INTEGER NOT NULL,
    released_at_ms      INTEGER,
    status              TEXT NOT NULL,
    FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX uq_active_primary_lease
ON work_leases(work_item_id)
WHERE status = 'active';
```

---

# 21. scope_reservations

```sql
CREATE TABLE scope_reservations (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    work_item_id        TEXT NOT NULL,
    actor_id            TEXT NOT NULL,
    scope_kind          TEXT NOT NULL,
    scope_value         TEXT NOT NULL,
    mode                TEXT NOT NULL,
    acquired_at_ms      INTEGER NOT NULL,
    expires_at_ms       INTEGER NOT NULL,
    released_at_ms      INTEGER,
    status              TEXT NOT NULL
) STRICT;

CREATE INDEX idx_scope_active
ON scope_reservations(project_id, status, scope_kind, scope_value);
```

---

# 22. decision_requests

```sql
CREATE TABLE decision_requests (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT,
    decision_key        TEXT NOT NULL,
    raised_by_actor_id  TEXT,
    required_role_id    TEXT,
    title               TEXT NOT NULL,
    question_content_id TEXT NOT NULL,
    context_content_id  TEXT,
    blocking_level      TEXT NOT NULL,
    status              TEXT NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    resolved_at_ms      INTEGER,
    UNIQUE(plan_version_id, decision_key)
) STRICT;
```

---

# 23. decision_options / decisions

```sql
CREATE TABLE decision_options (
    id                  TEXT PRIMARY KEY,
    decision_request_id TEXT NOT NULL,
    option_key          TEXT NOT NULL,
    label               TEXT NOT NULL,
    description_content_id TEXT,
    pros_content_id     TEXT,
    cons_content_id     TEXT,
    recommended         INTEGER NOT NULL DEFAULT 0,
    ordinal             INTEGER NOT NULL,
    UNIQUE(decision_request_id, option_key)
) STRICT;

CREATE TABLE decisions (
    id                  TEXT PRIMARY KEY,
    decision_request_id TEXT NOT NULL UNIQUE,
    decided_by_actor_id TEXT NOT NULL,
    selected_option_id  TEXT,
    decision_content_id TEXT NOT NULL,
    rationale_content_id TEXT,
    decided_at_ms       INTEGER NOT NULL
) STRICT;
```

---

# 24. approvals

```sql
CREATE TABLE approvals (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    subject_type        TEXT NOT NULL,
    subject_id          TEXT NOT NULL,
    required_role_id    TEXT,
    requested_by_actor_id TEXT,
    status              TEXT NOT NULL,
    decision_content_id TEXT,
    decided_by_actor_id TEXT,
    requested_at_ms     INTEGER NOT NULL,
    decided_at_ms       INTEGER
) STRICT;
```

Decision 与 Approval 不共表。

---

# 25. resource_requirements

```sql
CREATE TABLE resource_requirements (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT,
    requirement_key     TEXT NOT NULL,
    requirement_kind    TEXT NOT NULL,
    name                TEXT NOT NULL,
    constraints_json    TEXT NOT NULL,
    status              TEXT NOT NULL,
    requested_from_actor_id TEXT,
    created_at_ms       INTEGER NOT NULL,
    UNIQUE(plan_version_id, requirement_key)
) STRICT;
```

---

# 26. resource_instances

```sql
CREATE TABLE resource_instances (
    id                  TEXT PRIMARY KEY,
    requirement_id      TEXT NOT NULL,
    provider_actor_id   TEXT,
    label               TEXT NOT NULL,
    metadata_json       TEXT,
    status              TEXT NOT NULL,
    provided_at_ms      INTEGER NOT NULL,
    FOREIGN KEY(requirement_id) REFERENCES resource_requirements(id) ON DELETE CASCADE
) STRICT;
```

---

# 27. resource_verifications

```sql
CREATE TABLE resource_verifications (
    id                  TEXT PRIMARY KEY,
    resource_instance_id TEXT NOT NULL,
    verifier_actor_id   TEXT,
    verifier_kind       TEXT NOT NULL,
    verification_spec_content_id TEXT NOT NULL,
    observed_value_json TEXT,
    result              TEXT NOT NULL,
    verification_run_id TEXT,
    verified_at_ms      INTEGER NOT NULL,
    FOREIGN KEY(resource_instance_id) REFERENCES resource_instances(id) ON DELETE CASCADE
) STRICT;
```

---

# 28. handoffs

```sql
CREATE TABLE handoffs (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    work_item_id        TEXT NOT NULL,
    from_actor_id       TEXT NOT NULL,
    to_actor_id         TEXT,
    to_role_id          TEXT,
    handoff_kind        TEXT NOT NULL,
    summary_content_id  TEXT NOT NULL,
    repo_snapshot_id    TEXT,
    artifact_refs_json  TEXT,
    memory_refs_json    TEXT,
    created_at_ms       INTEGER NOT NULL,
    accepted_at_ms      INTEGER
) STRICT;
```

---

# 29. collaboration_conflicts

```sql
CREATE TABLE collaboration_conflicts (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    conflict_kind       TEXT NOT NULL,
    raised_by_actor_id  TEXT,
    work_item_a         TEXT,
    work_item_b         TEXT,
    description_content_id TEXT NOT NULL,
    status              TEXT NOT NULL,
    resolution_decision_id TEXT,
    created_at_ms       INTEGER NOT NULL,
    resolved_at_ms      INTEGER
) STRICT;
```

---

# 30. workflow_definitions / nodes / edges

```sql
CREATE TABLE workflow_definitions (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT NOT NULL,
    workflow_key        TEXT NOT NULL,
    name                TEXT NOT NULL,
    version_no          INTEGER NOT NULL,
    status              TEXT NOT NULL,
    UNIQUE(plan_version_id, workflow_key, version_no)
) STRICT;

CREATE TABLE workflow_nodes (
    id                  TEXT PRIMARY KEY,
    workflow_definition_id TEXT NOT NULL,
    node_key            TEXT NOT NULL,
    node_kind           TEXT NOT NULL,
    work_item_id        TEXT,
    role_id             TEXT,
    config_json         TEXT,
    UNIQUE(workflow_definition_id, node_key)
) STRICT;

CREATE TABLE workflow_edges (
    workflow_definition_id TEXT NOT NULL,
    from_node_id        TEXT NOT NULL,
    to_node_id          TEXT NOT NULL,
    edge_kind           TEXT NOT NULL,
    condition_json      TEXT,
    PRIMARY KEY(workflow_definition_id, from_node_id, to_node_id, edge_kind)
) STRICT;
```

---

# 31. workflow_runs / workflow_node_runs

```sql
CREATE TABLE workflow_runs (
    id                  TEXT PRIMARY KEY,
    workflow_definition_id TEXT NOT NULL,
    started_by_actor_id TEXT,
    status              TEXT NOT NULL,
    started_at_ms       INTEGER NOT NULL,
    ended_at_ms         INTEGER
) STRICT;

CREATE TABLE workflow_node_runs (
    id                  TEXT PRIMARY KEY,
    workflow_run_id     TEXT NOT NULL,
    workflow_node_id    TEXT NOT NULL,
    actor_id            TEXT,
    work_attempt_id     TEXT,
    status              TEXT NOT NULL,
    started_at_ms       INTEGER,
    ended_at_ms         INTEGER,
    result_content_id   TEXT
) STRICT;
```

---

# 32. design_objects

未来对象一等化。

```sql
CREATE TABLE design_objects (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT NOT NULL,
    design_key          TEXT NOT NULL,
    object_kind         TEXT NOT NULL,
    operation           TEXT NOT NULL,
    baseline_object_id  TEXT,
    target_stable_key   TEXT NOT NULL,
    target_name         TEXT NOT NULL,
    description_content_id TEXT,
    rationale_content_id TEXT,
    status              TEXT NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    UNIQUE(plan_version_id, design_key),
    UNIQUE(plan_version_id, target_stable_key)
) STRICT;
```

---

# 33. change_specs

```sql
CREATE TABLE change_specs (
    id                  TEXT PRIMARY KEY,
    plan_version_id     TEXT NOT NULL,
    work_item_id        TEXT NOT NULL,
    change_key          TEXT NOT NULL,
    design_object_id    TEXT NOT NULL,
    change_kind         TEXT NOT NULL,
    baseline_repo_snapshot_id TEXT,
    baseline_object_id  TEXT,
    reason_content_id   TEXT,
    status              TEXT NOT NULL,
    UNIQUE(plan_version_id, change_key)
) STRICT;
```

---

# 34. function_contracts

```sql
CREATE TABLE function_contracts (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT,
    design_object_id    TEXT,
    contract_state      TEXT NOT NULL,
    -- OBSERVED_BASELINE | TARGET | IMPLEMENTED | VERIFIED
    source_symbol_version_id TEXT,
    signature_content_id TEXT,
    visibility          TEXT,
    is_async            INTEGER NOT NULL DEFAULT 0,
    is_static           INTEGER NOT NULL DEFAULT 0,
    is_generator        INTEGER NOT NULL DEFAULT 0,
    return_type_text    TEXT,
    return_description_content_id TEXT,
    throws_contract_content_id TEXT,
    preconditions_content_id TEXT,
    postconditions_content_id TEXT,
    invariants_content_id TEXT,
    created_at_ms       INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_function_contract_design_state
ON function_contracts(design_object_id, contract_state);
```

---

# 35. function_parameters

```sql
CREATE TABLE function_parameters (
    contract_id         TEXT NOT NULL,
    ordinal             INTEGER NOT NULL,
    name                TEXT NOT NULL,
    type_text           TEXT NOT NULL,
    optional            INTEGER NOT NULL DEFAULT 0,
    rest_parameter      INTEGER NOT NULL DEFAULT 0,
    default_expression  TEXT,
    semantic_role       TEXT,
    policy              TEXT NOT NULL DEFAULT 'explicit',
    -- explicit | same_as_baseline
    PRIMARY KEY(contract_id, ordinal),
    FOREIGN KEY(contract_id) REFERENCES function_contracts(id) ON DELETE CASCADE
) STRICT;
```

---

# 36. function_effects

```sql
CREATE TABLE function_effects (
    id                  TEXT PRIMARY KEY,
    contract_id         TEXT NOT NULL,
    effect_kind         TEXT NOT NULL,
    target_ref_kind     TEXT,
    target_ref_id       TEXT,
    target_text         TEXT,
    requirement         TEXT NOT NULL,
    -- REQUIRED | ALLOWED | PROHIBITED
    description_content_id TEXT,
    ordinal             INTEGER NOT NULL,
    FOREIGN KEY(contract_id) REFERENCES function_contracts(id) ON DELETE CASCADE
) STRICT;
```

---

# 37. planned_call_edges

```sql
CREATE TABLE planned_call_edges (
    id                  TEXT PRIMARY KEY,
    target_contract_id  TEXT NOT NULL,
    ordinal             INTEGER NOT NULL,
    edge_action         TEXT NOT NULL,
    -- ADD | RETAIN | REMOVE | PROHIBIT
    callee_ref_kind     TEXT NOT NULL,
    -- OBSERVED_OBJECT | DESIGN_OBJECT | EXTERNAL
    callee_object_id    TEXT,
    callee_design_object_id TEXT,
    external_target     TEXT,
    required            INTEGER NOT NULL DEFAULT 1,
    rationale_content_id TEXT,
    FOREIGN KEY(target_contract_id) REFERENCES function_contracts(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_planned_calls_contract
ON planned_call_edges(target_contract_id, edge_action);
```

---

# 38. implementation_bindings

```sql
CREATE TABLE implementation_bindings (
    id                  TEXT PRIMARY KEY,
    design_object_id    TEXT NOT NULL,
    repo_snapshot_id    TEXT NOT NULL,
    implemented_object_id TEXT,
    implemented_symbol_version_id TEXT,
    binding_method      TEXT NOT NULL,
    status              TEXT NOT NULL,
    confidence          REAL,
    created_at_ms       INTEGER NOT NULL
) STRICT;
```

---

# 39. acceptance_criteria

```sql
CREATE TABLE acceptance_criteria (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT NOT NULL,
    criterion_key       TEXT NOT NULL,
    work_item_id        TEXT,
    change_spec_id      TEXT,
    design_object_id    TEXT,
    target_assertion_id TEXT,
    criterion_kind      TEXT NOT NULL,
    description_content_id TEXT NOT NULL,
    required            INTEGER NOT NULL DEFAULT 1,
    priority            INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL,
    UNIQUE(plan_version_id, criterion_key)
) STRICT;
```

---

# 40. verification_specs

```sql
CREATE TABLE verification_specs (
    id                  TEXT PRIMARY KEY,
    acceptance_criterion_id TEXT NOT NULL,
    verifier_kind       TEXT NOT NULL,
    command_content_id  TEXT,
    expected_exit_code  INTEGER,
    query_content_id    TEXT,
    expected_value_json TEXT,
    comparison_operator TEXT,
    required_role_id    TEXT,
    environment_requirement_id TEXT,
    config_json         TEXT,
    FOREIGN KEY(acceptance_criterion_id) REFERENCES acceptance_criteria(id) ON DELETE CASCADE
) STRICT;
```

---

# 41. acceptance_evaluations

```sql
CREATE TABLE acceptance_evaluations (
    id                  TEXT PRIMARY KEY,
    criterion_id        TEXT NOT NULL,
    work_attempt_id     TEXT,
    repo_snapshot_id    TEXT,
    verification_run_id TEXT,
    evaluator_actor_id  TEXT,
    observed_value_json TEXT,
    result              TEXT NOT NULL,
    error_content_id    TEXT,
    evaluated_at_ms     INTEGER NOT NULL,
    FOREIGN KEY(criterion_id) REFERENCES acceptance_criteria(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_accept_eval_criterion_time
ON acceptance_evaluations(criterion_id, evaluated_at_ms DESC);
```

---

# 42. contract_diff_runs / contract_diff_items

```sql
CREATE TABLE contract_diff_runs (
    id                  TEXT PRIMARY KEY,
    change_spec_id      TEXT NOT NULL,
    target_contract_id  TEXT NOT NULL,
    implemented_contract_id TEXT NOT NULL,
    repo_snapshot_id    TEXT NOT NULL,
    result              TEXT NOT NULL,
    created_at_ms       INTEGER NOT NULL
) STRICT;

CREATE TABLE contract_diff_items (
    id                  TEXT PRIMARY KEY,
    diff_run_id         TEXT NOT NULL,
    diff_kind           TEXT NOT NULL,
    subject             TEXT NOT NULL,
    expected_content_id TEXT,
    observed_content_id TEXT,
    severity            TEXT NOT NULL,
    result              TEXT NOT NULL,
    FOREIGN KEY(diff_run_id) REFERENCES contract_diff_runs(id) ON DELETE CASCADE
) STRICT;
```

---

# 43. work_item_artifacts

```sql
CREATE TABLE work_item_artifacts (
    work_item_id        TEXT NOT NULL,
    artifact_kind       TEXT NOT NULL,
    object_id           TEXT NOT NULL,
    relation_kind       TEXT NOT NULL,
    PRIMARY KEY(work_item_id, artifact_kind, object_id, relation_kind)
) STRICT;
```

---

# 44. plan_imports

```sql
CREATE TABLE plan_imports (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    source_content_id   TEXT NOT NULL,
    source_hash         TEXT NOT NULL,
    schema_version      INTEGER NOT NULL,
    importer_version    TEXT NOT NULL,
    imported_plan_version_id TEXT,
    status              TEXT NOT NULL,
    started_at_ms       INTEGER NOT NULL,
    ended_at_ms         INTEGER
) STRICT;
```

---

# 45. plan_compile_diagnostics

```sql
CREATE TABLE plan_compile_diagnostics (
    id                  TEXT PRIMARY KEY,
    plan_import_id      TEXT NOT NULL,
    severity            TEXT NOT NULL,
    diagnostic_code     TEXT NOT NULL,
    object_path         TEXT,
    message             TEXT NOT NULL,
    related_object_type TEXT,
    related_object_id   TEXT,
    created_at_ms       INTEGER NOT NULL,
    FOREIGN KEY(plan_import_id) REFERENCES plan_imports(id) ON DELETE CASCADE
) STRICT;
```

---

# 46. Owner / Agent Todo Views

概念：

```sql
CREATE VIEW v_owner_todos AS
SELECT w.*
FROM work_items w
WHERE w.executor_kind = 'OWNER'
  AND w.status NOT IN ('done','cancelled','superseded');

CREATE VIEW v_agent_todos AS
SELECT w.*
FROM work_items w
WHERE w.executor_kind = 'AGENT'
  AND w.status NOT IN ('done','cancelled','superseded');
```

实际状态值由最终 migration vocabulary 固化。

---

# 47. Readiness Projection

建议不要把 readiness 永久当唯一字段。

`computeWorkReadiness()` 是 source of truth。

允许缓存：

```text
work_readiness_cache
```

但必须有 dependency/event cursor，失效后重算。

---

# 48. Project Status Projection

建议 materialized rollup：

```text
project_status_rollup
```

只服务 UI/report，不作为任务调度事实源。

---

# 49. Optimistic Locking

参考成熟 work-package 系统，`work_items.lock_version` 第一版就保留。

所有用户/Agent 修改当前 projection：

```text
WHERE id=? AND lock_version=?
```

成功后：

```text
lock_version += 1
```

lease 与 optimistic lock 作用不同：

```text
lease = primary execution ownership
lock_version = stale write detection
```

---

# 50. Event + Projection Invariant

任何重要 mutation：

```text
transaction:
append project_event
+ update current projection
```

测试必须支持：

```text
snapshot current projection
rebuild from events
compare semantic equality
```

不是要求所有巨量源码数据 event sourced；Project Execution Domain 必须。

---

# 51. Plan Import Transaction

步骤：

```text
parse/validate/compile outside write tx

BEGIN IMMEDIATE
insert plan_import
insert immutable plan version
insert project data
append events
mark import success
COMMIT
```

任何 hard failure：ROLLBACK。

---

# 52. Function Contract Baseline Capture

Observed baseline contract不是 Plan author 手写。

来自：

```text
symbol_versions
TypeChecker signature
call_sites
source anchors
```

Plan 可写期望：

```text
same-as-baseline
```

但 activation 时必须 materialize 成 pinned concrete target contract。

---

# 53. Design Object Identity

建议 stable key：

```text
<kind>:<namespace/path>:<qualified-name>
```

ADD target 在同 plan_version 唯一。

MODIFY target同时保存：

```text
baseline_object_id
expected baseline stable key
expected baseline version/hash
```

防止计划悄悄绑定到不同函数。

---

# 54. Acceptance Completion Rule

Work Item DONE 的最小规则：

```text
所有 required ChangeSpec 有 implementation binding
所有 required contract conformance PASS
所有 required acceptance criterion 最新有效 evaluation PASS
所有 hard blockers resolved
required review/owner approval complete
```

不能只看 Agent 自己返回 ROUND_DONE。

---

# 55. Multi-Agent Concurrency Invariant

第一版：

```text
同一个 work item 只有一个 active primary lease
```

review/test assignment 可以并行。

scope reservation 再控制跨 work-item 写冲突。

---

# 56. Android Resource Example

`resource_requirements.constraints_json`：

```json
{
  "platform": "android",
  "physical": true,
  "minApiLevel": 30,
  "developerMode": true,
  "usbDebugging": true,
  "adbAuthorized": true
}
```

Owner 提供后：

```text
resource_instance status=provided
```

Agent/System verify 后：

```text
status=verified
```

只有 verified 才解除 hard resource blocker。

---

# 57. Query/Index Requirements

必须有索引覆盖：

```text
work_items(project,status,priority)
work relations from/to
assignments actor/status
active leases
scope reservations
open decisions
resources by status
acceptance by work/change
latest evaluations
function contracts by design/state
planned calls by contract
bindings by design/snapshot
project events by sequence
```

synthetic 至少：

```text
100k work items
1m project events
100k acceptance evaluations
```

关键 readiness/dashboard query 必须 query-plan 测试。

---

# 58. v1.6 Schema DoD

- [ ] v1.5 migration fixture升级成功
- [ ] project/repository separation
- [ ] append-only project events
- [ ] immutable plan versions
- [ ] work hierarchy and relations
- [ ] actors/roles/assignments
- [ ] leases/scope reservations
- [ ] decisions and approvals separate
- [ ] resources requirement/instance/verification
- [ ] workflows/handoffs/conflicts
- [ ] design objects/change specs
- [ ] function baseline/target/implemented contracts
- [ ] parameters/effects/planned calls
- [ ] implementation binding
- [ ] acceptance/spec/evaluation history
- [ ] contract diff
- [ ] plan import diagnostics
- [ ] owner/agent todo queries
- [ ] event replay parity
- [ ] query-plan gates
