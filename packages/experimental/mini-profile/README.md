---
description: "Experimental mini profile bundle mounting the v1.6a Project Ledger capability and its /project command surface over dsh-base, with no package bin."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-experimental-mini-profile`

English | [中文](README.zh.md)

## Summary

Use this bundle when a `mini` profile needs the v1.6a Project Ledger capability mounted through the only supported launch form. It layers two inserts over `dsh-base`: the `mini-project-ledger` plugin opens the ledger through the SQLite store's fail-closed open, exposes it as `ctx.projectLedger`, closes it on unload; the `mini-project-commands` plugin registers the read-only `/project` command (Owner/Agent todo views §11, plan doctor F05). The ledger path comes from `DSH_MINI_LEDGER_PATH` with a dsh-home fallback. Nothing here adds a bin, executes a verifier command, or mutates ledger state. The bundle lives in the experimental group, so isolation keeps it out of default compositions.

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

The attached `/project` command then answers in the profile's interactive command adapters: `/project todo [--agent] [<project-id>]` lists outstanding owner (or agent) work with recomputed readiness and live leases, `/project doctor [<plan-version-id>]` runs the read-only plan doctor on the current (or named) plan version, and a bare `/project` prints usage. The command resolves the project and version through the ledger's plan directory when none is named.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch inserts exactly two rows. The mount plugin validates `ledgerPath` (required) and `busyTimeoutMs` at load, opens the database during service init so the tree settles only once the store is migrated and stamped, and yields a disposer that closes the handle when the plugin unloads. The database version check is the store's own: a ledger newer than this build refuses the launch rather than downgrading. The commands plugin injects `commands` and `projectLedger`, registers `/project` as an effect-owned registration, and renders read-only seam results — it owns no ledger semantics and no lifecycle.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The Project Ledger row with its environment-backed path default, and the `/project` command row |
| [`src/index.ts`](src/index.ts) | The `mini-project-ledger` plugin and the `ctx.projectLedger` service |
| [`src/commands.ts`](src/commands.ts) | The `mini-project-commands` plugin registering the read-only `/project` command |
| — | No runtime invariant companion is published: the package carries a static profile patch, a lifecycle provider, and a reporting command; the ledger seam owns its own relationships. |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Exact composition and manifest checks |
| [`tests/service.spec.ts`](tests/service.spec.ts) | Open, serve, configure, and dispose checks |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | `/project` parsing, resolution, rendering, and lifecycle checks |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Human `/project` reporting

#### What the model sees

The slash input and the direct status/error output are absent from model requests. The command registry records each invocation as `command/run` and `command/done` on the session; the ledger rows behind the output enter no model request through this surface. The bundle registers no prompt text and no tool.

#### Token effect

None — the command reads the ledger and answers the human directly; the bundle never assembles or sends provider requests.

#### KV Cache effect

None — the command adds no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **Read-only by construction** — `/project` lists and diagnoses; claiming, evaluating, superseding, recording drift, and every other mutating flow stay with their owning writers, and the Owner domain remains v1.6b scope.
- **Interactive command adapters only** — `/project` rides `ctx.commands`, which the interactive adapters consume; headless and JSON-RPC surfaces have no command plane.
- **No model-facing project tool yet** — the model-facing project-work tool and WorkPacket delivery remain later consumers of the same mounted handle.
- **`dsh-base` carries the agent** — this bundle deliberately adds only the ledger surface; profile composition beyond the base is the user's patch layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle owns lifecycle and reporting, never ledger semantics: the mount plugin owns open order, validated configuration, and the close disposer; the commands plugin parses a closed grammar, resolves ids through the plan directory, and renders seam results. Tests here assert composition, handle lifecycle, and the command surface; ledger semantics stay covered by `@deepseek-ai/dsh-experimental-project-ledger`'s own suite.

</details>
