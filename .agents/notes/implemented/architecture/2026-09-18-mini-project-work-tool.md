# Agent Note: The mini Profile's Model-Facing Project-Work Tools

Status: implemented

English | [中文](2026-09-18-mini-project-work-tool.zh.md)

## Problem

v1.6a's BOOT-02 flow — a fresh agent claims a ready item, receives its bounded WorkPacket, and reports the verifier outcome — exists only as the 4K benchmark's inlined tool fixtures and the ledger's seam functions. The mounted bundle exposes no tool, so no real agent session can drive the loop, and §33's real-use gate has no instrument to accumulate evidence with. The v1.6a proposal names the exact surface: three short tools, `project_work_next`, `project_work_claim`, `project_work_update`, as consumers of the same `ctx.projectLedger` handle (§5.4).

## Decision

`src/project-work.ts` (packages/experimental/mini-profile) adds a third bundle entrypoint, `mini-project-work`, injecting `tools` and `projectLedger` and registering the three tools through `ctx.effect` on `ctx.tools`. `next` projects the agent todo view (§11) as canonical JSON — ids, statuses, priorities, recomputed blockers, live lease holders. `claim` runs the ledger's `claimWorkItem` under the worker identity `agent:<session-id>`, then `buildWorkPacket`, returning the lease receipt plus the parsed `serializeWorkPacket` document with `packetId`/`packetHash`/`serializedBytes` receipts; the schema types the packet as an unconstrained JSON node because the document is hash-pinned by the recorded recipe, and duplicating its full field list in a tool schema would drift against the ledger. `update` advances the held claim — `heartbeat`, `release`, or `report` — and `report` heartbeats first (an expired lease belongs to the reaper), evaluates only criteria whose verifier spec stores runnable text (a command or query the agent can run through its ordinary tools), transitions `VERIFYING`/`FAILED` through the ledger's closed table, reaches `DONE` only when every required criterion is already `PASSING`/`WAIVED`, and releases the lease in every concluded outcome.

The lease bearer token never enters a model-visible value: the plugin keeps a per-agent `Map` from worker identity to `{leaseId, leaseToken, workItemId}` as ordinary plugin state, so heartbeat and release present the token programmatically while every tool result — and therefore every session-log replay — stays token-free; a lost holder is recovered by expiry and the reaper. `OWNER_CONFIRMATION` and structural verifiers carry no runnable text, so the report path can never write them; owner-gated items wait in `VERIFYING` with the pending criteria named in both the canonical value and the rendered text. The lease horizon is deployment config (`leaseTtlMs`, `leaseHeartbeatIntervalMs`), validated eagerly at load against the ledger's own `resolveLeaseConfig` policy. The single-project resolution moved from `src/commands.ts` into `src/project-resolution.ts`, shared by both consumer entrypoints; the commands plugin is otherwise unchanged (the local `assertNever` keeps the closed-union backstop and now carries the declaration-site v8 ignore the coverage gate requires).

Wiring mirrors the commands entrypoint: a `project-work` patch row over `@deepseek-ai/dsh-experimental-mini-profile/project-work`, the `./project-work` export, a third package-local tsdown entry, a tsconfig.base.json subpath mapping for source launch, `dsh-tools` as a runtime dependency, and the workspace-constraints bundle rule generalized to the `./commands` and `./project-work` pair. The W08 lifecycle plugin stays byte-identical.

Verification: `tests/project-work.spec.ts` (13 tests) drives the real `ctx.tools.execute` — the closed parameter shapes, empty/ambiguous/explicit project resolution, the contested-claim rejection, the configured lease horizon, packet delivery with the token asserted absent from every value and text, heartbeat, the end-to-end `PASS`→`DONE` flow, the owner-gated `VERIFYING` wait with the owner completing through the acceptance seam, the `FAIL`→`FAILED` flow, release-and-reclaim, every grammar rejection, and the load-time lease-policy failure; the shared plan fixtures and the owner-seam activation moved to `tests/plans.ts` so no spec duplicates them; 26 tests across the package with per-file 100% coverage.

## Alternatives considered

**Return the lease token to the model for later heartbeats.** Rejected — a model-visible token lands in the session log as a durable bearer credential, defeating the lease module's own design (the token never enters a project event); the per-agent map gives the same calling ergonomics with zero exposure, and restart loses only what expiry already recovers.

**Let `report` write every criterion's evaluation, including owner confirmations.** Rejected — the model would self-certify the §5.3 acceptance gate; eligibility by stored runnable text is data-driven, covers `COMMAND`/`TEST`/`SQL_ASSERTION`, and leaves `OWNER_CONFIRMATION` and structural assertions to their owners while `changeWorkStatus`'s own required-criterion gate stays the only path to `DONE`.

**One `project_work` tool with an action parameter covering reads too.** Rejected — the proposal names three short tools and the benchmark's pinned flow scripts them individually; separate registrations keep each schema, description, and output union minimal for the 4K lane.

**Keep the packet schema as a full typed mirror of `WorkPacket`.** Rejected — a duplicated field list in the tool would drift when the ledger document evolves; the recipe hash pins the document's integrity, so an unconstrained JSON node with the receipts at the top level is the honest projection.

## Consequences

A `dsh --profile mini` agent can now drive the whole claim lifecycle model-side: observe ready work, claim it with a bounded, rebuildable packet, keep or give back the lease, and report verifier observations that the ledger — not the tool — turns into `VERIFYING`, `DONE`, or `FAILED`. This is the acting half of §33's real-use evidence; the observation half landed with the `/project` command, and the remaining v1.6b gate is the Owner domain. Every future consumer (the 4K benchmark's fixtures, a Web card, an owner queue) now has both a resolution seam (`listPlans`) and a tool grammar to build on, and the benchmark's inlined fixtures can eventually be retired in favor of this bundle's real registrations.
