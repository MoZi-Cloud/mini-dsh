# Agent Note: Project Ledger Doctor, Fixtures, and v1.6a Acceptance

Status: implemented

English | [中文](2026-09-18-project-ledger-doctor-and-fixtures.zh.md)

## Problem

The v1.6a BOOT acceptance pass (docs/mini/v1.6a §29/§32/§34) found two concrete gaps after W12: F05's `planDoctor` — BOOT-01 reads "golden plan import + doctor = 0 errors" — existed only as a mentioned seam, and the §2 pinned artifacts `fixtures/project-ledger/v1.6a-empty.db`/`v1.6a-populated.db` were absent. Every other BOOT and DoD item already had a verifier from W01–W12; the pass also owed §34's structured final report.

## Decision

`doctor.ts` (packages/experimental/project-ledger) implements F05 as one fail-closed read pass over an imported version: acceptance presence per item, verifier presence per criterion, hierarchy and ordering cycles through the shared `detectWorkGraphCycles`, project scoping of relations, a decodable event timeline (any decode failure becomes one `event-timeline-unreadable` issue — the doctor reports, it does not diagnose), and replay-versus-materialized parity for item, criterion, and lease statuses (BOOT-04 as a check). The report carries the version's identity, baseline pins, `PRAGMA user_version`, and row counts as facts; cycle issues carry the whole loop instead of one refId, because a cycle names several rows. Unknown versions throw at the seam.

`scripts/gen-project-ledger-fixtures.ts` regenerates both pinned databases with fixed stamps (`journalMode: 'delete'`, so no WAL side files): the empty database is the open/migration/downgrade probe, and the populated one drives the golden plan through real writers only — activation is the documented owner seam, the two BLOCKS sources and the featured item complete via claim → VERIFYING → evaluation → DONE — ending at 28 events, rows in every table, and a doctor pass with zero issues (the generator fails if the doctor objects, so a fixture can never ship drifted).

`docs/mini/v1.6a/fork-mini-DSH-v1.6a-BOOT-acceptance.zh.md` is the §34 report: versions, tables and indexes, migration fixtures, BOOT-01..08 with their verifiers, the 4K run (peak estimated request 2,308 of 4,096 tokens, overflow 0), the WorkPacket token breakdown, the plan-mode/todo boundary result, the entrypoint gate, focused regressions, and the §33 v1.6b/c/d entry state (one pinned real-use slice so far; the N-item and owner-confirmation decision is the owner's).

Verification: `tests/doctor.spec.ts` (5 tests) — the golden import doctors clean before and after activation and across a full real work loop, unknown versions fail loud, and every issue branch is exercised through raw-row seams (unacceptant items, verifier-less criteria, both cycle kinds, cross-project relations, item/criterion/lease drift, orphan leases, unreadable timelines); 186 tests in the package; per-file 100% coverage maintained; both fixtures regenerate byte-stably from the script.

## Alternatives considered

**Declare BOOT-01 satisfied by composite evidence (import diagnostics + cycle checks + parity tests).** Rejected — §29 names a doctor, and `/project doctor` (the planned command) needs a seam to project; a composite argument in a report is not a runnable verifier.

**Let the doctor re-derive expectations from the plan document.** Rejected — the ledger is the source of truth; the doctor checks the rows against the invariants import promised and the events the rows produced. Re-reading the document would create a second authority and would fail exactly when out-of-band writes matter most.

**Generate the fixtures with raw SQL.** Rejected — a populated fixture written by hand-carried inserts cannot prove replay parity; driving it through the real writers makes the generator's closing doctor pass a genuine acceptance of the fixture itself.

**Commit fixture SQL dumps instead of `.db` files.** Rejected — §2 pins the artifact paths as databases, and binary probes (open, `user_version`, downgrade-reject) exercise the real file format.

## Consequences

`/project doctor` reduces to projecting `planDoctor`'s report when the command surface lands; the fixtures give every future schema version an adjacent, regenerable baseline (bump, regenerate, commit in the same change); and the acceptance report is the durable record that v1.6a's DoD is met, leaving the §33 gate explicitly with the owner.
