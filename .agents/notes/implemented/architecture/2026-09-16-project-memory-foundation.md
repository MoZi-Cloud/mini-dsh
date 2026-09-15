# Agent Note: Project Memory Foundation

Status: implemented

English | [中文](2026-09-16-project-memory-foundation.zh.md)

## Problem

The mini-DSH plan tiering (docs/mini) needs a repository-intelligence foundation before any project ledger can bind plan targets to code: a durable record of what a repository contains (symbols, call graphs, documents) and a bounded way to retrieve it. Upstream has no such store — SQLite appears only as a KV backend and a rebuildable FTS index — and no symbol or call-site extractor exists anywhere in the tree.

## Decision

Two library packages under a new `packages/project/` group, introduced as the reviewed v1.6a vertical slice's storage foundation:

- `dsh-project-memory` — a SQLite source-of-truth store (not a rebuildable cache): monotonic `PRAGMA user_version` with reject-on-mismatch, `foreign_keys=ON`, validated journal modes, owner-only file creation, and a v1 table set covering the content store, source reality (repositories, snapshots, files, symbols, symbol versions, imports, call sites, symbol references, `project_objects`), Markdown outlines (`document_headings`), and project knowledge (memories + evidence, analysis units + history, run events). Nested `transaction()` calls become savepoints so composed helpers join the caller's transaction.
- `dsh-project-analysis` — the indexer: filesystem-only git HEAD resolution (loose refs, packed refs, linked worktrees, commondir), deterministic file/document walks, a syntactic AST pass, and a TypeChecker pass that walks the program's own SourceFiles and unwraps import aliases so cross-file call edges land on their declaring file. `resolved` is written only when an edge links to a stored symbol version; overload sets get occurrence-ordinal stable keys. One run commits one append-only snapshot in a single transaction.

The 4K context lane is defined here: any bounded retrieval feeding a worker context fits a reviewed 4,096-token budget (deterministic UTF-8-bytes÷4 estimator; elided sections reported, never silently included). The gate is the package-local `context-lane-4k` specification over a synthesized repository — the benchmark tree's own rules keep semantic assertions out of `test:bench`.

No Cordis service seam is published yet: both packages are single-implementation libraries with no second provider or runtime consumer, so a seam would exist for its own sake. The ledger tier adds the Service Definition when its consumers (profile commands, work tools, packet builder) arrive. No `./invariant` companions: nothing here can diverge across independent vantage points.

## Alternatives considered

**Put the store behind a `ctx.service` now.** Deferred — a seam with one implementation and no consumer role violates the current-owner rule; the ledger tier will define the seam against real consumers.

**Store sessions or logs in this database.** Rejected — session logs stay in the session-persistence plane; this store records repository facts, memories, and run markers only.

**Resolve call edges by name only (syntactic level as default).** Rejected as default — name-level edges misresolve under overloads and cross-file shadowing; the TypeChecker pass is the default and the syntactic level remains an explicit cheaper mode.

**A wall-clock benchmark entry in `benchmarks/` for the lane.** Rejected — that tree's contract forbids turning benchmark completion into semantic assertions; a deterministic budget gate belongs in package tests.

## Consequences

Indexing the harness repository itself (minus vendor/native/website/python/snapshots/benchmarks) takes about two minutes at the `typechecker` level with a raised heap: 6,805 files (3,216 Markdown documents, 33,235 headings), 28,725 symbol versions, 384,549 call sites (65,445 resolved, 224,777 external, 91,583 unresolved, 2,744 dynamic), and 35,871 project objects, committed as one worktree snapshot pinned to the current HEAD. Dependencies excluded from the walk are recorded `external`, never expanded.

Verification: 50 package tests (store lifecycle, version rejection, content dedupe, call-graph queries, transaction savepoints, packet budgets and elision, HEAD resolution variants, extractor fixtures, overload disambiguation, document structuring) plus the lane specification asserting zero overflowing packets over the synthesized workload. Coverage of the two packages is enforced by the repository coverage gate.
