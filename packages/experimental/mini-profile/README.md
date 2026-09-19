---
description: "Experimental mini profile bundle mounting the v1.6a Project Ledger capability, its /project command surface, and its project_work tools over dsh-base, with no package bin."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-experimental-mini-profile`

English | [中文](README.zh.md)

## Summary

Use this bundle when a `mini` profile needs the v1.6a Project Ledger capability mounted through the only supported launch form. It layers three inserts over `dsh-base`: the `mini-project-ledger` plugin opens the ledger through the SQLite store's fail-closed open, exposing it as `ctx.projectLedger`; the `mini-project-commands` plugin registers the read-only `/project` command (todo §11, doctor F05, item review/history, replay audit, digest/export, owner decisions/approvals/resources); the `mini-project-work` plugin registers the `project_work_*` tools claiming work and delivering the bounded WorkPacket (§16/§17). The ledger path comes from `DSH_MINI_LEDGER_PATH` with a dsh-home fallback. Nothing here adds a bin or runs a verifier.

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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-mini-profile'

declare const ctx: Context
const db = ctx.projectLedger.db
```

The attached `/project` command then answers in the profile's interactive command adapters: `/project todo [--agent] [<project-id>]` lists outstanding owner (or agent) work with recomputed readiness and live leases, `/project doctor [<plan-version-id>]` runs the read-only plan doctor on the current (or named) plan version, `/project item <stable-key-or-id> [<project-id>]` reviews one work item over the ledger's review seam — each criterion's status and latest evaluation with the observed exit code and a collapsed output-tail excerpt; `/project history <stable-key-or-id> [<project-id>]` lists that item's every recorded attempt newest-first over the ledger's history seam — verdict, evaluator, time, and the same observed excerpt per attempt; `/project replay [<project-id>]` audits the ledger over the replay seam — the project's events fold, and the rebuilt projection is compared with the materialized rows family by family and in both directions; `/project digest [<project-id>]` reads the ledger's digest seam — every plan with its versions and lifecycle stamps, every item's completion with per-criterion verdicts, and the replay verdict; `/project export [<project-id>]` renders the same record as one archival markdown block, per-criterion evidence excerpts included, paste-ready for the §33 record or a review; a bare `/project` prints usage. The command resolves the project and version through the ledger's plan directory when none is named.

Agents in the profile also get the three model-facing tools. `project_work_next` lists the agent todo view with claim readiness, blockers, and lease holders; `project_work_claim` takes the lease on one ready item and returns the bounded work packet — the objective, phase, blocking receipts, acceptance criteria, and stored verifier specs; `project_work_update` advances the held claim: `heartbeat` extends the lease, `release` gives the item back, and `report` records the agent's verifier observations — verdict plus optional exit code and bounded output tail, stored in each evaluation's observed payload — moving the item to `VERIFYING` or `FAILED` and completing it only when every required criterion already passes. The claim and heartbeat horizon is deployment config (`leaseTtlMs`, `leaseHeartbeatIntervalMs`).

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch inserts exactly three rows. The mount plugin validates `ledgerPath` (required) and `busyTimeoutMs` at load, opens the database during service init so the tree settles only once the store is migrated and stamped, and yields a disposer that closes the handle when the plugin unloads. The database version check is the store's own: a ledger newer than this build refuses the launch rather than downgrading. The commands plugin injects `commands` and `projectLedger`, registers `/project` as an effect-owned registration, and renders read-only seam results — it owns no ledger semantics and no lifecycle. The project-work plugin injects `tools` and `projectLedger`, validates its lease policy eagerly so an incompatible pair fails the load, and holds each claiming agent's bearer lease token in process memory — the token never enters a model-visible value, so nothing a session log replays can heartbeat or release a lease; a lost holder is recovered by expiry and the reaper. The report path writes evaluations only for criteria whose verifier spec stores runnable text (a command or a query the agent can run through its ordinary tools), never an `OWNER_CONFIRMATION`, and reaches `DONE` only through the ledger's own acceptance gate. Both consumer entrypoints share one project resolution module over the plan directory.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The Project Ledger row with its environment-backed path default, the `/project` command row, and the project-work tools row |
| [`src/index.ts`](src/index.ts) | The `mini-project-ledger` plugin and the `ctx.projectLedger` service |
| [`src/commands.ts`](src/commands.ts) | The `mini-project-commands` plugin registering the read-only `/project` command |
| [`src/project-work.ts`](src/project-work.ts) | The `mini-project-work` plugin registering the `project_work_next` / `claim` / `update` tools |
| [`src/project-resolution.ts`](src/project-resolution.ts) | The single-project resolution both consumer entrypoints share |
| — | No runtime invariant companion is published: the package carries a static profile patch, a lifecycle provider, and reporting surfaces; the ledger seam owns its own relationships. |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Exact composition and manifest checks |
| [`tests/service.spec.ts`](tests/service.spec.ts) | Open, serve, configure, and dispose checks |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | `/project` parsing, resolution, rendering, and lifecycle checks |
| [`tests/project-work.spec.ts`](tests/project-work.spec.ts) | Tool grammar, claim lifecycle, packet delivery, and acceptance-boundary checks |
| [`tests/plans.ts`](tests/plans.ts) | Plan documents and seeding helpers shared by the specs |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Human `/project` reporting

