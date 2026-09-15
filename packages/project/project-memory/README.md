---
description: "The SQLite project memory store: repository snapshots, symbols, call graphs, Markdown outlines, project objects, memories with evidence, and bounded context packets, for users and maintainers choosing, configuring, or debugging the store."
kind: "package-reference"
---

# @deepseek-ai/dsh-project-memory

English | [中文](README.zh.md)

## Summary

`dsh-project-memory` is the SQLite source-of-truth store for repository intelligence. Each open owns one database stamped with a monotonic schema version (`PRAGMA user_version`; any other stamped version rejects — this is durable project data, never rebuilt silently). The v1 table set covers the content store, source reality (repositories, snapshots, files, symbols, symbol versions, imports, call sites, symbol references, `project_objects`), documents (`document_headings`), and project knowledge (memories with evidence, analysis units with history, run events). `buildContextPacket` turns a stored query into a token-budgeted retrieval; the 4K context lane is defined against it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open a store (created owner-only on first use), fill it through the `project-analysis` indexer, then query it directly:

```ts
import { ProjectMemory, buildContextPacket } from '@deepseek-ai/dsh-project-memory'

const memory = await ProjectMemory.open('.mini-dsh/project-memory.sqlite')
const report = indexRepository(memory, { root: '.', snapshotKind: 'worktree' })
const packet = buildContextPacket(memory, { kind: 'symbol', snapshotId: report.snapshotId, name: 'indexRepository' })
memory.close()
```

Snapshots are append-only: re-indexing adds a snapshot, never rewrites one. Multi-row mutations run inside `transaction()`, whose outermost call is `BEGIN IMMEDIATE` and whose nested calls become savepoints, so composed helpers join the caller's transaction.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Schema versioning** — `PROJECT_MEMORY_SCHEMA_VERSION` stamps `PRAGMA user_version` last, so an interrupted first materialization retries cleanly; every non-current version rejects. Future layout changes ship as adjacent migrations.
- **Identity** — row ids are opaque `<prefix>_<uuid>` strings branded per table in TypeScript; content ids are `sha256:<hex>` digests, so identical text dedupes to one row.
- **Call graph** — `call_sites` rows carry caller/callee symbol-version links plus a resolution (`resolved` only when the callee link exists, `external`, `unresolved`, `dynamic`) and the extractor level that produced them.
- **Context packets** — sections are added in store order until the budget is exhausted; what does not fit is reported as elided. `overflow` marks a lane violation (the header alone exceeded the budget).

<a id="model-experience"></a>
## Model Experience

None directly: the store is a library with no Cordis runtime and touches no model request. `buildContextPacket` output is designed as material for a worker's context; the consuming integration owns logging whatever it forwards to a model.

#### KV Cache effect

None — no model requests originate from this package.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No full-text search** — symbol and document lookup is exact-name; an FTS layer over snapshots is deferred until a consumer needs it.
- **Single-connection store** — one `ProjectMemory` owns one SQLite connection; multi-process coordination belongs to the ledger layer that will build on this store.
- **Sequence-free events** — `run_events` are append-only run records without a per-project sequence; the versioned project-event ledger with replay is a separate capability.

<a id="dev-note"></a>
## Dev Note

No runtime invariant companion is published: the store is a single-process library whose observations cannot diverge across independent vantage points; schema versioning, transaction semantics, and lane budgets are enforced by the package's own tests.
