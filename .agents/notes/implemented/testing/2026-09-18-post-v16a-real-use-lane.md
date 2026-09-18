# Agent Note: The Post-v1.6a Real-Use Lane and the §33 Evidence Record

Status: implemented

English | [中文](2026-09-18-post-v16a-real-use-lane.zh.md)

## Problem

§33 opens v1.6b only on continuous real ledger use over N work items with the evidence coming from usage recorded in the ledger, and the acceptance report's §33 section counts exactly one real-use slice (the 4K lane) plus the golden plan's own history. The 4K lane, however, drives fixture tool clones against an `:memory:` database — the shipped `mini-project-work` plugins had never completed a real work item outside unit tests, no persistent ledger existed, and the increment backlog (the presenter gap the tools shipped with) lived only in README prose. Keyless, no model session can produce that record: `DEEPSEEK_API_KEY` does not exist in this environment.

## Decision

Three pieces land together. First, the payload: the three `project_work_*` tools gain pure `presentCall` generic views (goal-tool pattern — args-only, a shared `present` helper, soft validation returning `undefined` on malformed replay args; no `presentResult`, since the rendered model content already serves the completed card and the Web Client derives its cards from raw events regardless). Second, the backlog becomes plan-as-data: `docs/mini/v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml` records the presenter item plus two future increments (`PW-REPORT-VERDICTS-001` per-criterion report verdicts, `PW-OBSERVED-TAIL-001` verifier output tails in observed evaluations), each with a stored `pnpm exec vitest run mini-profile` verifier. Third, the driver: `benchmarks/real-use/run-real-use.sh` (a built-worker lane mirroring the 4K scaffolding — tsdown `neverBundle`, `assertBuiltBenchmarkRuntime`, plain Node) mounts the SHIPPED `SystemPrompt` → `ToolRuntime` → `MiniProjectLedger` → `mini-project-work` composition, imports the plan idempotently (existing version reused, activation is the documented raw owner update), and for one target item walks the real tool surface — `next` to find it, `claim` to receive the WorkPacket, a real `sh -c` subprocess for the packet's stored verifier command, `report` with the observed exit code — accepting only DONE with 0 doctor issues and a DONE event replay.

The lane defaults to a fresh temporary ledger; `DSH_REAL_USE_LEDGER` points it at a persistent file. The first persistent run targeted the profile default `~/.dsh/project-ledger/ledger.sqlite`, so the record lives where a real `dsh --profile mini` session reads it, and an immediate rerun passed idempotently (`alreadyComplete: true`, no writes). `docs/mini/real-use-log.md` is the living evidence log: one entry per persistent run, plus the standing gate status (16 items completed through the ledger, no BOOT/4K regression, owner confirmation pending per §33).

Verification: the presenter spec (soft-fail malformed args included) brings mini-profile to 27 tests at per-file 100% coverage; the lane ran green on a temporary ledger and twice on the persistent profile ledger (completion then idempotent rerun), each time executing the real verifier suite as a subprocess (exit 0), with doctor 0 issues and replay DONE; full typecheck, oxlint, `test:docs`, hygiene, and duplication carry only their pre-existing baselines. `benchmarks/package.json` gains `dsh-system-prompt` and `dsh-experimental-mini-profile` devDependencies — the worker resolves runtime imports through it.

## Alternatives considered

**Drive the seams directly, like the fixture generator.** Rejected — the point of the evidence is that the shipped model-facing surface completes real work; seam calls would re-prove the ledger, not the profile composition the §33 gate is about to rely on.

**Commit a generated evidence database, like `v1.6a-populated.db`.** Rejected — the tools path uses real clocks (lease expiry, event stamps), so byte-stable regeneration is impossible without clock injection the tools deliberately do not offer; a continuously re-runnable lane whose green exit re-proves the record is stronger evidence than a frozen file.

**Wait for a live model session before recording real use.** Rejected — the acceptance report already counts the deterministic 4K slice as real use, the lane is that precedent applied to the shipped surface, and §33's N-items clock should not depend on key availability.

**Mount the `/project` command surface in the lane too.** Rejected — `CommandRuntime` is a TypertRemoteService; mounting it would couple the lane to the typert graph for output the ledger seams already read. The command surface keeps its own unit tests.

## Consequences

Each later increment claims its plan item through the lane (or a real session) against the same persistent ledger, so the §33 record accumulates in place and the log's item count is checkable against the ledger itself. The lane is the standing keyless answer to "did the shipped profile surface complete real work": CI does not run it (4K-lane policy — a functional gate, not a timed benchmark), so the log records each persistent run. The backlog items are now ledger facts with stored verifiers, which also disciplines future increments: landing one means claiming, verifying, and reporting it, not editing README prose.
