# Agent Note: The mini Profile's `/project` Command Surface

Status: implemented

English | [中文](2026-09-18-mini-project-commands.zh.md)

## Problem

v1.6a closed with the ledger mounted but unreachable for the human operating a `mini` session: the W08 bundle exposes only `ctx.projectLedger`, and every read requires calling seam functions against the handle. The BOOT acceptance report's own next step names the `/project` command surface, and §33's real-use gate needs a practical way to observe work before v1.6b can start.

## Decision

`src/commands.ts` (packages/experimental/mini-profile) adds a second bundle entrypoint, `mini-project-commands`, registering one global `/project` command through `ctx.effect` on `ctx.commands` (dsh-base already mounts the registry). The grammar is closed — `todo [--agent|--owner] [<project-id>]` and `doctor [<plan-version-id>]` — parsed into a discriminated union, rendered as plain text, and settled as `CommandResult` success/error; unknown input answers with usage. Resolution goes through a new read seam, `listPlans` (packages/experimental/project-ledger `plan-directory.ts`), which lists `plans` rows with their `current_version_id` pointer: an unnamed project or version resolves from a single-plan ledger, and empty or multi-plan ledgers fail loud with actionable text. The handler injects `commands` and `projectLedger`, reads only, sends nothing to the model, and rethrows non-domain failures instead of masking them; activation stays an owner seam, so `doctor` without an id requires a named-current version.

Wiring: the patch gains a `project-commands` row naming `@deepseek-ai/dsh-experimental-mini-profile/commands`, the package gains the `./commands` export with a package-local tsdown config bundling both entries (widening the workspace-wide entry list would have newly bundled the api controllers' internal `commands.js`), and `dsh-commands`/`dsh-brand` become runtime dependencies. The W08 lifecycle plugin is byte-identical.

Verification: `tests/commands.spec.ts` (8 tests) drives the real `ctx.commands.execute` — help, both views of the golden import, explicit and missing project ids, doctor on named-current/explicit/unknown versions, drift surfaced through the command, blocked readiness, live lease after a real claim, empty views, phase-less items, multi-plan disambiguation, every parse rejection, the `command/run`+`command/done` lifecycle pair, and the closed-handle rethrow; `tests/plan-directory.spec.ts` (3 tests) covers the seam; bundle/service suites updated to the two-row composition; 202 tests across the touched packages with per-file 100% coverage.

## Alternatives considered

**Register the command inside the W08 `MiniProjectLedger` service plugin.** Rejected — it would rewrite an acceptance-tested plugin's identity from lifecycle-only to lifecycle-plus-surface and make its construction depend on the registry; a second entrypoint leaves W08 byte-identical and mirrors the `command-goal` plugin pattern.

**Query the `plans` table from the command module.** Rejected — the bundle's recorded identity disclaims ledger semantics; project/version resolution is a reusable read, so it belongs in the ledger as `listPlans`.

**Require explicit ids everywhere (`/project todo <project-id>`, `/project doctor <pv:…>`).** Rejected — the mini ledger holds one project; forcing ids on the common case makes the surface unusable for observation, and the ambiguous case still fails loud with the ids it needs.

**Cover doctor-without-id by exporting an activation writer.** Rejected — activation is deliberately an owner seam in v1.6a (§5); the command surfaces the unnamed-current state as actionable error text instead of quietly widening authority.

## Consequences

A `dsh --profile mini` session can now observe the ledger — outstanding owner/agent work with blockers and lease holders, and doctor verdicts — which is the observation half of the §33 real-use evidence; the mutating Owner flows remain v1.6b scope, and the model-facing project-work tool remains a later consumer of the same handle. `listPlans` is now the resolution seam for any future surface (Web cards, export) that must answer "which project/version".
