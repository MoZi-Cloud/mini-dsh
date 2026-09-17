# Agent Note: Project Ledger Mini Profile Mount

Status: implemented

English | [中文](2026-09-16-project-ledger-mini-profile.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W08 (INTEGRATE-001): Project Ledger must mount through `dsh --profile mini` — the only supported launch form, with no package bin — and the authority boundaries among Project Ledger, plan mode, and the session todo tool need focused tests (§4-§6, AC-INTEGRATE-001/002). The ledger was a pure library: nothing opened a database in a live profile, and nothing stopped another surface from claiming completion authority.

## Decision

A new experimental profile bundle, `@deepseek-ai/dsh-experimental-mini-profile` (packages/experimental/mini-profile), layers one insert over `dsh-base`. Its `mini-project-ledger` plugin owns the capability's lifecycle: schemastery-validated `ledgerPath` (resolved by the patch from `DSH_MINI_LEDGER_PATH` with a dsh-home fallback) and `busyTimeoutMs`, an async service init that opens through the SQLite store's fail-closed open and settles the tree only once the store is migrated and stamped, and a yielded disposer that closes the handle. The service registers as `ctx.projectLedger` and exposes the opened handle; it deliberately owns no ledger semantics — consumers call the seam functions, so the library stays cordis-free and the provider stays thin.

The bundle deliberately does NOT join `PROFILE_TEMPLATES` and `apps/cli` does not depend on it: the default-product isolation gate refuses experimental packages in every shipped composition and installation default, and the ledger packages are pinned to the experimental group (§6). A `mini` profile is created by the ordinary flow — `dsh --profile mini` initializes it over `dsh-base`, then `dsh plugin --profile mini add @deepseek-ai/dsh-experimental-mini-profile` attaches the bundle persistently — which keeps `dsh --profile mini` the only launch form without a bin while the capability stays a private experimental proof.

- **Completion authority moved into the ledger (§5.3).** `changeWorkStatus` now refuses `VERIFYING -> DONE` while any required criterion is not `PASSING` or `WAIVED` (`acceptance-not-passed`), on top of the closed transition table that already reaches `DONE` only from `VERIFYING`. `todo completed != project work item done` is now enforced by the ledger itself, not by convention.
- **Boundaries are tested at the seams that exist.** `bridges.spec.ts` pins the manifest decoupling (agent-loop, agent, plan-mode, and tool-todo declare no ledger dependency; the ledger declares no harness runtime dependency), the pure compile step and the single explicit import seam, version immutability against later plan-document edits (`version-conflict`), the closed `DONE` reachability, and the acceptance gate end to end. It also pins the isolation shape: no `mini` entry in `PROFILE_TEMPLATES`, and the bundle carries no `bin` and mounts exactly one row.

Verification: `pnpm run verify-application-entrypoints` green; `packages/experimental/project-ledger/tests/bridges.spec.ts` (5 tests) for AC-INTEGRATE-002; `packages/bundle/mini/tests/` (5 tests) for the exact composition and the open/serve/dispose lifecycle; per-file 100% coverage across the ledger and the new bundle src; 132 tests across the two packages.

## Alternatives considered

**Put the provider plugin inside `dsh-experimental-project-ledger`.** Rejected — the ledger would grow a cordis peer dependency and plugin-protocol surface before any consumer exists; §6 keeps v1.6a packages private capability proofs, and the bundle is where profile glue lives (the headless bundle precedent).

**Expose a typed facade of ledger operations on the service.** Rejected for now — every method would be an untested pass-through until its consumer lands (W09 WorkPacket, `/project` commands). The handle plus the store's own open contract is the smallest honest seam; typed methods accrete with their consumers.

**Default the ledger path inside the plugin.** Rejected — deployment-varying choices belong to validated config supplied by composition; the patch resolves the environment override and the dsh-home fallback, and the plugin fails loud on an empty path.

**Ship `mini` in `PROFILE_TEMPLATES` with the bundle under `packages/bundle/`.** Rejected — `verify-default-product-isolation` walks every shipped template and CLI dependency and refuses experimental packages there; that gate and §6's experimental placement are the repo's authority, so the mount travels as an experimental bundle attached per profile instead.

**Let `changeWorkStatus` stay table-only and test the authority as convention.** Rejected — §5.3 makes acceptance the completion authority, and a boundary that only a manifest grep enforces is not a boundary; the gate is one query inside the existing transaction and fails loud with the outstanding criterion ids.

## Consequences

W09 (WorkPacket) and the `/project` command surface can read `ctx.projectLedger.db` in the mini profile without new wiring; completion of real work now always leaves an `acceptance/evaluated` trail before the `work/status-changed` event, strengthening replay as the audit record; a future revocation or activation writer slots into the same vocabulary without touching this mount.
