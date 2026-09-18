---
description: "SQLite persistence for the v1.6a Project Ledger Core: the thirteen-table layout, adjacent migrations, and a fail-closed open, for maintainers building plan import, activation, or project todo tooling on the ledger."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger-sqlite

English | [中文](README.zh.md)

## Summary

`dsh-experimental-project-ledger-sqlite` owns the SQLite persistence seam of the v1.6a Ledger Core. `openProjectLedgerDatabase` materializes the v1 layout — thirteen STRICT tables from `plans` and `plan_versions` down to `work_leases` — under owner-only files with `foreign_keys` on, the durable WAL journal by default, and a busy timeout for contended writers. The database is a source of truth: a stamped `user_version` newer than the build rejects, older versions upgrade through shipped adjacent migration steps applied one `BEGIN IMMEDIATE` transaction at a time, and the version stamp lands only after the migrated layout is complete. Verifier commands are stored data; this package never executes one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Open a database path (or `:memory:`); the returned handle is a `node:sqlite` `DatabaseSync` with pragmas applied and the current layout ensured:

```ts
import { openProjectLedgerDatabase, PROJECT_LEDGER_SCHEMA_VERSION } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'

declare const ledgerPath: string

const db = await openProjectLedgerDatabase(ledgerPath, { journalMode: 'wal', busyTimeoutMs: 5000 })
// STRICT tables, foreign keys on, stamped with PROJECT_LEDGER_SCHEMA_VERSION
db.close()
```

`PROJECT_LEDGER_MIGRATIONS` is the frozen adjacent-step registry; `applyProjectLedgerMigrations` runs it on an open handle and is what the open sequence itself uses. A database stamped with an unknown version rejects with `ProjectLedgerError` code `version-mismatch` and is left untouched.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Stamp last, reject newer** — the `user_version` stamp asserts the migrated layout is complete, so a failure mid-open leaves the old version stamped and the next open retries the step; a version newer than this build fails closed instead of downgrading.
- **Adjacent steps only** — every layout change appends one migration (`0 → 1 → …`); shipped steps are frozen and each runs in its own transaction, so a failing step rolls back instead of half-applying. A registry that skips a version or stops short fails loud.
- **No second plan authority** — `plans` carries no status; plan state lives in `plan_versions.status` alone. `work_items.plan_version_id` is nullable so out-of-plan backlog work is a first-class row.
- **Typed verifier storage** — `verification_specs` keeps one tagged row per acceptance criterion with a table CHECK mirroring the plan schema's discriminated verifier union; `acceptance_evaluations` is append-only history, and the one-active-lease invariant is a partial unique index.

<a id="dev-note"></a>
## Dev Note

No runtime invariant companion is published: the layout, open sequence, and migration engine are enforced by this package's own tests against a local SQLite handle; nothing here can diverge across independent vantage points.

<a id="model-experience"></a>
## Model Experience

None, as the store persists plan and work facts and serves callers directly; verifier commands are stored data here, never executed processes.

#### KV Cache effect

None — the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Schema only, no typed access yet** — the typed surfaces that write and read these tables live in `dsh-experimental-project-ledger` against an open handle: plan import (W03), the project event envelope (W04), the readiness projection (W05), acceptance evaluations (W06), and lease claiming (W07) are shipped there; this package ships the identity, layout, and open sequence.
- **One migration step** — the registry stops at `0 → 1`; the fixture protocol (foreign-key check, integrity check, row parity) is exercised by the suite on the shipped step.
- **No cross-process coordination** — concurrency defense is `busy_timeout`; `BEGIN IMMEDIATE` allocation paths for events and leases arrive with those work packages.
