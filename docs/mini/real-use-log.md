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

### 2026-09-18 — PW-REPORT-VERDICTS-001 through the shipped tools

The same lane drove `PW-REPORT-VERDICTS-001` (per-criterion verdicts in `project_work_update` reports: one `{criterionId, result PASS|FAIL, optional exitCode}` entry per observable acceptance criterion, exactly once each, replacing the single blanket verdict) against the persistent ledger. The report grammar changed under the lane in the same increment: the lane now runs each observable criterion's stored command from the WorkPacket and reports one verdict per criterion, and its JSON line gained per-criterion `verifierResults`. Claim by `agent:mini-real-use-lane`, verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, event replay DONE. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v1","workItemId":"wi:mini-dsh:PW-REPORT-VERDICTS-001","stableKey":"PW-REPORT-VERDICTS-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-REPORT-VERDICTS-001:AC-PW-REPORT-VERDICTS-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, no writes). The 4K slice rerun after the grammar change stayed green (6 requests, max 2,427/4,096 estimated tokens, DONE), so no BOOT/4K regression accompanies this increment. The remaining plan item — `PW-OBSERVED-TAIL-001` — stays claimable for a later increment.

### 2026-09-18 — PW-OBSERVED-TAIL-001 through the shipped tools

The same lane drove `PW-OBSERVED-TAIL-001` (bounded verifier output tails in `project_work_update` reports: each verdict entry gained an optional `outputTail`, of which the report stores at most the final 2048 characters in the evaluation's observed payload beside the exit code, so a replayed ledger explains a verdict without re-running the command) against the persistent ledger. The lane now passes each executed verifier's captured output as the tail and asserts the bounded tail landed in `acceptance_evaluations.observed_json`. Claim by `agent:mini-real-use-lane`, verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, event replay DONE; the recorded evaluation's observed payload holds `{exitCode: 0, outputTail: 1785 chars of real vitest output}`. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v1","workItemId":"wi:mini-dsh:PW-OBSERVED-TAIL-001","stableKey":"PW-OBSERVED-TAIL-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-OBSERVED-TAIL-001:AC-PW-OBSERVED-TAIL-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, no writes). The 4K slice rerun after the change stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE — the scripted report now carries a short output tail), so no BOOT/4K regression accompanies this increment. This closes the post-v1.6a increment backlog; later real-use items come from new plan versions.

### 2026-09-18 — plan version 2 and PW-ITEM-REVIEW-001 through the shipped tools

The plan document (`v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml`) bumped to version 2 with a fresh batch (`PW-ITEM-REVIEW-001`, `PW-REPLAY-VIEW-001`), and the same lane drove the bump end to end against the persistent ledger: version 2 imported, version 1 superseded through the §22 seam (`supersedePlanVersion` naming the successor — the seam's first real-use record, event sequence 29; the three version-1 items stay DONE and byte-identical), then `PW-ITEM-REVIEW-001` (the `/project item` review view over a new `readWorkItemReview` ledger seam) claimed by `agent:mini-real-use-lane`, verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, event replay DONE. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v2","workItemId":"wi:mini-dsh:PW-ITEM-REVIEW-001","stableKey":"PW-ITEM-REVIEW-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-ITEM-REVIEW-001:AC-PW-ITEM-REVIEW-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE). `PW-REPLAY-VIEW-001` stays claimable in version 2 for a later increment.

## Status toward the gate

Items completed through the ledger: 19 (15 golden-plan items by the v1.6a build itself, plus the four entries above). BOOT/4K regression: none recorded; `run-4k.sh` and the BOOT acceptance suites stay green. Owner confirmation of value: pending — the entry decision stays with the owner per §33.
