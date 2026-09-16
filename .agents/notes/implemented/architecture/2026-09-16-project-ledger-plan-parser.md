# Agent Note: Project Ledger Plan Parser

Status: implemented

English | [中文](2026-09-16-project-ledger-plan-parser.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) start at W01 "Strict plan schema and parser" (SCHEMA-001): plan documents must fail closed against the published constitution `mini-dsh-plan-v1.1.schema.json` before any persistence exists. The parser had to decide, concretely, what "strict" means for YAML — duplicate keys, anchors/aliases, unsupported versions — and how far the first work package's semantic checks go, without a database or a compiler behind them.

## Decision

One package, `packages/experimental/project-ledger`, owns the plan document seam in three pure passes — `parsePlanDocument`, `validatePlanSchema`, `validatePlanSemantics` — each collecting every independent issue into one `PlanDocumentError` with dotted paths (and source positions where the parse pass knows them), so an owner fixes a malformed plan in one round.

- **The constitution is mirrored, not re-read.** The zod schema in `plan-schema.ts` mirrors `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`; a parity test loads the published file and asserts two-way agreement on object keys, requiredness (probed via `safeParse(undefined)`), every controlled enum, and the verifier union's five kinds. Runtime never depends on `docs/`; the published file stays the single human-facing home.
- **Anchors and aliases are rejected outright.** They are the one YAML feature that can make two paths share one mutable object; a plan document is inert data, so resolution order must never be observable. Merge keys die with aliases. Duplicate keys are rejected through the YAML parser's own `DUPLICATE_KEY` errors rather than a hand walk.
- **Unsupported `schemaVersion` fails with one dedicated issue**, before schema validation cascades through every field of a document written for a different era.
- **W01 includes the reference and cycle checks** (v1.6a §26 lists them under plan parser tests): unknown `phaseId`/`parentId`/relation endpoints, duplicate ids/ordinals/relations, hierarchy cycles, and cycles in the ordering relations `BLOCKS`/`PRECEDES`/`SUPERSEDES`. `RELATES_TO` and `DUPLICATES` carry no ordering and stay outside cycle detection; a self edge is one `self-relation` issue, not also a length-one cycle.
- **Acceptance `kind` must equal its verifier `kind`.** The fields are redundant in the constitution; a mismatch would let a criterion be evaluated under the wrong seam later, so it is rejected at compile time.
- **Optional document members are declared `?: T | undefined`.** The repository compiles with `exactOptionalPropertyTypes`, and zod's output model is "possibly undefined"; the interchange interfaces carry the honest type instead of casting the mirror.

Verification: 26 package tests covering the v1.6a §26 parser matrix, byte/string/BOM input parity, folded-scalar determinism, and an end-to-end run of the repository's own golden plan (`fork-mini-DSH-v1.6a.plan.yaml`, 13 phases / 15 work items / 14 relations) through all three passes.

## Alternatives considered

**Validate against the JSON Schema file at runtime (ajv).** Rejected for now — the repository has no ajv dependency anywhere, the schema is small and closed, and a mirrored zod schema plus a parity test keeps one dependency fewer while still failing when either side drifts. If the constitution grows or versions multiply, revisit ajv.

**Allow anchors/aliases and clone resolved values.** Rejected — cloning hides the sharing instead of removing it and makes document equality depend on a policy choice; outright rejection is deterministic and simpler to explain in diagnostics.

**Defer semantic checks to W03's `compilePlan`.** Rejected — §26 assigns them to the parser work package, they need no database, and W03's compiler can then assume reference-clean documents instead of re-validating.

## Consequences

The plan compiler (W03 `compilePlan`/`importPlanVersion`) starts from a validated document and can bind stable keys, brand ids, and write the ledger without re-checking references or cycles. Two seams are deliberately still open: canonical IR generation, and any command execution — the parser never touches verifier commands, which stays true for the whole ledger (import ≠ activate ≠ execute).
