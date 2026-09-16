---
description: "The Plan-as-Data project ledger seam: strict plan document parsing, v1.1 schema validation, and semantic compile checks, for maintainers building plan import, activation, or project todo tooling on the v1.6a Ledger Core."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

English | [中文](README.zh.md)

## Summary

`dsh-experimental-project-ledger` owns the plan document seam of the v1.6a Ledger Core (docs/mini/v1.6a). A plan document is inert data: `parsePlanDocument` parses YAML with source positions and rejects duplicate keys, anchors, and aliases; `validatePlanSchema` mirrors the published constitution `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json` (strict fields, controlled enums, discriminated verifier union, unsupported `schemaVersion` fails closed); `validatePlanSemantics` checks references, hierarchy, and ordering relations (`BLOCKS`/`PRECEDES`/`SUPERSEDES` must be acyclic). Parsing, validation, and semantic checks are pure: none of them ever executes a verifier command or activates a plan.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Parse bytes, validate the schema, then check semantics; every rejection is a `PlanDocumentError` carrying every independent issue with its dotted path and, where known, source position:

```ts
import { parsePlanDocument, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

const { value } = parsePlanDocument(planBytes)
const document = validatePlanSchema(value)
validatePlanSemantics(document)
```

A test pins the zod mirror to the published schema file, so editing either the constitution or the mirror without the other fails the suite.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Alias/anchor policy** — anchors and aliases are rejected outright: they are the one YAML feature that can make two document paths share one mutable object, and the ledger treats a plan document as inert data, so resolution order must never be observable.
- **Fail closed on version** — a document whose `schemaVersion` is not `1` produces one `schema-version-unsupported` issue instead of cascading through every other field.
- **Ordering relations only** — cycle detection covers `BLOCKS`, `PRECEDES`, and `SUPERSEDES`, which order work and deadlock on a loop; `RELATES_TO` and `DUPLICATES` carry no ordering. Self edges are reported once as `self-relation`.
- **Verifier kind agreement** — acceptance `kind` must equal its verifier `kind`; the fields are redundant in the constitution, and a disagreement would let a criterion be evaluated under the wrong seam.

<a id="dev-note"></a>
## Dev Note

No runtime invariant companion is published: the package is a pure library whose passes cannot diverge across independent vantage points; the constitution mirror, parser policy, and cycle rules are enforced by its own tests.

<a id="model-experience"></a>
## Model Experience

None, as the parser validates inert plan documents and registers nothing model-facing; verifier commands are stored data here, never executed processes.

#### KV Cache effect

None — the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No canonical IR yet** — `compilePlan` (v1.6a F03) and transactional import belong to the plan compiler work package; this package stops at validated documents.
- **Plan-scope identities** — work item and phase ids are plain document strings; branded ledger ids appear at the persistence seam.
- **English diagnostics** — issue messages are English-only; they are compiler input, not UI copy.
