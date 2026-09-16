---
description: "The Plan-as-Data project ledger seam: strict plan parsing, v1.1 schema validation, semantic checks, canonical IR compilation, and transactional immutable import, for maintainers building plan tooling on the v1.6a Ledger Core."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

English | [中文](README.zh.md)

## Summary

`dsh-experimental-project-ledger` owns the plan document seam of the v1.6a Ledger Core (docs/mini/v1.6a). A plan document is inert data: `parsePlanDocument` parses YAML with source positions and rejects duplicate keys, anchors, and aliases; `validatePlanSchema` mirrors the published constitution `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`; `validatePlanSemantics` checks references, hierarchy, and ordering relations. `compilePlan` turns a validated document into a canonical IR with deterministic branded row identities, `importPlanVersion` writes that IR as one atomic transaction, the event seam stamps, reads fail-closed, and replays the envelope, and `computeWorkReadiness` recomputes claimability from the causal rows with cycle detection guarding the ledger. Nothing here executes a verifier command or activates a plan.

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
import { changeWorkStatus, compilePlan, computeWorkReadiness, detectWorkGraphCycles, importPlanVersion, parsePlanDocument, readProjectEvents, replayProjectEvents, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

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

<a id="dev-note"></a>
## Dev Note

No runtime invariant companion is published: the import's guarantees are the database's own constraints plus one transaction, and its compile pass is pure, so there is no relationship for independent observers to diverge on; the constitution mirror and the import rules are enforced by the package's tests.

<a id="model-experience"></a>
## Model Experience

None, as the parser and importer persist plan facts and never register model-facing content; verifier commands are stored data here, never executed processes.

#### KV Cache effect

None — the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No activation or supersede yet** — importing never activates a version and rejects work items that already belong to another version or the backlog; the supersede flow owns those transitions, and incoming `SUPERSEDES` edges are excluded from readiness until it lands.
- **Generic status transitions only** — `changeWorkStatus` refuses the transitions a dedicated event owns: claiming (`work/claimed`), and the readiness projection's `work/blocked`/`work/unblocked` writes arrive with the lease lifecycle.
- **English diagnostics** — issue messages are English-only; they are compiler input, not UI copy.
