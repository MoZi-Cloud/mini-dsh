# Agent Note: Project Ledger Versioned Events and Replay

Status: implemented

English | [中文](2026-09-16-project-ledger-project-events.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W04 "Project event format/projection" (EVENT-001): unknown required events must fail, unknown ignorable events must preserve replay, and replay must equal the materialized projection. W03 left the event write as an import-private insert with `PROJECT_EVENT_FORMAT_VERSION` duplicated between the core and SQLite packages, and nothing enforced the attachment's §11 read semantics.

## Decision

The event envelope, vocabulary, and codec live in one home, `packages/experimental/project-ledger` (`project-events.ts`); the SQLite package no longer exports a format constant, because the store owns the physical layout while the core owns event semantics. Writers keep taking a bare `DatabaseSync`, so the dependency direction stays one-way.

- **The append seam validates vocabulary and ignorable together.** `appendProjectEvent` accepts the §16 v1 types and unregistered names, but a required entry refuses `ignorable: true` (projection-affecting semantics must not hide in rows replay skips) and an unregistered name requires it — that pair is exactly the §16 forward-compat mechanism, made explicit at the write instead of trusted by convention.
- **Reads fail closed on what the codec cannot interpret.** An unknown event type recorded as required, a foreign `event_format_version`, and unparseable payloads each reject the whole timeline (`readProjectEvents` never returns a partially interpreted list); unknown ignorable rows are preserved in the timeline and change no state. Observational extensions must not bump the format version (§16), so any version mismatch means a required codec evolution this build cannot reason about.
- **Replay is a per-build fold with parity tests.** `replayProjectEvents` applies the types that have a projection effect in this build (`plan/imported`, `work/created`); vocabulary types without an effect yet and ignorable foreign rows fall through a documented no-op. Each future writer adds its payload decoder and applier in the same PR, and the events suite compares the fold against rows read straight from the materialized tables — the BOOT-04 pattern, extended incrementally.
- **The import now appends through the seam**, so sequence allocation, envelope stamping, and vocabulary validation have exactly one implementation; the W03 parity-pin test became obsolete and was removed with the constant it pinned.

Verification: `packages/experimental/project-ledger/tests/events.spec.ts` — golden-import appends, per-project sequence isolation, both append rejections, timeline reads with decoded payloads, fail-closed reads for unknown required events, foreign format versions, and unparseable payloads, ignorable preservation, and replay equality against the materialized `plan_versions`/`work_items` rows plus payload-shape rejection per field. The import suite stays green unchanged apart from the removed pin test.

## Alternatives considered

**Keep the constant in the SQLite package and import it into the core.** Rejected — it inverts the seam W03 established: the core would take a runtime dependency on the physical store, and every later writer (W05–W07, W11) would do the same.

**Per-type payload parameters on `appendProjectEvent`.** Rejected for now — twelve of the fourteen v1 types have no writer yet, so their payload types would be invented empty shells; the seam takes a JSON object until the payload-bearing writers land and types their drafts at the same time.

**Tolerate older format versions on read.** Rejected — v1 is the first format, and tolerating a mismatch would turn a corrupted or foreign row into a silently degraded timeline instead of a loud one.

## Consequences

W05 (readiness), W06 (acceptance), W07 (leases), and W11 (supersede) each extend `PROJECT_EVENT_TYPES` only when they also land their payload decoder, replay applier, and a replay-parity assertion — the vocabulary registry, the codec, and the parity harness in this package are their extension points.
