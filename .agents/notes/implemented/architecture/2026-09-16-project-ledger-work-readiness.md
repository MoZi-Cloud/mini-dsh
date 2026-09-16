# Agent Note: Project Ledger Work Readiness and Status Transitions

Status: implemented

English | [中文](2026-09-16-project-ledger-work-readiness.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W05 "Work relations and readiness" (READY-001): blocked work must not be claimable, hierarchy must not act as dependency, and cycle detection must guard the ledger, not only the document. Readiness had to decide what it reads, whether the materialized status is truth, and which writer owns `work/status-changed`.

## Decision

`computeWorkReadiness` recomputes claimability from the causal rows the constitution lists (§12/§17); the materialized `READY`/`BLOCKED` status is a projection of those inputs and is never consulted as truth.

- **The status gate enumerates the open set.** Only `PROPOSED`, `READY`, and `BLOCKED` are open to a claim; mid-flight and terminal statuses close it. Enumerating the open side keeps unknown statuses closed. A stale `BLOCKED` with no causal blocker recomputes to ready — that recompute is what lets the projection move the row back (§13).
- **Hierarchy is excluded by construction.** `parent_work_item_id` is composition (§10); readiness never reads it. The AC test makes a child of a not-DONE parent stay claimable.
- **"Parent phase active" reads as open for work.** Phases accept `READY` or `ACTIVE`; `PLANNED` blocks. No writer can set a phase `ACTIVE` yet, so the looser reading is what keeps imported `READY` phases claimable end to end.
- **Blocking edges are `BLOCKS`/`PRECEDES` with a not-`DONE` source.** Incoming `SUPERSEDES` edges are the supersede flow's projection (W11). External blockers block while `OPEN`; required criteria block while `FAILING`/`BLOCKED`; a lease blocks while `ACTIVE` and unexpired. Unplanned backlog (`plan_version_id` NULL) skips the version check by design (§9.3).
- **Cycle semantics have one home.** `relation-graph.ts` owns the ordering-relation kinds and both walks; `validatePlanSemantics` and the ledger-side `detectWorkGraphCycles` consume them, so a document and the rows it produced always get the same verdict. Compile-time issue messages are byte-identical to the pre-extraction ones.
- **`work/status-changed` gets the generic writer.** `changeWorkStatus` works from a closed transition table and refuses the transitions a dedicated event owns: claiming (`IN_PROGRESS` via `work/claimed`) and the readiness projection's `work/blocked`/`work/unblocked`. Re-presenting the current status is a rejection, not a no-op — a no-op write would append an event without a transition. `work/created` payloads now carry the initial status so replay parity covers the status field; `PROJECT_EVENT_FORMAT_VERSION` stays `1` because no v1 ledger written by an earlier build exists — the version gates cross-build readers, and implying a predecessor format would be false.

Verification: `packages/experimental/project-ledger/tests/readiness.spec.ts` — every blocker kind with its open and closed side, hierarchy independence, stale-status recompute, both lease-expiry clock sides, the full transition table including a trigger-forced rollback, cycle detection including the cross-project skip, and replay parity through status transitions. 23 tests, per-file 100% coverage.

## Alternatives considered

**Trust the status field.** Rejected — §17 makes readiness explicitly not the single status truth, and trusting `READY` would resurrect exactly the stale-projection claim the constitution forbids.

**Consult the parent's status.** Rejected — §10 separates composition from dependency; a parent's progress must never gate a child's claim.

**A second, ledger-side cycle walk.** Rejected — a re-implementation would drift from compile-time semantics; the shared walks are the only way both sides stay one verdict.

**Bump the event format version for the payload extension.** Rejected — the bump signals a reader-compatibility generation; with zero released v1 ledgers it would advertise a predecessor that does not exist.

## Consequences

W06 (acceptance) fills in the criterion statuses readiness already reads; W07 (lease) inherits a lease-aware readiness it can call inside its own `BEGIN IMMEDIATE` and adds the `work/claimed` applier; W11 (supersede) extends readiness with incoming `SUPERSEDES` edges. The future activation writer only needs its row update plus the `plan/version-activated` event to open the golden plan's W00 items.
