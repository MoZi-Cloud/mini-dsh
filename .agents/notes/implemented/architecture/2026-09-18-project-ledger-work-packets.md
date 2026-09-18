# Agent Note: Project Ledger Work Packets

Status: implemented

English | [中文](2026-09-18-project-ledger-work-packets.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) continue at W09 (PACKET-001, BOOT-02): a fresh agent must get one ready task through a bounded, deterministic WorkPacket and the model-visible packet must be auditable from durable state — the rebuilt packet hash equals the final request packet hash, without the Master Plan transcript (§16/§17, AC-PACKET-001). The ledger had no packet seam: nothing bounded what a model saw per task, and nothing recorded a recipe that could re-derive it.

## Decision

`work-packet.ts` (packages/experimental/project-ledger) owns the seam. `buildWorkPacket` runs inside one `BEGIN IMMEDIATE` transaction, reads only the per-item inputs §17 lists — plan/version identity, work item objective, parent phase summary, blocking-relation receipts with source statuses, acceptance criteria with stored verification specs, the version's baseline snapshot — composes ordered references `{kind, refId, contentHash}` (each content hash covers exactly the document section the reference pins), hashes the recipe (identity fields plus ordered references) into `packetHash`, enforces a serialized byte ceiling, and appends the required `project/work-packet-prepared` event carrying the whole recipe. The packet id derives from the event's sequence, symmetric with lease ids.

- **The event is the recipe; no materialized packet table.** A packet is rebuildable, not source-of-truth, so storing rows for it would make the ledger a derived index of itself. Replay folds the recipe into `workPackets` (keyed by packet id, validating the named work item and refusing duplicate ids), and `rebuildWorkPacket` recomposes the packet from current rows alone — its only inputs are the database and the packet id — reporting `matchesRecordedHash` and the drifted reference ids when a pinned row moved. The acceptance test rebuilds on a second connection to a file-backed ledger, proving the plan document is never an input.
- **Bounded means refusal, not truncation.** `serializeWorkPacket` output must stay under `maxSerializedBytes` (default 65,536) or the build throws; an unplanned (version-less) item fails loud with `work-item-unplanned` because the v1 packet reads only rows a plan version owns. The rebuild path skips the ceiling: rows that grew since preparation are drift evidence, not an obstruction.
- **The reference-kind vocabulary lives in the event codec.** `WORK_PACKET_REFERENCE_KINDS` is owned by `project-events.ts` (like `ACCEPTANCE_CRITERION_STATUSES`) so payload validation needs no runtime import from the packet module, keeping the packet→events import direction one-way.
- **No memory references in v1.** §17 admits explicitly associated project memory refs "if the capability exists"; nothing durable backs them in this build, and recipe references must be rows the rebuild can re-read, so the builder records none and the README records the deferral.

Verification: `packages/experimental/project-ledger/tests/work-packet.spec.ts` (14 tests) for AC-PACKET-001, including the file-backed reopen rebuild, determinism, drift naming, byte-ceiling rollback, replay rejections, and an ad hoc item with no phase/receipts/criteria; 170 tests across the three experimental packages; per-file 100% coverage maintained.

## Alternatives considered

**Materialize `work_packets` tables (schema v2 migration).** Rejected — the recipe already carries identity, ordered reference ids, ordered content hashes, and the packet hash; a table would duplicate the event and make the ledger index itself. Replay gains a map, parity is the rebuild test, and the schema stays at version 1.

**Hash the full serialized document instead of the recipe.** Rejected — §16 fixes the event's recorded fields (reference ids and content hashes), and per-reference content hashes already pin every section transitively; hashing the document would couple the packet hash to section formatting the recipe does not name.

**Accept optional memory refs from build options.** Rejected — the rebuild reads durable rows only, so recipe references must be re-readable from the database; an options-supplied ref would break the §16 reconstruction proof the moment it was used. The seam waits for a durable memory capability.

**Gate `buildWorkPacket` on readiness.** Rejected — §17's read list does not include readiness and the claim seam (W07) owns it; preparing context for a not-yet-ready item is harmless observation, while duplicating the readiness gate would give two authorities for one decision.

## Consequences

The request side (BOOT-02's fresh agent, a future mini-profile consumer) sends `serializeWorkPacket(packet)` and audits with `packet.packetHash`; a session log can later record the packet hash at request time and prove equality against `rebuildWorkPacket` on any later database. Every §16 field is now recorded for each preparation, so adding the request-audit linkage is a consumer-side change with no ledger migration. When W11 lands supersede/drift handling, `driftedReferenceIds` gives it the exact per-reference evidence.
