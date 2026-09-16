# Agent Note: Project Ledger Plan Compiler and Import

Status: implemented

English | [中文](2026-09-16-project-ledger-plan-import.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W03 "Plan compiler and immutable import" (IMPORT-001): a validated plan document must become an immutable plan version in the SQLite ledger — golden plan imports once, re-import is idempotent by hash, and compile errors do not partially write. The compiler had to decide how row identities are derived, what the two hash columns hash, and what happens when a new plan version re-declares work items the ledger already records.

## Decision

`compilePlan` (pure) and `importPlanVersion` (transactional) live in `packages/experimental/project-ledger`, against any `DatabaseSync` carrying the ledger layout; the physical store stays in `project-ledger-sqlite`, so this package takes no runtime dependency on it.

- **Row identities are deterministic derivations** (`wi:<project>:<work id>`, `plv:<plan>:v<n>`, `ph:…`, `rel:…`, `ac:…`, `vs:…`), not random ids: the same source bytes compile to the same primary keys in every ledger database, which is what makes a content-addressed ledger comparable across machines and replay-friendly. They are branded at the type level and injective for ids without `:`; an adversarial collision fails loud on the primary key.
- **The two hash columns hash different things.** `source_document_hash` is the SHA-256 of the exact decoded source text and is the re-import idempotency key; `compiled_ir_hash` is the SHA-256 of the sorted-key canonical JSON of the emitted rows, so member order never affects it while row order does.
- **The conflict rule table is fail-loud in both directions.** Same plan and source hash short-circuits without writing; a version number reused with different content throws `version-conflict`; a new version re-declaring a work item already recorded under another version or the backlog throws `work-item-conflict`. `work_items` is a project-scoped current-projection table (one row per project item, `plan_version_id` pointing at the carrying version), so moving items between versions is the supersede flow's decision (W11), not an import side effect.
- **Events append inside the import transaction** (`plan/imported`, then `work/created` per item), per the attachment's §15 rule that projection mutations and events commit atomically. `PROJECT_EVENT_FORMAT_VERSION` is duplicated locally and pinned to the SQLite package's constant by a test — the same mirror pattern as the constitution schema — until W04 moves the event vocabulary into one home.
- **Import never activates.** Every imported version lands as `DRAFT`, `plans.current_version_id` stays untouched, and `plan_imports` records only `IMPORTED` rows: compile is pure and rejects before any write, so the `REJECTED`/diagnostics bookkeeping awaits the driver or CLI layer that can actually catch a rejection mid-pipeline.

Verification: `packages/experimental/project-ledger/tests/import.spec.ts` — the repository's golden plan (13 phases / 15 work items / 14 relations / 16 criteria) imports once with exact row identities, re-import by hash writes nothing, a mid-transaction write failure and an impossible verifier variant each roll back to a row-less ledger, and all five verifier kinds bind to their tagged spec rows.

## Alternatives considered

**Random (UUID) row ids.** Rejected — a source-of-truth ledger gains cross-database comparability and stable references from deterministic identities, and re-import idempotency by hash would otherwise hide a new row-generation from every foreign key.

**UPSERT work items on re-declaration.** Rejected — silently re-pointing the projection at a `DRAFT` version steals the supersede decision (status transitions, events, baseline checks) that W11 exists to make. Loud rejection keeps that decision with its owner.

**Defer event writes to W04.** Rejected — §15 makes the event a precondition of projection mutation; importing without events would create ledger state that W04's replay could never reconstruct.

## Consequences

W04 (project events) inherits concrete `plan/imported`/`work/created` rows to define its envelope and replay parity against, and should absorb the duplicated format constant. W05/W06 read the identities and tagged verifier rows this package now writes; the supersede flow (W11) extends `importWithinTransaction`'s conflict table instead of replacing it.
