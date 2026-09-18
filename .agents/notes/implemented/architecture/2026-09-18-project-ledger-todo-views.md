# Agent Note: Project Ledger Todo Views

Status: implemented

English | [中文](2026-09-18-project-ledger-todo-views.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W10 (TODO-001, BOOT-03): Owner and Agent work queries must be distinct, and session todo completion must not be able to complete a project work item (§11, §5.3, AC-TODO-001). The ledger had per-item queries (`computeWorkReadiness`) but no list surface: nothing answered "what is outstanding for this executor", and the §11 separation existed only as data (`executor_kind`), not as a seam.

## Decision

`todo-views.ts` (packages/experimental/project-ledger) owns the seam. `resolveWorkTodoSpec` is the explicit request/spec step: an omitted kind filter defaults to every executor kind, a named filter is de-duplicated and sorted for a stable query and a stable echoed `executorKinds`, and an explicitly empty filter fails loud (`empty-executor-kinds`) instead of silently listing nothing. `listWorkTodo` runs one read-only query — executor kinds × non-terminal statuses, ordered by kind, descending priority, age, then id (matching the `idx_work_items_ready` column order) — and decorates each entry with the recomputed readiness (the same `computeWorkReadiness` claims use, never the materialized status) and the live lease (`ACTIVE` and unexpired, so a reaped-but-unreaped row does not show as held). `listOwnerTodo` and `listAgentTodo` are the §11 views with the filter fixed to `OWNER` / `AGENT`, the queries `/project todo --owner` and `--agent` will project.

- **Views never mutate.** No view path moves a status, records an event, or exposes a write: completion stays with `changeWorkStatus`'s acceptance gate, claims stay with the lease seam, and the module owns no writer at all.
- **The boundary is behavioral, already enforced, and now pinned in the AC test.** A session todo has no stable item ids and no project identity, and the status writer has no API that accepts an external "completed" flag: `todo-views.spec.ts` shows `DONE` refused from a non-`VERIFYING` status (`transition-not-allowed`), refused from `VERIFYING` while a required criterion is outstanding (`acceptance-not-passed`), and reached only after an evaluation moves the criterion — then the completed item leaves the view. `bridges.spec.ts` (W08) separately pins that `dsh-tool-todo` declares no ledger dependency.
- **v1.6b grows the axis, not a parallel seam.** §11 defers actor/role/assignment; when it lands, the kind filter extends and the two named views keep their contracts.

Verification: `packages/experimental/project-ledger/tests/todo-views.spec.ts` (8 tests) for AC-TODO-001 — spec resolution, golden-plan separation (owner = the one OWNER item with its recomputed blocker; agent = 14 AGENT items, disjoint, ordered), live-lease and expired-lease display after a claim, mixed-kind ordering, a phase-less ad hoc item, and the completion boundary end to end; 173 tests in the package; per-file 100% coverage maintained.

## Alternatives considered

**One parameterized function with a documented convention for owner/agent.** Rejected — §11 names two views; named seams (`listOwnerTodo`/`listAgentTodo`) make the separation the API rather than a caller's discipline, while `listWorkTodo` stays available for the general and future actor-filtered queries.

**Filter by readiness to list only actionable work.** Rejected — a todo that hides blocked work hides the reasons work is stuck; entries carry the recomputed blockers instead, so `--owner` shows an owner exactly what is holding their items up (an unactivated plan version, an open external blocker, a failing criterion).

**Build the `/project todo` slash commands here.** Rejected — the ledger is a cordis-free library (W08's isolation design); the command surface belongs to the mini profile, and the AC's verifier lives against the query seam.

## Consequences

The W12 real-use slice and any mini-profile command can project `/project todo --owner`/`--agent` directly from these queries with no ledger-side work left; `WorkTodoEntry`'s readiness-plus-lease shape means the display needs no second query per item. When v1.6b adds actor/role/assignment, `resolveWorkTodoSpec` is the single place the default and validation live.
