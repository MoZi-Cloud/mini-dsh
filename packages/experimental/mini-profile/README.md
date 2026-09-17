---
description: "Experimental mini profile bundle mounting the v1.6a Project Ledger capability over dsh-base, with no package bin."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-experimental-mini-profile`

English | [中文](README.zh.md)

## Summary

Use this bundle when a `mini` profile needs the v1.6a Project Ledger capability mounted through the only supported launch form. It layers one insert over `dsh-base`: the `mini-project-ledger` plugin opens the ledger database through the SQLite store's fail-closed open, exposes it as `ctx.projectLedger`, and closes it on unload. The ledger path comes from `DSH_MINI_LEDGER_PATH` with a dsh-home fallback. Nothing here adds a bin, executes a verifier command, or activates a plan. The bundle lives in the experimental group, so no shipped `mini` template exists — isolation keeps experimental capability out of default compositions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Create the profile, then attach the bundle as a persistent dependency:

```sh
dsh --profile mini
dsh plugin --profile mini add @deepseek-ai/dsh-experimental-mini-profile
```

Set `DSH_MINI_LEDGER_PATH` to an absolute file path before launch to place the ledger outside the Harness home; the directory and file are created owner-only on first use. Any plugin or command in the profile reads the same opened handle:

```ts
declare const ctx: Context
const db = ctx.projectLedger.db
```

Call the `@deepseek-ai/dsh-experimental-project-ledger` seam functions against that handle — the service owns identity, open order, and lifecycle, never ledger semantics.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch inserts exactly one row. The plugin validates `ledgerPath` (required) and `busyTimeoutMs` at load, opens the database during service init so the tree settles only once the store is migrated and stamped, and yields a disposer that closes the handle when the plugin unloads. The database version check is the store's own: a ledger newer than this build refuses the launch rather than downgrading.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The single Project Ledger row and its environment-backed path default |
| [`src/index.ts`](src/index.ts) | The `mini-project-ledger` plugin and the `ctx.projectLedger` service |
| — | No runtime invariant companion is published: the package carries only a static profile patch and a lifecycle provider, and the ledger seam owns its own relationships. |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Exact composition and manifest checks |
| [`tests/service.spec.ts`](tests/service.spec.ts) | Open, serve, configure, and dispose checks |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### No model-facing surface

#### What the model sees

Nothing from this bundle. The mounted row adds no prompt text, tools, or request surface; `ctx.projectLedger` only exposes a database handle whose semantics live in `@deepseek-ai/dsh-experimental-project-ledger`.

#### Token effect

None — the bundle never assembles or sends provider requests.

#### KV Cache effect

None — the bundle adds no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **No ledger commands or tools yet** — the mount exposes the capability to later consumers (`/project` commands, the model-facing project-work tool, the WorkPacket builder); nothing model-facing rides on this bundle yet.
- **`dsh-base` carries the agent** — this bundle deliberately adds only the ledger; profile composition beyond the base is the user's patch layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle owns lifecycle only: open order, validated configuration, and the close disposer. Ledger semantics stay in `@deepseek-ai/dsh-experimental-project-ledger`, so tests here assert composition and handle lifecycle, never ledger behavior.

</details>
