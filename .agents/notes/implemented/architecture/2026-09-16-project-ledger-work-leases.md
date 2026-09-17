# Agent Note: Project Ledger Work Leases

Status: implemented

English | [中文](2026-09-16-project-ledger-work-leases.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W07 "Work lease" (LEASE-001): two claimers racing for one work item must produce exactly one active lease, expired leases must be safely reapable, and an expired or released claim must return the item to `READY`/`BLOCKED` by recomputed projection — never by declaring the task `FAILED` (§13). The `work/claimed`, `work/lease-heartbeat`, `work/lease-expired`, `work/lease-released`, `work/blocked`, and `work/unblocked` writers were still missing from the v1 vocabulary, and the replay fold had to survive a log that now moves leases as well as items.

## Decision

`claimWorkItem` follows the §13 concept order inside one `BEGIN IMMEDIATE` transaction: recompute readiness, reap a stale lease for this item, create exactly one active lease. The `uq_one_active_lease_per_work` partial unique index is the final arbiter; a competing claimer either loses the write lock (`SQLITE_BUSY`) or serializes behind the winner and is rejected by the recomputed live-lease blocker. Heartbeats and releases present a bearer token and must arrive before expiry; everything past expiry belongs to `reapExpiredLeases`, a bounded batch that records `work/lease-expired` per lease and recomputes each item's projection.

- **Only the token holder extends or gives up a lease.** A claim returns a one-time random token; the ledger stores only its SHA-256 hash, and no lease event carries it, so the log rebuilds lease state without replaying secrets. A heartbeat or release at or past expiry is refused instead of resurrecting the lease — the reaper owns recovery.
- **Giving up recomputes, never demotes.** `work/lease-expired` and `work/lease-released` move only an `IN_PROGRESS` item: its own status gate and the lease being given up are excluded from the recompute, and every other readiness input decides `READY` vs `BLOCKED`. An item whose lifecycle moved on (`VERIFYING`, terminal) keeps its status and the event just records it, so the reaper cannot resurrect a `DONE` item.
- **`work/blocked`/`work/unblocked` materialize the recomputed readiness.** They move only the `READY`/`BLOCKED` pair: blocking a clean recompute or unblocking a blocked one has nothing to materialize, and any other status is refused. `work/blocked` carries the recomputed reasons, which is what makes the materialized status auditable from the log.
- **Lease ids derive from the claimed event's sequence** (`ls:<workItemId>:<sequenceNo>`); the writer pre-reads the allocation (`nextProjectEventSequence`) because the payload must name the id, and the held `BEGIN IMMEDIATE` guarantees the pre-read equals the appended envelope's sequence. The replay fold now carries a lease map, so replay parity covers the full lease lifecycle, and a heartbeat, expiry, or release contradicting the replayed lease state fails closed.
- **`LeaseConfig` fails loud at resolve time** (`heartbeatIntervalMs < ttlMs / 2`, §13); `ttlMs` overrides travel with a compatible heartbeat rather than silently mixing with the default.

Verification: `packages/experimental/project-ledger/tests/lease.spec.ts` — the AC race is tested at the lock boundary with two real connections contending mid-transaction (one `SQLITE_BUSY`, one live-lease rejection, exactly one active lease) plus the unique-index backstop; claim against the recomputed blockers, stale-lease reap inside claim, token mismatch, heartbeat extension and past-expiry refusal, release onto `READY` and onto `BLOCKED`, bounded batches that leave non-in-flight statuses alone, trigger-forced rollbacks for claim and reaper, full replay parity including the lease lifecycle, and fail-closed appliers for every new payload shape. 33 tests in the file, 122 in the package, per-file 100% coverage.

## Alternatives considered

**Race two worker threads or processes for the concurrency test.** Rejected — `node:sqlite` is synchronous, so in-process interleaving is impossible, and a subprocess race adds scheduling nondeterminism without a new assertion: the loser's outcome is one of the two branches the lock-boundary test already pins deterministically (busy or readiness rejection).

**Reaper declares abandoned work `FAILED`.** Rejected — §13 forbids it; a failed verdict is an explicit decision through `changeWorkStatus`, and the reaper only restores the item to the open set or holds it blocked.

**Store the lease token (or its plaintext) on the event payload.** Rejected — the token is a bearer credential; hashing at rest and keeping it out of the log means a leaked timeline grants no claims, while the lease table alone authenticates holders.

**Bump `PROJECT_EVENT_FORMAT_VERSION` for the six new appliers.** Rejected — as in W05/W06, the vocabulary list already contained these types, so a v1 reader without this build failed closed on them by design; no v1 ledger written by an earlier build exists, and a bump would advertise a predecessor generation that never shipped.

## Consequences

W08 mounts the ledger into the mini profile: a driver claims with `claimWorkItem`, heartbeats on its `LeaseConfig` cadence, and schedules `reapExpiredLeases`; `work/blocked`/`work/unblocked` give plan-activation and supersede flows (W11) a projection writer to reuse; the readiness options `treatStatusAsOpen`/`ignoreLeaseId` are the documented seam for any future writer that recomputes before its own mutation lands.
