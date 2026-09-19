# Agent Note: The Doctor's Lease-Staleness Check

Status: implemented

English | [中文](2026-09-19-stale-lease-doctor.zh.md)

## Problem

`reapExpiredLeases` is caller-driven and batched, and nothing mounts it for a reader: a ledger opened cold — or read between reaper batches — can hold `work_leases` rows whose `status` still says ACTIVE although their own `expires_at_ms` has passed. The row contradicts itself, and no read surface said so: the replay audit folds the same events and projects the same ACTIVE status, so parity passes; the todo views list live leases without judging them; and the doctor pass had no clock at all. An operator reading such a ledger could not tell that recovery was owed.

## Decision

`planDoctor` gained a lease-staleness check and, with it, a third parameter: `PlanDoctorOptions { nowMs }`, defaulting to `Date.now()`, because this is the one doctor finding that reads the wall clock. The predicate is exactly `reapExpiredLeases`' own — `status = 'ACTIVE' AND expires_at_ms <= nowMs` — so a row the reaper would reap is a row the doctor reports, no more and no less. The check is project-scoped like the relation check (leases belong to the project, not to one plan version), the closed issue set gained `stale-active-lease`, and the message names the row, its expiry, and that the reaper owns its recovery. `/project doctor` needed no change: it renders the issue list generically. The doctor's full-work-loop test now releases each claim — as the shipped tools do around delivery — because its 1970-pinned claims would otherwise read as stale under the real clock, and the revoked-lease scenario pins its reading clock to stay about the revoked row.

Verification: `doctor.spec.ts` covers both sides of the expiry boundary (`expiresAtMs - 1` stays clean, at `expiresAtMs` the row is flagged) and proves a released row past its old expiry never trips the check; 247 tests across both packages, per-file 100% in one combined coverage run. The lane ran green on a temp ledger and on the persistent ledger (version 5 imported, version 4 superseded, `PW-LEASE-DOCTOR-001` DONE by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run project-ledger mini-profile` exit 0, doctor 0, `replayDrift` 0, 90 events), and idempotently on rerun; the 4K slice stayed at max 2,444/4,096 estimated tokens.

## Alternatives considered

**Reap inside the doctor pass.** Rejected — the doctor never mutates (F05); turning a read pass into a writer to hide reaper lag would break the pass's contract and race a real reaper.

**A dedicated `/project leases` view.** Rejected — a new command surface for one fact the doctor pass already owns; the generic issue rendering carries it with zero command changes.

**Mount a reaper loop in every reader as the fix.** Rejected — the gap is observing that recovery is owed, not reaper absence; write cadence belongs to the work surface and the deployment, and the lane's own mid-verifier expiry taught that lesson (the report landed on a lease the reaper owned).

## Consequences

Doctor findings are wall-clock-dependent through exactly one check, with `nowMs` keeping tests deterministic, and every other check stays clock-free. A caller reading a cold ledger can now tell whether lease recovery is owed before acting on lease facts. The lane's `doctorIssues: 0` bar is unaffected because the shipped tools release leases around delivery. The §33 count reaches 25; `PW-4K-GATE-001` stays claimable in version 5.
