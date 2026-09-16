# Agent Note: Project Ledger SQLite Store

Status: implemented

English | [中文](2026-09-16-project-ledger-sqlite-store.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W02 "Ledger SQLite identity/runtime" (DB-001): the thirteen-table Ledger Core schema needs a physical home with a fail-closed open sequence — `user_version` identity, WAL and busy timeout, owner-only files, mismatch rejection — plus an adjacent-migration story, before any plan import or event append exists. The acceptance fixture had to say what "upgrade without data loss" means when the only shipped layout version is 1.

## Decision

One package, `packages/experimental/project-ledger-sqlite`, owns the persistence identity: the v1 DDL, the open sequence, and the migration engine. `openProjectLedgerDatabase` creates owner-only files, applies `foreign_keys`/`journal_mode`/`busy_timeout`, then brings `user_version` current through `applyProjectLedgerMigrations`.

- **The initial materialization is migration `0 → 1`.** Version 0 is "empty or interrupted", not a shipped layout: the step creates the v1 tables with `IF NOT EXISTS`, so a crash between `COMMIT` and the stamp leaves version 0 and the next open retries harmlessly. The stamp lands only after every step commits. Future layout versions append exactly one frozen step; the engine rejects a registry that skips a version or stops short of the build's version.
- **Health checks belong to the fixture, not the open path.** The attachment's `foreign_key_check`/`integrity_check`/row-parity protocol runs per migration fixture in the suite; running `integrity_check` on every production open would scan the whole database for no protective gain. The fixture simulates the crash window (tables present, stamp reset to 0, rows committed) and asserts version recovery plus row parity on the only shipped step.
- **The attachment's SQL is transcribed, not re-derived.** Every table definition, CHECK, unique constraint, and index matches the v1.6a attachment text; the suite pins the exact table and index sets, the `plans`-has-no-status rule, STRICT type enforcement, foreign-key coverage per child edge, the tagged-row verifier CHECK, and the one-active-lease partial unique index.
- **W02 ships no typed data access.** The store surface is the open sequence; plan import (W03), the event envelope (W04), readiness (W05), acceptance storage (W06), and leases (W07) add their methods here so each capability's transactional rules land with its API instead of growing a generic escape hatch.

Verification: 24 package tests covering the DB-001 matrix — fresh open, unknown-version rejection leaving the file untouched, the interrupted-materialization migration fixture, registry gap/short-circuit/rollback, and the schema contract checks above; per-file coverage 100% on the package source.

## Alternatives considered

**Run `foreign_key_check`/`integrity_check` inside every open.** Rejected — both scans are linear in database size and protect against nothing the step transactionality does not already prevent; the fixture protocol keeps the guarantee where it is real.

**Bake the migration list into the open function as code.** Rejected — the registry is data so a future step is one appended entry with its description, and the engine's gap/short-circuit rejections are unit-testable without fabricating databases.

**Ship a `ProjectLedger` wrapper class with `transaction()` now.** Rejected for this work package — with no data methods there is nothing to transact, and a public raw-SQL escape hatch would invite callers around the capability seams that W03+ own.

## Consequences

W03's compiler imports against `openProjectLedgerDatabase` directly: the layout exists, foreign keys and STRICT are enforced by SQLite, and idempotent re-materialization plus stamp-last recovery are already the tested behavior. Adding layout v2 later means appending one `ProjectLedgerMigration` entry and one fixture — the engine and fixture protocol do not change.