#### What the model sees

The slash input and the direct status/error output are absent from model requests. The command registry records each invocation as `command/run` and `command/done` on the session; the ledger rows behind the output enter no model request through this surface.

#### Token effect

None — the command reads the ledger and answers the human directly; the bundle never assembles or sends provider requests on its behalf.

#### KV Cache effect

None — the command adds no request prefix.

### Model-facing `project_work_*` tools

#### What the model sees

The three tool schemas (names, descriptions, parameter shapes) enter system-prompt assembly; every call and its canonical result log on the session through the standard tool lifecycle. `project_work_next` returns the agent todo listing; `project_work_claim` returns the lease receipt and the work-packet document — the packet is hash-pinned by the recorded `project/work-packet-prepared` recipe, so what the model saw is rebuildable from durable state alone; `project_work_update` returns the action outcome, the recorded evaluations, and the criteria still pending. The lease bearer token is never model-visible.

#### Token effect

The three schema entries are a standing system-prompt cost. Each call adds one tool result: a listing, an action receipt, or a claim result whose packet section is bounded by the serialized-packet byte ceiling the ledger enforces.

#### KV Cache effect

The schema entries extend the stable system-prompt prefix; per-turn results append as ordinary tool results behind it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **The command stays read-only; the tools mutate only through ledger writers** — `/project` lists and diagnoses; the tools claim, evaluate, and transition by calling the ledger's owning seams, and the Owner domain remains v1.6b scope.
- **Lease tokens live in the claiming process** — a restarted agent cannot heartbeat or release a pre-restart claim; expiry and the reaper own recovery, and no session-log replay carries a usable token.
- **One verdict per observable criterion** — `report` carries one `{criterionId, result, exitCode?, outputTail?}` entry for every criterion whose verifier spec stores runnable text, exactly once each; the exit code and at most the final 2048 characters of the tail land in the evaluation's observed payload, `OWNER_CONFIRMATION` and structural assertions are never written here, and `DONE` still requires every required criterion passing, so owner-gated items wait in `VERIFYING`.
- **Interactive command adapters only** — `/project` rides `ctx.commands`, which the interactive adapters consume; headless and JSON-RPC surfaces have no command plane.
- **No dedicated Web card** — the tools declare pure `presentCall` views for Host UIs; the Web Client still derives its cards from the raw events, and no keyed-slot card exists.
- **`dsh-base` carries the agent** — this bundle deliberately adds only the ledger surfaces; profile composition beyond the base is the user's patch layer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle owns lifecycle and surfaces, never ledger semantics: the mount plugin owns open order, validated configuration, and the close disposer; the commands plugin parses a closed grammar, resolves ids through the shared plan-directory resolution, and renders seam results; the project-work plugin maps the ledger seams onto three closed tool grammars, keeps the bearer-token map as ordinary plugin state keyed by worker identity, and marks agent-observable criteria by the runnable text their verifier spec stores. Tests here assert composition, handle lifecycle, the command surface, and the claim lifecycle end to end; ledger semantics stay covered by `@deepseek-ai/dsh-experimental-project-ledger`'s own suite.

</details>
