# Agent Note: doc-sync Green on the Fork and a Lease That Outlives Its Verifier

Status: implemented

English | [中文](2026-09-19-docsync-green-on-fork.zh.md)

## Problem

The repository's complete documentation gate (`pnpm run doc-sync`, 41 checks) had never passed on this fork: 40 exported-API JSDoc violations sat in the fork's own packages, the `ctx.projectLedger` service was absent from the cordis catalog's `SERVICE_PAGE` partition and the capability-seams role table, the `project` package group carried no subsystem-page link, the generated catalogs (config catalog, capability seams) were stale with their language sides out of sync, and the archived proposal documents under `docs/mini/` carried pseudocode fences marked `ts` that the doc typecheck refuses plus package-path references that predated the group layout. Every increment had been substituting the lighter `test:docs` aggregate, which hid all of it. Separately, the first lane run of the fix exposed a latent lane bug: the default lease TTL expired mid-verifier once the stored verifier was the six-minute doc-sync suite, so the report landed on a lease the reaper owned.

## Decision

Fix the gate itself rather than widening an exemption. Forty JSDoc completions land where the gate demands them (error-class `code` properties, the constitution-mirror schema constants, `@param`/`@returns` on `formatZodPath`/`languageOf`, and the twelve project-memory id factories, whose single-line inline tags the parser cannot read — tags must start their own line). `ctx.projectLedger` enters the three registration surfaces as one subsystem: a `SERVICE_PAGE` entry, a `SERVICE_ROLES` entry (provider `project-ledger-sqlite`, consumer `mini-profile`), and a new bilingual `docs/subsystems/project-ledger.md` indexed from both group READMEs; the `project` group takes a justified `GROUPS_WITHOUT_SUBSYSTEM_PAGE` exemption (storage and analysis primitives; the experimental packages own the mounted service). The generated catalogs regenerate, and because their language sides are pairing-checked, the zh mirrors carry the same insertions in the generator's own line order — the mermaid node and edge order and the table row order must match the EN generator exactly, and unlinked-backtick cells stay unlinked. The archived pseudocode fences become `text` (the prose is untouched; only the fence language claimed a type it never was), and the two path references gain their `project/` group segment. The lane mounts the work plugins with `leaseTtlMs` at twice the verifier timeout: a stored verifier is legitimately minutes long, and a claim that dies mid-verifier wastes the run.

Verification: `pnpm run doc-sync` passes 41/41 (~6 minutes, which bounds the lane verifier timeout); the lane completed `PW-DOCSYNC-GREEN-001` on a temp ledger and on the persistent ledger (version 2 superseded at event sequence 47, item DONE, doctor 0, `replayDrift` 0), then idempotently on rerun; the 4K slice stayed green at max 2,444/4,096 estimated tokens; per-package suites and typecheck pass (a combined multi-package coverage run times out project-analysis's heavy indexer tests at 5s — run that package's suite on its own).

## Alternatives considered

**Keep substituting `test:docs`.** Rejected — the aggregate hides exactly the class of drift this item found (stale generated catalogs, unregistered services, undocumented exports); a gate that never runs is a gate that has already failed.

**`ts ignore-check` fences for the fork's README samples.** Rejected for the four READMEs fixed here — the samples were one `declare` or one import away from compiling, and a compiling sample cannot rot with the API it demonstrates. The opt-out fence remains the right tool for a genuine sketch.

**Heartbeat loop in the lane instead of a longer TTL.** Rejected — the lane is a deterministic single-tenant driver, not a worker that competes for the item; doubling the horizon at mount time states the real contract (no verifier may outlive its claim) without a timer thread and its teardown races.

## Consequences

The fork now owns the same documentation bar as upstream: every later change that adds an export, moves a service, or edits a generated catalog's source fails doc-sync until the registration and both language sides move together — and the lane's stored verifier is that gate, so the §33 record proves it continuously. The lease rule is now explicit: any lane-driven verifier longer than the default TTL needs the configured horizon, and future minute-class verifiers (full typecheck, hygiene) are safe to store. `PW-EVIDENCE-DIGEST-001` (the owner-facing evidence digest in `/project`) stays claimable in version 3 as the next increment.
