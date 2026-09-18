# Agent Note: Project Ledger Version Supersede and Baseline Drift

Status: implemented

English | [中文](2026-09-18-project-ledger-versioning.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W11 (VERSION-001, BOOT-08): superseded plan versions must remain queryable, new claims must stop, active attempts must require review, and historical evaluations must remain unchanged (§21/§22, AC-VERSION-001). The version lifecycle had rows and a vocabulary (`SUPERSEDED`, `superseded_at_ms`, `plan/version-superseded`, `baseline/drift-detected`) but no writer: activation and retirement existed only as raw test updates, and nothing answered a repository that had moved off a version's pinned baseline.

## Decision

`versioning.ts` (packages/experimental/project-ledger) owns the two writers. `supersedePlanVersion` retires an `ACTIVE` version inside one `BEGIN IMMEDIATE`: it appends the required `plan/version-superseded` event (payload: plan id, version id, optional successor, the `freeze-new-claims-and-review-active` policy, the live-attempt review queue), moves only the lifecycle columns, and repoints `plans.current_version_id` when it named the retired version. `recordBaselineDrift` compares a caller's observed repository facts with the version's pinned baseline, appends `baseline/drift-detected`, and opens a `BASELINE_DRIFT` external blocker on the work item — the drift id derives from the event sequence (`dr:<workItemId>:<sequence>`), symmetric with lease and packet ids.

- **Freeze and review come from existing seams, not new gates.** Once the version is `SUPERSEDED`, `computeWorkReadiness` denies every new claim (`plan-version-not-active`); live attempts keep their leases and their version binding, and the release/reap path's projection recompute lands them `BLOCKED` — never resurrected — so resuming is an owner's rebind decision. The review queue is the event payload plus the returned `reviewAttempts`; no blocker rows are invented for it.
- **Immutability is column-scoped.** A supersede touches `status`, `superseded_at_ms`, and the plans pointer; source/IR hashes, baseline pins, work-item version bindings, and every evaluation row stay byte-identical, and a drift never moves the baseline columns — the observed facts live in the event and the blocker row only.
- **The appliers are validation-only.** Replay folds `plan/version-superseded` and `baseline/drift-detected` without projection state: their writers own lifecycle columns and external blocker rows, which the fold's version facts do not carry. The fold still fails closed on a payload naming an unknown version or item, a plan-id mismatch, a wrong policy literal, a double retirement, or mistyped fields. `SUPERSEDE_POLICY` lives in the event module (like the packet reference kinds) so payload validation needs no runtime import from the versioning module.
- **Unpinned versions cannot drift.** Both baseline columns null means nothing was pinned, so drift is undefined (`baseline-unpinned`); facts equal to the pin are not drift (`baseline-unchanged`). Both fail loud rather than recording noise.

Verification: `packages/experimental/project-ledger/tests/versioning.spec.ts` (8 tests) for AC-VERSION-001 — the retire/freeze/review/history end to end on the golden plan, successor and rejection paths, drift recorded through a real baseline-pinned plan fixture with claims denied and the pin untouched, partially pinned baselines, and the fail-closed replay cases; 186 tests across the three experimental packages; per-file 100% coverage maintained.

## Alternatives considered

**Write `APPROVAL` blocker rows for the attempts needing review.** Rejected — external blockers are owner-side world facts (and had no writer yet); a review queue duplicated into a table the fold does not project adds state without adding a reader. The event payload is the durable queue, and the attempts' own lease lifecycle already carries what review decides.

**Track version status in the replayed projection.** Rejected — parity compares the fold against materialized rows, and activation has no writer or event applier, so a replayed status would diverge from the rows the tests set through the activation seam. When an activation writer lands with its event, replay can grow the field with real parity behind it.

**Resolve or waive drift blockers in this package.** Rejected — resolution is an owner decision (fix, waive, or supersede); shipping a waive writer here would let the same seam create and dissolve the block, which is exactly the silent-rebind shape §21 forbids.

**Compute drift inside the claim path.** Rejected — the ledger cannot see the repository; §21's comparison is a caller-reported observation, so the writer takes observed facts and fails loud when they equal the pin or the version never pinned one.

## Consequences

W12's real-use slice can retire the golden v1 version the moment a successor exists, and any claim-time integration can call `recordBaselineDrift` with the repo facts it already observes; the blocker kind rides the existing readiness blocker surface, so todo views and readiness need no change. The carry-forward/adoption flow (re-declaring inherited work items under the successor, §9.3) remains import's `work-item-conflict` away — the next version's seam — and drift-blocker resolution stays owner-side until that same flow lands.
