---
description: "The repository indexer: git HEAD resolution, source and document collection, syntactic symbol/call extraction, TypeChecker-resolved call graphs, and snapshot orchestration, for users and maintainers choosing, configuring, or debugging indexing."
kind: "package-reference"
---

# @deepseek-ai/dsh-project-analysis

English | [中文](README.zh.md)

## Summary

`dsh-project-analysis` turns one worktree capture into a project memory snapshot. `indexRepository` resolves the git baseline without spawning git (reading `.git` directly, including linked worktrees and packed refs), collects TypeScript sources and Markdown documents, runs a syntactic AST pass, and — by default — a TypeChecker pass that resolves call edges across files (through import aliases) and records type references. Everything commits in one transaction; a failure leaves no partial snapshot.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```ts
import { ProjectMemory } from '@deepseek-ai/dsh-project-memory'
import { indexRepository } from '@deepseek-ai/dsh-project-analysis'

const memory = await ProjectMemory.open('.mini-dsh/project-memory.sqlite')
const report = indexRepository(memory, {
  root: '.',
  slug: 'mini-dsh',
  snapshotKind: 'worktree',            // or 'head' (requires resolvable HEAD) / 'pinned' (requires commitSha)
  excludeDirNames: ['vendor'],         // merged over the built-in exclusions
  level: 'typechecker',               // or 'syntactic' for name-level edges only
})
```

`snapshotKind` chooses the baseline rule: `pinned` requires an explicit `commitSha`; `head` requires a resolvable HEAD (branch, detached, packed, or worktree) and fails loudly otherwise; `worktree` records `dirty: true` with a best-effort sha. Documents are indexed by default (`includeDocuments: false` disables) — file content, heading outline, and a `project_objects` file node.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Two extractor levels** — the syntactic pass (`syntactic.ts`) recovers declarations, imports, and call expressions from the AST without types; the semantic pass (`semantic.ts`) walks the program's own SourceFiles with the checker, unwrapping import aliases so cross-file callees land on their declaring file. `resolved` is written only when the edge also links to a stored symbol version.
- **Overload disambiguation** — declarations sharing a qualified name (overloads, declaration merging) get an occurrence ordinal (`#2`, `#3`) on their stable key so every declaration keeps its own symbol version; checker resolution of an overload set links its first declaration.
- **Deterministic walks** — files and documents are collected in path order; the same tree yields the same report.
- **Facts provenance** — signature, flag, and location facts come from the AST pass (`extraction_level = 'syntactic'`); the TypeChecker pass only resolves edges and type references.

<a id="model-experience"></a>
## Model Experience

None: indexing runs offline from any agent runtime and touches no model request. The store's context packets built over indexed snapshots are the model-facing surface, owned by `dsh-project-memory`.

#### KV Cache effect

None — no model requests originate from this package.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No vendored/dependency graphs** — the default exclusions skip `node_modules` and `vendor`; dependency calls are recorded `external`, not expanded.
- **No incremental indexing** — every run captures a full snapshot; diffing between snapshots is deferred until a consumer needs it.
- **Whole-repo checker cost** — the `typechecker` level compiles one program over all collected files (the harness repository itself needs minutes and a raised heap); callers can cap cost with `level: 'syntactic'` or narrower roots.

<a id="dev-note"></a>
## Dev Note

No runtime invariant companion is published: the indexer is a single-process library whose outputs are cross-checked by the store's own queries in tests; extractor fidelity is enforced by the package's fixtures, including the 4K context-lane specification over a synthesized repository.
