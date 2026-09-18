# Agent Note: The Project Replay Audit and /project replay

Status: implemented

English | [中文](2026-09-19-project-replay-audit-view.zh.md)

## Problem

The v1.6a ledger already folds a project's events into a projection, but its only parity check lives inside the per-version doctor sweep and compares one direction — a materialized row the timeline fails to rebuild — while a replay that names an entity no row carries (a deleted row, a hand-written event) passes unnoticed. The owner the §33 gate asks to confirm the ledger's value had no read-only way to audit the whole project's integrity, and the real-use lane's passing bar stopped at the doctor plus one item's replayed status, so a bidirectional break in the persistent ledger would surface in no gate.

## Decision

A new `readProjectReplay` ledger read seam (`project-replay.ts`) owns the audit: it folds the project's timeline through the fail-closed replay codec and compares the rebuilt projection with the materialized tables family by family — plan versions by identity facts (plan id, version number, source document hash), work items, criteria, and leases by status — in both directions, so a row nothing replays and a replay nothing materializes are both drift. Work packets count on the replayed side only, because the recorded recipe is the packet's whole durable record and no table exists to compare against. When this build cannot decode the timeline the audit returns an `undecodable` outcome carrying why, with the event and materialized counts still reported — a discriminated union instead of paired nullable fields, so a consumer cannot hold a branch that the pairing invariant kills. `/project replay [<project-id>]` renders the audit read-only over the shared project resolution; the doctor keeps its own per-version sweep untouched. The real-use lane's passing bar gains the audit: `assertReplayClean` runs on both the completion and already-complete paths and the report line carries `replayDrift`.

Two neighbors were repaired in passing because they blocked the gate: `todo-views.spec.ts` compared two real-clock calls that straddle a millisecond tick under load (now frozen with fake timers, which also pins the asserted value exactly), and `readWorkItemReview` kept an unreachable `length === 0` early return beside the destructuring check (now one check covering both the empty match and the type-level undefined).

Verification: `project-replay.spec.ts` covers the clean audit after every writer family, materialized-only rows (including a version whose `plan/imported` event was dropped), replay-only entities appended through the event codec, disagreeing statuses and version facts, and the undecodable timeline; the command suite covers the exact rendering, drift lines, and the decode-failure text — both packages at per-file 100% (235 tests). The lane ran green on a temp ledger, on the persistent ledger (`PW-REPLAY-VIEW-001` DONE by `agent:mini-real-use-lane`, doctor 0, `replayDrift` 0, 43 events), and idempotently on rerun; the 4K slice stayed green at max 2,444/4,096 estimated tokens.

## Alternatives considered

**Widen the doctor to project scope and consume it.** Rejected — the doctor is a per-version sweep with its own issue codes and identity facts; the audit is a project-level bidirectional comparison with counts. Widening would change a shipped pass's meaning to add a surface it was never shaped for.

**Copy the doctor's one-directional comparison.** Rejected — the direction the doctor skips is exactly the one an audit owes: a committed row deleted out from under the timeline, or an event naming an entity nothing materializes, is integrity loss the sweep cannot see.

**Report `replayed: Counts | null` beside `timelineError: string | null`.** Rejected — two fields encoding one fact force every consumer into a narrowing branch that the pairing invariant makes unreachable; the discriminated union makes the two states the type instead.

## Consequences

The persistent ledger now carries a standing drift-free obligation: every later increment's lane run asserts bidirectional parity on the real ledger, so a writer that lets projection and tables diverge fails at the lane, not at a customer's SQL. Owner surgery stays visible by design — a hand-activated version does not drift (the fold projects no version status) but a hand-edited source hash or an out-of-band `REVOKED` lease does, which is the audit's job. The §33 count reaches 20; version 2 is fully complete and the next real-use items require a version 3 batch.
