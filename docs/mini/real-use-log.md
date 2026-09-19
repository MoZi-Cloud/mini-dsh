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

### 2026-09-19 — PW-REPLAY-VIEW-001 through the shipped tools

The same lane drove `PW-REPLAY-VIEW-001` (the `/project replay` audit view over a new `readProjectReplay` ledger seam: the project's events fold, and the rebuilt projection is compared with the materialized rows family by family and in both directions, so a row nothing replays and a replay nothing materializes are both drift) against the persistent ledger. The lane's own passing bar gained the audit in the same increment — `assertReplayClean` runs on both the completion and already-complete paths and the report line carries `replayDrift`. Claim by `agent:mini-real-use-lane`, verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE; the project timeline now holds 43 events. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v2","workItemId":"wi:mini-dsh:PW-REPLAY-VIEW-001","stableKey":"PW-REPLAY-VIEW-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-REPLAY-VIEW-001:AC-PW-REPLAY-VIEW-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, `replayDrift: 0`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE). Both version-2 items are now complete; later real-use items come from new plan versions.

### 2026-09-19 — plan version 3 and PW-DOCSYNC-GREEN-001 through the shipped tools

The plan document bumped to version 3 with a fresh batch (`PW-DOCSYNC-GREEN-001`, `PW-EVIDENCE-DIGEST-001`), and the same lane drove the bump end to end against the persistent ledger: version 3 imported, version 2 superseded through the §22 seam (event sequence 47; every prior item stays DONE and byte-identical), then `PW-DOCSYNC-GREEN-001` (the repository's complete doc-sync gate green on the fork: 40 exported-API JSDoc completions, the `ctx.projectLedger` service registered across the cordis catalog, capability-seams tables, and a new bilingual subsystems page, regenerated catalogs with both language sides in sync, and the archived proposals' code fences and package-path references repaired) claimed by `agent:mini-real-use-lane`. Its stored verifier is the gate itself — `pnpm run doc-sync` ran as a real subprocess (exit 0, 41/41 checks, ~6 minutes), which also forced a lane fix: the work plugins now mount with `leaseTtlMs` at twice the verifier timeout, because the default lease expired mid-verifier and the report landed on a lease the reaper owned. Item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v3","workItemId":"wi:mini-dsh:PW-DOCSYNC-GREEN-001","stableKey":"PW-DOCSYNC-GREEN-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-DOCSYNC-GREEN-001:AC-PW-DOCSYNC-GREEN-001","command":"pnpm run doc-sync","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, `replayDrift: 0`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE). `PW-EVIDENCE-DIGEST-001` stays claimable in version 3 for a later increment.

### 2026-09-19 — PW-EVIDENCE-DIGEST-001 through the shipped tools

The same lane drove `PW-EVIDENCE-DIGEST-001` against the persistent ledger: a new `readProjectDigest` ledger read seam aggregates the whole owner record in one read-only pass — every plan with each version's lifecycle status and pinned baseline, every item's criteria tally with its latest verdict counts (the per-criterion latest selection extracted into one helper shared with the review seam, so both keep the same rowid tie-break), and the replay audit verdict embedded as the report itself. `/project digest [<project-id>]` renders it, so the owner reads the whole §33 record without SQL or per-item commands. Claim by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE; the project timeline now holds 61 events and all seven real-use items are DONE across three versions. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v3","workItemId":"wi:mini-dsh:PW-EVIDENCE-DIGEST-001","stableKey":"PW-EVIDENCE-DIGEST-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-EVIDENCE-DIGEST-001:AC-PW-EVIDENCE-DIGEST-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, `replayDrift: 0`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE), and the complete doc-sync gate stayed green (41/41) with the new seam documented bilingually.

### 2026-09-19 — plan version 4 and PW-EXPORT-VIEW-001 through the shipped tools

