# Agent Note: Project Ledger Acceptance Evaluations

Status: implemented

English | [中文](2026-09-17-project-ledger-acceptance-evaluations.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W06 "Acceptance and verifier storage" (ACCEPT-001): evaluations must append history, the criterion row's status must move as a projection, and the whole thing must stay reconstructable from the event timeline — while the package keeps never executing a verifier (§9). The replay fold also had to decide where acceptance criteria live, because no v1 event creates them.

## Decision

`evaluateAcceptanceCriterion` records a caller-reported result in one `BEGIN IMMEDIATE` transaction: the append-only `acceptance_evaluations` row, the criterion's projection status, and the `acceptance/evaluated` event. Nothing reads `command_text` with intent to run it — the result is whatever the caller reports, which is what lets a driver, a human confirmation, or a later engine own actual execution.

- **`ERROR` records history without moving the projection.** The result-to-status map produces a status for `PASS`, `FAIL`, `BLOCKED`, and `WAIVED`; an errored verification produced no verdict, so the criterion keeps its current status. The event payload carries the post-evaluation status either way, so the replay applier stays total.
- **Criteria enter the fold through `work/created`.** The v1 vocabulary has no criterion-creation event, and criteria are created with their item, so the `work/created` payload now carries them (id, ordinal, kind, required, and the explicit initial `PENDING` status) and the replayed work item holds a criteria map. Replay parity now covers criterion status end to end, and an `acceptance/evaluated` naming an unknown item or criterion fails the replay closed.
- **Evaluation row ids derive from the event sequence** (`ev:<criterionId>:<sequenceNo>`): the row and its event are born in the same transaction and reference each other without a counter query.
- **The readiness loop closes.** W05's readiness reads required criteria in `FAILING`/`BLOCKED`; an evaluation to `WAIVED` or `PASS` unblocks the item through the same rows, which the acceptance tests assert against `computeWorkReadiness`.

Verification: `packages/experimental/project-ledger/tests/acceptance.spec.ts` — every verifier kind's tagged spec columns stored untouched, the negative proof that a stored command never runs (an unrunnable command still evaluates `PASS`), the full result-to-status table, `ERROR` as history-only, append-only history across re-evaluations, unknown-criterion rejection without writes, a trigger-forced rollback, replay parity through evaluations, and the readiness closed loop. 27 acceptance and codec tests in the file set, per-file 100% coverage.

## Alternatives considered

**Execute the verifier and record the outcome.** Rejected — §9 forbids the Project Ledger from executing `command_text`; the seam stays storage-plus-projection, and execution belongs to whichever driver owns the run.

**One event per criterion at import.** Rejected — the v1 vocabulary has no such event, and 16 extra rows would duplicate what `work/created` already binds to its item; carrying criteria in the created payload is the one factoring that keeps replay total without vocabulary growth.

**Derive the initial status instead of storing it.** Rejected — a decoder that assumes `PENDING` silently guesses; the explicit field keeps every payload self-describing and lets the codec fail closed on anything else.

**Bump `PROJECT_EVENT_FORMAT_VERSION` for the payload extensions.** Rejected — as in W05, no v1 ledger written by an earlier build exists; a bump would advertise a predecessor generation that never shipped.

## Consequences

W07 (lease) can gate claims on readiness that now includes failing criteria, and reaps against a criterion projection that events maintain; W09 (WorkPacket) reads the same tagged spec rows to tell an agent what "done" means; a future verifier-executing driver reports through `evaluateAcceptanceCriterion` instead of growing this package.
