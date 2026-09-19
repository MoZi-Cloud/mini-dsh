# Project Ledger

English | [中文](project-ledger.zh.md)

The Project Ledger is the Plan-as-Data source of truth for repository work: plan documents parse, validate, and compile into immutable versioned rows, and every later change appends a versioned project event. Replaying a project's event timeline rebuilds the projection the materialized tables store, so ledger integrity is checkable read-only at any time.

## Mount the ledger

The `mini` profile composition mounts [`dsh-experimental-mini-profile`](../../packages/experimental/mini-profile/README.md), whose `mini-project-ledger` plugin opens the SQLite database through the store's fail-closed open (owner-only files, pragmas, adjacent migrations, version stamp) and exposes the handle as `ctx.projectLedger`. The mount validates `ledgerPath` and `busyTimeoutMs` at load; a database stamped newer than the build refuses the launch rather than downgrading. The ledger path comes from `DSH_MINI_LEDGER_PATH` with a dsh-home fallback.

## Work through seams

Nothing writes to the ledger tables directly. [`dsh-experimental-project-ledger`](../../packages/experimental/project-ledger/README.md) owns the seams: importing a plan version, recomputing work readiness, the lease lifecycle, appending acceptance evaluations, superseding versions, recording baseline drift, and building bounded work packets. Two profile surfaces consume them:

- The `/project` command reads: todo views by executor kind, the plan doctor, per-item reviews and evaluation histories with observed evidence, the replay audit that compares the rebuilt projection with the materialized rows in both directions, and the evidence digest that aggregates plan versions, item completion with per-criterion verdicts, and the replay verdict — which `export` renders again as one archival markdown block.
- The `project_work_next`, `project_work_claim`, and `project_work_update` tools give an agent the same work through one bounded WorkPacket per task; the claim's bearer token never enters a model-visible value.

## Integrity is a fact, not a repair

Evaluations are append-only history and statuses are the projection; acceptance is the only completion authority, so no session todo or plan edit can shortcut work to done. The doctor re-verifies an imported version in one pass — flagging even lease rows that still record ACTIVE past their own expiry, the rows a behind reaper owes recovery — the replay audit reports any divergence between events and rows, and neither mutates or executes a verifier command. Work packets carry only their recorded recipe; a rebuild recomposes the packet from current rows and names what drifted.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxprojectledger--miniprojectledger"></a>

### `ctx.projectLedger` — `MiniProjectLedger`

The mounted Project Ledger capability, exposed as `ctx.projectLedger`.

Source: [`packages/experimental/mini-profile/src/index.ts`](../../packages/experimental/mini-profile/src/index.ts)
<!-- END GENERATED cordis-surface -->