The plan document bumped to version 4 with a fresh batch (`PW-EXPORT-VIEW-001`, `PW-ITEM-HISTORY-001`), and the same lane drove the bump against the persistent ledger: version 4 imported, version 3 superseded through the §22 seam, then `PW-EXPORT-VIEW-001` — the `/project export` owner evidence export — completed. The digest read seam now carries per-criterion rows (each criterion's status and latest evaluation, the row assembly shared with the review seam through `reviewedCriterionOf`, replacing the tally records), and `/project export [<project-id>]` renders the whole record as one archival markdown block: plan versions with baselines and supersede stamps, per-item completion with per-criterion verdicts, evaluator, time, observed exit code and output-tail excerpt, and the replay audit verdict. Run against this persistent ledger, the export renders 4 plan versions and 9 work items — the whole §33 record without SQL or per-item commands. Claim by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v4","workItemId":"wi:mini-dsh:PW-EXPORT-VIEW-001","stableKey":"PW-EXPORT-VIEW-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-EXPORT-VIEW-001:AC-PW-EXPORT-VIEW-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, `replayDrift: 0`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE), and the complete doc-sync gate stayed green (41/41) with the reshaped digest documented bilingually. `PW-ITEM-HISTORY-001` stays claimable in version 4 for a later increment.

### 2026-09-19 — PW-ITEM-HISTORY-001 through the shipped tools

The same lane drove `PW-ITEM-HISTORY-001` against the persistent ledger: a new `readWorkItemHistory` ledger read seam lists one work item's every recorded evaluation newest-first — verdict, evaluator, time, and observed payload per attempt — the attempts the review's latest-only view collapses away. The item-ref resolution and identity fields moved into shared helpers (`resolveWorkItemRow`, `workItemIdentityOf`) that the review and history seams now both consume, so the two per-item reads keep one resolution contract, one ambiguity error, and one id-branding path. `/project history <stable-key-or-id> [<project-id>]` renders the timeline with the observed exit code and output-tail excerpt per attempt. Claim by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run mini-profile` (exit 0), item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE; the project timeline now holds 79 events and version 4 is fully complete. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v4","workItemId":"wi:mini-dsh:PW-ITEM-HISTORY-001","stableKey":"PW-ITEM-HISTORY-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-ITEM-HISTORY-001:AC-PW-ITEM-HISTORY-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, `replayDrift: 0`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE). All nine real-use items across four plan versions are now DONE; later real-use items require a version 5 batch.

### 2026-09-19 — plan version 5 and PW-LEASE-DOCTOR-001 through the shipped tools

The plan document bumped to version 5 with a fresh batch (`PW-LEASE-DOCTOR-001`, `PW-4K-GATE-001`), and the same lane drove the bump against the persistent ledger: version 5 imported, version 4 superseded through the §22 seam (every prior item stays DONE and byte-identical), then `PW-LEASE-DOCTOR-001` — the doctor's lease-staleness check — completed. `planDoctor` now takes the reading clock (`options.nowMs`, defaulting to `Date.now()`) and reports every `work_leases` row that still records ACTIVE past its own expiry, under exactly the reaper's own predicate: the reaper is caller-driven and batched, so a cold or behind reaper leaves those rows, and replay parity cannot see them because the fold projects the same ACTIVE status. The doctor names them instead, so the operator knows recovery is owed; `/project doctor` prints them with no command change, since it renders issues generically. Claim by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run project-ledger mini-profile` (exit 0, both package suites), item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE; the project timeline now holds 90 events. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v5","workItemId":"wi:mini-dsh:PW-LEASE-DOCTOR-001","stableKey":"PW-LEASE-DOCTOR-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-LEASE-DOCTOR-001:AC-PW-LEASE-DOCTOR-001","command":"pnpm exec vitest run project-ledger mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, `replayDrift: 0`, no writes). The 4K slice rerun stayed green (6 requests, max 2,444/4,096 estimated tokens, DONE). `PW-4K-GATE-001` — the §33 BOOT/4K no-regression bar as a stored verifier running the pinned 4K lane itself — stays claimable in version 5 for a later increment.

### 2026-09-19 — PW-4K-GATE-001 through the shipped tools

The same lane claimed `PW-4K-GATE-001`, and with it the §33 BOOT/4K no-regression bar entered the ledger record itself: the item's stored verifier runs the pinned 4K context-light real-use slice (`sh benchmarks/context-light/run-4k.sh`) as a real subprocess inside the claim's lease, so the gate's outcome is now ledger data — an acceptance evaluation with the observed exit code, sitting beside this prose log as entry evidence of the kind §33 asks for rather than a design claim. No product code changed hands; the lane's default target moved to this item and the shipped tools did the rest. Claim by `agent:mini-real-use-lane`, verifier exit 0 (the lane observed and reported the 4K lane itself), item DONE, doctor 0 issues, replay audit 0 drift, event replay DONE; the project timeline now holds 97 events and version 5 is fully complete. First-run report line:

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v5","workItemId":"wi:mini-dsh:PW-4K-GATE-001","stableKey":"PW-4K-GATE-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-4K-GATE-001:AC-PW-4K-GATE-001","command":"sh benchmarks/context-light/run-4k.sh","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

An immediate rerun passed idempotently (`alreadyComplete: true`, no writes). Version 5 is complete in two items; later real-use items require a version 6 batch.

## Status toward the gate


Items completed through the ledger: 26 (15 golden-plan items by the v1.6a build itself, plus the eleven entries above). BOOT/4K regression: none recorded — the 4K bar is itself a completed ledger item (`PW-4K-GATE-001`, stored verifier `run-4k.sh`, exit 0), and the BOOT acceptance suites stay green. Owner confirmation of value: pending — the entry decision stays with the owner per §33.
