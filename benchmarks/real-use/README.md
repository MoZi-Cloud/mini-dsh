# Post-v1.6a real-use lane

English | [中文](README.zh.md)

## Summary

The repeatable §33 real-use driver (docs/mini/real-use-log.md): one ready work item of the post-v1.6a increment plan completes through the SHIPPED mini-profile surface — the same `MiniProjectLedger` and `mini-project-work` plugins a `dsh --profile mini` session mounts — with no model involved. The lane is the agent of record: it observes through `project_work_next`, claims through `project_work_claim` (receiving the WorkPacket, never the plan document), executes the packet's stored verifier command as a real subprocess in the repository, and reports through `project_work_update`. DONE with a clean doctor and a matching event replay is the only passing outcome; a failing verifier records FAIL and fails the run.

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

The script compiles the worker with the benchmark tsdown config, then runs it under plain Node against the built workspace libraries (`pnpm install && pnpm run build` first on a fresh tree). This is a functional lane gate, not a timed benchmark; it is not part of `test:bench`. `DSH_REAL_USE_ITEM` names the item to claim (default `PW-PRESENTERS-001`, the presenters item of `fork-mini-DSH-post-v1.6a.plan.yaml`).

<a id="ledger-and-idempotency"></a>

## Ledger and idempotency

The lane drives a fresh temporary ledger by default and exits 0 with a one-line JSON report. `DSH_REAL_USE_LEDGER` points it at a persistent file — the profile default is `~/.dsh/project-ledger/ledger.sqlite` — so consecutive runs accumulate the real-use record where a real `dsh --profile mini` session reads it. Runs are idempotent: an already-imported version is reused, and an already-complete item passes with `alreadyComplete: true` and no writes. The lane performs the owner's version activation directly (a raw status update), because activation has no ledger writer in v1.6a; the claim, evaluation, and completion all go through the shipped tools.

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

[The Agent Note](../../.agents/notes/implemented/testing/2026-09-18-post-v16a-real-use-lane.md) owns the lane design, the shipped-surface fidelity argument, and the evidence record policy. The real-use log (docs/mini/real-use-log.md) records each persistent-ledger run.

</details>
