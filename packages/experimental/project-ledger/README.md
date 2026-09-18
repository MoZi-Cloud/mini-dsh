---
description: "The Plan-as-Data project ledger seam: strict plan parsing, v1.1 schema validation, semantic checks, canonical IR compilation, and transactional immutable import, for maintainers building plan tooling on the v1.6a Ledger Core."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

English | [中文](README.zh.md)

## Summary

`dsh-experimental-project-ledger` owns the plan document seam of the v1.6a Ledger Core. A plan document is inert data: `parsePlanDocument` parses YAML and rejects duplicate keys, anchors, and aliases; `validatePlanSchema` mirrors the constitution schema; `validatePlanSemantics` checks references, hierarchy, and relations. `compilePlan` builds a canonical IR, `importPlanVersion` writes it atomically, the event seam replays fail-closed, `computeWorkReadiness` recomputes claimability, the lease seam arbitrates one lease per item, `buildWorkPacket` prepares bounded packets, the todo views split work by executor kind, supersede and drift retire versions and block moved baselines; `listPlans`, `readWorkItemReview`, and `readProjectReplay` read plans, reviews, and replay parity. Nothing here executes a verifier command.

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
import { buildWorkPacket, changeWorkStatus, claimWorkItem, compilePlan, computeWorkReadiness, detectWorkGraphCycles, evaluateAcceptanceCriterion, heartbeatWorkLease, importPlanVersion, listAgentTodo, listOwnerTodo, parsePlanDocument, readProjectEvents, rebuildWorkPacket, releaseWorkLease, replayProjectEvents, serializeWorkPacket, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

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
const ownerTodo = listOwnerTodo(db, compiled.projectId)
const agentTodo = listAgentTodo(db, compiled.projectId)
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
- **Owner and Agent todos are executor-separated views** — `listOwnerTodo` and `listAgentTodo` run one read-only query over `executor_kind` (§11) across the non-terminal statuses, ordered by kind, descending priority, age, and id; every entry carries the recomputed readiness and the live lease, so blocking causes and holders surface with the task. Views never mutate: completion stays with the acceptance seam, and a session todo — no stable item ids, no project identity — has no path into the ledger.
- **Supersede retires versions, never history** — `supersedePlanVersion` moves only the lifecycle columns (`SUPERSEDED`, `superseded_at_ms`) and the `plans.current_version_id` pointer inside one `BEGIN IMMEDIATE` with its `plan/version-superseded` event; readiness then denies every new claim on the version (`plan-version-not-active`), live attempts keep their leases and land `BLOCKED` once they give them up, and the event payload records the review queue. Work items, plan facts, and evaluations stay byte-identical.
- **Drift blocks claims, never rewrites the pin** — `recordBaselineDrift` compares a caller's observed repository facts with the version's pinned baseline, appends `baseline/drift-detected`, and opens a `BASELINE_DRIFT` external blocker on the work item, so the next claim is denied until the owner resolves, waives, or supersedes; the baseline columns themselves never move (§21).
- **The doctor is a read-only sweep** — `planDoctor` re-verifies an imported version in one pass: acceptance and verifier presence, hierarchy and ordering cycles, project-scoped relations, a decodable event timeline, and replay-versus-materialized parity for item, criterion, and lease statuses; every independent issue is reported together with the version's identity, baseline, and row counts.
- **Plans resolve through one directory** — `listPlans` reads every `plans` row with its `current_version_id` pointer, ordered by project then plan id; a consumer that must answer "which project" or "which version is current" derives it from this listing instead of re-owning `plans`-table semantics. The directory only reads: rows appear with import and the pointer moves with supersede.
- **Item reviews read one joined answer** — `readWorkItemReview` resolves one work item by full id or stable key and returns each acceptance criterion with its projection status and latest evaluation (verdict, evaluator, timestamp, parsed observed payload); the latest row per criterion is picked by evaluation time with the append-only write order breaking same-millisecond ties. The review only reads: evaluations and statuses are owned by their writers.
- **Replay audits compare both directions** — `readProjectReplay` folds a project's event timeline and compares the rebuilt projection with the materialized tables, family by family — plan versions by identity facts, items, criteria, and leases by status — so a row nothing replays and a replay nothing materializes are both drift. Work packets count on the replayed side only (the recipe is the durable record); a timeline this build cannot decode reports why instead of half-comparing. The audit only reads: parity is a fact, not a repair.

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
- **Todo views are queries only** — the `/project todo --owner`/`--agent` slash surface and the `project_work_*` tools belong to the command seam; v1.6b extends executor identity into actor/role/assignment (§11).
- **No carry-forward binding yet** — the successor a supersede names is recorded, not applied: re-declaring inherited work items belongs to the adoption flow (§9.3), and resolving or waiving drift blockers has no writer yet.
- **`REVOKED` is a reserved row status** — the lease lifecycle writes `ACTIVE`, `RELEASED`, and `EXPIRED`; owner-side revocation has no writer yet, and the reaper loop's cadence (`reaperIntervalMs`) belongs to the caller of the bounded `reapExpiredLeases` batch.
- **English diagnostics** — issue messages are English-only; they are compiler input, not UI copy.
