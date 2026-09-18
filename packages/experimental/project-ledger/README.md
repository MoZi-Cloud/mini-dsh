---
description: "The Plan-as-Data project ledger seam: strict plan parsing, v1.1 schema validation, semantic checks, canonical IR compilation, and transactional immutable import, for maintainers building plan tooling on the v1.6a Ledger Core."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

English | [中文](README.zh.md)

## Summary

`dsh-experimental-project-ledger` owns the plan document seam of the v1.6a Ledger Core (docs/mini/v1.6a). A plan document is inert data: `parsePlanDocument` parses YAML and rejects duplicate keys, anchors, and aliases; `validatePlanSchema` mirrors the constitution schema; `validatePlanSemantics` checks references, hierarchy, and ordering relations. `compilePlan` builds a canonical IR, `importPlanVersion` writes it atomically, the event seam stamps and replays fail-closed, `computeWorkReadiness` recomputes claimability, `evaluateAcceptanceCriterion` appends caller-reported outcomes, the lease seam arbitrates one active lease per item, and `buildWorkPacket` prepares the bounded deterministic packet the event log can rebuild without the plan document. Nothing here executes a verifier command or activates a plan.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Parse bytes, validate the schema, check semantics, compile, then import; every rejection is a `PlanDocumentError` (or `PlanImportError`) carrying every independent issue with its dotted path:

```ts
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import { buildWorkPacket, changeWorkStatus, claimWorkItem, compilePlan, computeWorkReadiness, detectWorkGraphCycles, evaluateAcceptanceCriterion, heartbeatWorkLease, importPlanVersion, parsePlanDocument, readProjectEvents, rebuildWorkPacket, releaseWorkLease, replayProjectEvents, serializeWorkPacket, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

const { text, value } = parsePlanDocument(planBytes)
const document = validatePlanSchema(value)
validatePlanSemantics(document)
const compiled = compilePlan(document, { sourceText: text })
const db = await openProjectLedgerDatabase(ledgerPath)
const result = importPlanVersion(db, compiled, { sourcePath: planPath })
const timeline = readProjectEvents(db, compiled.projectId)
const projection = replayProjectEvents(db, compiled.projectId)
const readiness = computeWorkReadiness(db, compiled.workItems[0].id)
const cycles = detectWorkGraphCycles(db, compiled.projectId)
const evaluation = evaluateAcceptanceCriterion(db, compiled.workItems[0].acceptance[0].id, 'PASS')
const claim = claimWorkItem(db, compiled.workItems[0].id, 'worker/session-7')
const lease = heartbeatWorkLease(db, claim.leaseId, claim.leaseToken)
releaseWorkLease(db, claim.leaseId, claim.leaseToken)
const packet = buildWorkPacket(db, compiled.workItems[0].id)
const packetText = serializeWorkPacket(packet)
const rebuild = rebuildWorkPacket(db, packet.packetId)
```

