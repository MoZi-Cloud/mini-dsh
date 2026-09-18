# mini-DSH 真实使用日志（§33）

[English](real-use-log.md) | 中文

v1.6b/c/d 进入门（fork-mini-DSH改造方案-v1.6a.md §33）要求 v1.6a 在真实 mini-DSH 开发中连续使用至少 N 个工作项、BOOT/4K 无回归、且用户确认账本有实际价值，依据必须来自账本中的真实使用记录。本日志记录这些使用：每条记录写明驱动者、工作内容、verifier 证据与持久账本记录所在。N 由 owner 决定，不由本日志决定。

## 记录

### 2026-09-18 —— 固定的 4K 切片（基线）

一个全新脚本 agent 在固定 4096 token 窗口下完成一项账本任务，计划文档从未进入模型上下文；记录于 BOOT 验收报告（v1.6a/ 目录），可经 `./benchmarks/context-light/run-4k.sh` 复现。黄金计划自身的执行历史——15 个 v1.6a 工作项经账本 seam 驱动——早于它。

### 2026-09-18 —— 经 shipped 工具完成 PW-PRESENTERS-001

post-v1.6a 真实使用 lane（`./benchmarks/real-use/run-real-use.sh`）经 SHIPPED 的 `MiniProjectLedger` + `mini-project-work` 插件，对持久 profile 账本 `~/.dsh/project-ledger/ledger.sqlite` 驱动 `PW-PRESENTERS-001`（project_work 工具的 Host presenter，计划 `v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml`）：由 `agent:mini-real-use-lane` 领取、verifier `pnpm exec vitest run mini-profile` 作为真实子进程执行（退出码 0）、报告 PASS、工作项 DONE、doctor 0 问题、事件重放 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v1","workItemId":"wi:mini-dsh:PW-PRESENTERS-001","stableKey":"PW-PRESENTERS-001","verifierCommand":"pnpm exec vitest run mini-profile","verifierExitCode":0,"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`，doctor 0 问题，零写入）。计划中剩余项——`PW-REPORT-VERDICTS-001`、`PW-OBSERVED-TAIL-001`——在同一账本中保持可领取，留给后续增量。

## 相对门槛的状态

经账本完成的工作项：16（15 个黄金计划项由 v1.6a 构建本身完成，加本条）。BOOT/4K 回归：无记录；`run-4k.sh` 与 BOOT 验收套件保持绿色。用户价值确认：待定——进入决策按 §33 归 owner。
