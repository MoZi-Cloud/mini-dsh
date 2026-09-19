# Post-v1.6a real-use lane

English | [中文](README.zh.md)

## Summary

The repeatable §33 real-use driver (docs/mini/real-use-log.md): one ready work item of the post-v1.6a increment plan completes through the SHIPPED mini-profile surface — the same `MiniProjectLedger` and `mini-project-work` plugins a `dsh --profile mini` session mounts — with no model involved. The lane is the agent of record: it observes through `project_work_next`, claims through `project_work_claim` (receiving the WorkPacket, never the plan document), executes each observable criterion's stored verifier command from the packet as a real subprocess in the repository, and reports one verdict per criterion with the observed exit code and output tail through `project_work_update`, the tail landing beside the exit code in each evaluation's observed payload. DONE with a clean doctor, a matching event replay, and a drift-free replay audit is the only passing outcome; a failing verifier records its criterion FAIL and fails the run.

## Table of Contents

- [Run](#run)
- [Ledger and idempotency](#ledger-and-idempotency)
- [Dev Note](#dev-note)

<a id="run"></a>

## Run

From the repository root:

```sh
./benchmarks/real-use/run-real-use.sh
```

The script compiles the worker with the benchmark tsdown config, then runs it under plain Node against the built workspace libraries (`pnpm install && pnpm run build` first on a fresh tree). This is a functional lane gate, not a timed benchmark; it is not part of `test:bench`. The lane mounts the work plugins with `leaseTtlMs` at twice the verifier timeout, so a minutes-long stored verifier (doc-sync's gate suite alone takes ~6) never outlives its claim. `DSH_REAL_USE_ITEM` names the item to claim (default `PW-EXPORT-VIEW-001`, the first item of version 4 in `fork-mini-DSH-post-v1.6a.plan.yaml`).

<a id="ledger-and-idempotency"></a>

## Ledger and idempotency

The lane drives a fresh temporary ledger by default and exits 0 with a one-line JSON report. `DSH_REAL_USE_LEDGER` points it at a persistent file — the profile default is `~/.dsh/project-ledger/ledger.sqlite` — so consecutive runs accumulate the real-use record where a real `dsh --profile mini` session reads it. Runs are idempotent: the plan document's current version imports once, and an already-complete item passes with `alreadyComplete: true` and no writes. A version bump in the plan document supersedes the prior ACTIVE version through the §22 seam (`supersedePlanVersion` naming the imported successor); the lane performs the owner's supersede and activation directly (raw status updates), because neither has a shipped lane-facing writer — the claim, evaluation, and completion all go through the shipped tools.

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

[The Agent Note](../../.agents/notes/implemented/testing/2026-09-18-post-v16a-real-use-lane.md) owns the lane design, the shipped-surface fidelity argument, and the evidence record policy. The real-use log (docs/mini/real-use-log.md) records each persistent-ledger run.

</details>