A test pins the zod mirror to the published schema file, so editing either the constitution or the mirror without the other fails the suite.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Alias/anchor policy** — anchors and aliases are rejected outright: they are the one YAML feature that can make two document paths share one mutable object, and the ledger treats a plan document as inert data, so resolution order must never be observable.
- **Fail closed on version** — a document whose `schemaVersion` is not `1` produces one `schema-version-unsupported` issue instead of cascading through every other field.
- **Deterministic identities** — row ids derive from ledger-stable keys (`wi:<project>:<work id>`, `plv:<plan>:v<n>`), so the same source bytes compile to the same primary keys in every ledger database, and the canonical IR hash is the SHA-256 of the sorted-key JSON of the emitted rows.
- **Idempotent by hash** — re-presenting the same source text returns the recorded version and writes nothing; a version number reused with different source content throws `version-conflict`, and a version re-declaring work items recorded under another version throws `work-item-conflict`.
- **Atomic with events** — one `BEGIN IMMEDIATE` transaction writes the version rows and appends the `plan/imported` and `work/created` events; any failure rolls back to a ledger without partial rows. Import never activates: versions land as `DRAFT` and `plans.current_version_id` stays untouched.
- **Fail-closed event reads** — the v1 vocabulary is required: a reader that meets an unknown required event type or a foreign `event_format_version` refuses the whole timeline, while unknown ignorable rows (observational extensions from newer writers) are preserved and change no replay state. Required vocabulary entries refuse to be recorded as ignorable.
- **Readiness is recomputed, never trusted** — `computeWorkReadiness` derives claimability from the causal rows (plan version, phase, `BLOCKS`/`PRECEDES` edges, external blockers, required criteria, live leases, and the item's own status); the materialized `READY`/`BLOCKED` status is only a projection of those inputs, and hierarchy never enters the decision (`parent_work_item_id` is composition, not dependency).
- **One cycle semantics** — compile-time validation and the ledger-side `detectWorkGraphCycles` share the ordering-relation kinds and the cycle walks in `relation-graph.ts`, so a document and the rows it produced always get the same verdict on cycles.
- **Evaluations are history; status is the projection** — `evaluateAcceptanceCriterion` appends the caller-reported outcome to `acceptance_evaluations` and moves the criterion's status with its `acceptance/evaluated` event in one transaction. `ERROR` records history without moving the projection. Results are caller-reported: the package stores `command_text` and never runs it.
- **Acceptance is the only completion authority** — `changeWorkStatus` reaches `DONE` only from `VERIFYING`, and only while every required criterion is `PASSING` or `WAIVED`; a session todo, a plan-mode edit, or any caller outside the ledger cannot shortcut project work to done.
- **One active lease per item** — `claimWorkItem` holds one `BEGIN IMMEDIATE` transaction across the readiness recompute, the stale-lease reap, and the lease insert (§13), so a competing claimer serializes behind it and is rejected by the live-lease blocker; the `uq_one_active_lease_per_work` partial unique index is the final arbiter. Heartbeats and releases must arrive before expiry, and the reaper recomputes an abandoned item's `READY`/`BLOCKED` projection without ever declaring it `FAILED`.
- **Tokens are hashed, never logged** — a claim returns a one-time bearer token; only its SHA-256 hash is stored, and no lease event carries it, so the log rebuilds lease state without replaying secrets.
- **Packets are recipes, not rows** — `buildWorkPacket` reads only the per-item inputs §17 lists (plan identity, objective, phase summary, relation receipts, criteria with stored specs, baseline), hashes every referenced section, and appends `project/work-packet-prepared` carrying the whole recipe; no materialized packet table exists, because the event is the durable record and a packet is rebuildable. `rebuildWorkPacket` recomposes the packet from current rows alone and names the references that drifted, so auditing what a model saw never requires the Master Plan text.
- **Bounded by refusal** — `serializeWorkPacket` output must stay under `maxSerializedBytes` (default 65,536); an oversized packet throws instead of truncating, so the model-visible document is always whole or absent, and identical rows always serialize to identical bytes.

<a id="dev-note"></a>
## Dev Note

No runtime invariant companion is published: the import's guarantees are the database's own constraints plus one transaction, and its compile pass is pure, so there is no relationship for independent observers to diverge on; the constitution mirror and the import rules are enforced by the package's tests.

<a id="model-experience"></a>
## Model Experience

### One bounded WorkPacket per prepared task

#### What the model sees

`serializeWorkPacket` emits one canonical JSON document: packet and builder versions, the ordered reference list with content hashes, the work item objective, the parent phase summary, blocking-relation receipts with their source statuses, acceptance criteria with stored verification specs, and the baseline snapshot. Nothing from other work items, other phases, or the plan document appears, and the package itself registers no prompt or tool.

#### Token effect

One prepared task contributes one bounded block of per-item facts; verification specs arrive as stored text, never executed output. Re-preparing unchanged rows emits identical bytes and no new content.

#### KV Cache effect

Deterministic for identical rows: the same ledger state serializes with identical key order and identical reference order, so a re-prepared unchanged item repeats the model-visible prefix exactly.

## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No activation or supersede yet** — importing never activates a version and rejects work items that already belong to another version or the backlog; the supersede flow owns those transitions, and incoming `SUPERSEDES` edges are excluded from readiness until it lands.
- **No project memory refs in packets yet** — §17 admits explicitly associated memory references once a durable memory capability exists; v1 packets record none, so the rebuild reads ledger rows only.
- **`REVOKED` is a reserved row status** — the lease lifecycle writes `ACTIVE`, `RELEASED`, and `EXPIRED`; owner-side revocation has no writer yet, and the reaper loop's cadence (`reaperIntervalMs`) belongs to the caller of the bounded `reapExpiredLeases` batch.
- **English diagnostics** — issue messages are English-only; they are compiler input, not UI copy.
