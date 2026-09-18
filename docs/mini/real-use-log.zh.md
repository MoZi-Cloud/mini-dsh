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

### 2026-09-18 —— 经 shipped 工具完成 PW-REPORT-VERDICTS-001

同一 lane 对持久账本驱动 `PW-REPORT-VERDICTS-001`（`project_work_update` 报告的逐标准判定：每个可观察验收标准恰好一条 `{criterionId, result PASS|FAIL, 可选 exitCode}`，取代原先摊到全部标准的单一判定）。报告语法在本增量内同步换到 lane 之下：lane 现在从 WorkPacket 逐标准执行其存储命令并逐项报告判定，其 JSON 行新增逐标准的 `verifierResults`。由 `agent:mini-real-use-lane` 领取、verifier `pnpm exec vitest run mini-profile`（退出码 0）、工作项 DONE、doctor 0 问题、事件重放 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v1","workItemId":"wi:mini-dsh:PW-REPORT-VERDICTS-001","stableKey":"PW-REPORT-VERDICTS-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-REPORT-VERDICTS-001:AC-PW-REPORT-VERDICTS-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`，零写入）。语法变更后的 4K 切片重跑保持绿色（6 请求、最大 2,427/4,096 估算 token、DONE），本增量无 BOOT/4K 回归。计划剩余项——`PW-OBSERVED-TAIL-001`——保持可领取，留给后续增量。

### 2026-09-18 —— 经 shipped 工具完成 PW-OBSERVED-TAIL-001

同一 lane 对持久账本驱动 `PW-OBSERVED-TAIL-001`（`project_work_update` 报告的有界 verifier 输出尾部：每条判定条目新增可选 `outputTail`，report 至多保存其末尾 2048 字符到评估的 observed 载荷中、与 exitCode 并列，账本重放因此无需重跑命令即可解释判定）。lane 现在把每个已执行 verifier 捕获的输出作为尾部传入，并断言有界尾部已落入 `acceptance_evaluations.observed_json`。由 `agent:mini-real-use-lane` 领取、verifier `pnpm exec vitest run mini-profile`（退出码 0）、工作项 DONE、doctor 0 问题、事件重放 DONE；所记评估的 observed 载荷持有 `{exitCode: 0, outputTail: 1785 字符真实 vitest 输出}`。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v1","workItemId":"wi:mini-dsh:PW-OBSERVED-TAIL-001","stableKey":"PW-OBSERVED-TAIL-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-OBSERVED-TAIL-001:AC-PW-OBSERVED-TAIL-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`，零写入）。变更后的 4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE——脚本化报告现在携带一条短输出尾部），本增量无 BOOT/4K 回归。至此 post-v1.6a 增量 backlog 全部完成；后续真实使用项需来自新的计划版本。

## 相对门槛的状态

经账本完成的工作项：18（15 个黄金计划项由 v1.6a 构建本身完成，加上面三条）。BOOT/4K 回归：无记录；`run-4k.sh` 与 BOOT 验收套件保持绿色。用户价值确认：待定——进入决策按 §33 归 owner。
