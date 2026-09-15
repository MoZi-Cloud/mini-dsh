---
description: "Package map for the project group: the SQLite project memory store and the repository indexer that fills it, for users and maintainers navigating the group."
kind: "package-group"
---

# project/ — project memory and repository analysis

English | [中文](README.zh.md)

## Summary

The `project/` group owns the repository-intelligence foundation: a SQLite project memory store (`project-memory`) and the indexer that fills it (`project-analysis`). One indexing run captures an append-only snapshot of a worktree — TypeScript symbols and call graphs, Markdown documents and their heading outlines, the observed `project_objects` tree — plus durable memories with source evidence, analysis units, and run events. Bounded context packets built over a snapshot are the retrieval primitive; the 4K context lane is defined and enforced against them. Later project-ledger capabilities (plan import, work items, leases) build on this store.

## Table of Contents

- [Packages](#packages)
- [The 4K context lane](#the-4k-context-lane)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`project-memory`](project-memory/README.md) | SQLite source-of-truth store: schema, content store, snapshots, symbols, call graph, project objects, memories, analysis units, context packets |
| [`project-analysis`](project-analysis/README.md) | Worktree indexer: git HEAD resolution, file/document collection, syntactic and TypeChecker extraction, snapshot orchestration |

<a id="the-4k-context-lane"></a>
## The 4K context lane

The lane is the reviewed contract that any single bounded retrieval feeding a worker context fits `CONTEXT_LANE_TOKEN_BUDGET` (4,096) estimated tokens, with what did not fit reported as elided sections instead of silently included. The estimate is deterministic (UTF-8 bytes ÷ 4, rounded up — conservative for source text), the budget is a source constant no environment variable can widen, and the gate is the package-local `context-lane-4k` specification over a synthesized repository; the repository benchmark tree does not host it because its rules keep semantic assertions out of `test:bench`. Widening the lane to 8K is a reviewed decision, not a configuration change.

<a id="related-documentation"></a>
## Related documentation

- `docs/mini/评审建议.md` — the design review that scoped this foundation and the ledger tiering built on it

<a id="dev-note"></a>
## Dev Note

No runtime invariants are published from this group: the store and the indexer are single-process library roles whose observations cannot diverge across independent vantage points; schema versioning, the snapshot transaction boundary, and the lane specification are enforced by the packages' own tests. Rationale for the tiered introduction lives in the [project memory foundation Agent Note](../../.agents/notes/implemented/architecture/2026-09-16-project-memory-foundation.md).
