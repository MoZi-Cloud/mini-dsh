# mini-DSH real-use log (§33)

English | [中文](real-use-log.zh.md)

The v1.6b/c/d entry gate (fork-mini-DSH改造方案-v1.6a.md §33) requires continuous real mini-DSH use over at least N work items, no BOOT/4K regression, and owner confirmation of value, with the basis coming from real usage recorded in the ledger. This log records that usage: each entry names the driver, the work, the verifier evidence, and where the durable ledger record lives. N is the owner's decision, not this log's.

## Entries

### 2026-09-18 — the pinned 4K slice (baseline)

One fresh scripted agent completed one ledger task under the pinned 4096-token window with the plan document never entering model context; recorded in the BOOT acceptance report (v1.6a/ section) and reproducible via `./benchmarks/context-light/run-4k.sh`. The golden plan's own execution history — the 15 v1.6a work items driven through the ledger seams — predates it.

### 2026-09-18 — PW-PRESENTERS-001 through the shipped tools

The post-v1.6a real-use lane (`./benchmarks/real-use/run-real-use.sh`) drove `PW-PRESENTERS-001` (Host presenters for the project_work tools, plan `v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml`) through the SHIPPED `MiniProjectLedger` + `mini-project-work` plugins against the persistent profile ledger `~/.dsh/project-ledger/ledger.sqlite`: claim by `agent:mini-real-use-lane`, verifier `pnpm exec vitest run mini-profile` executed as a real subprocess (exit 0), report PASS, item DONE, doctor 0 issues, event replay DONE. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v1","workItemId":"wi:mini-dsh:PW-PRESENTERS-001","stableKey":"PW-PRESENTERS-001","verifierCommand":"pnpm exec vitest run mini-profile","verifierExitCode":0,"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, doctor 0 issues, no writes). The remaining plan items — `PW-REPORT-VERDICTS-001`, `PW-OBSERVED-TAIL-001` — stay claimable in the same ledger for later increments.

## Status toward the gate

Items completed through the ledger: 16 (15 golden-plan items by the v1.6a build itself, plus this entry). BOOT/4K regression: none recorded; `run-4k.sh` and the BOOT acceptance suites stay green. Owner confirmation of value: pending — the entry decision stays with the owner per §33.
