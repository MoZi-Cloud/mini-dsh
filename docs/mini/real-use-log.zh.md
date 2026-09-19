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

### 2026-09-18 —— 计划版本 2 与经 shipped 工具完成 PW-ITEM-REVIEW-001

计划文档（`v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml`）升到版本 2 并携带全新一批条目（`PW-ITEM-REVIEW-001`、`PW-REPLAY-VIEW-001`），同一 lane 对持久账本完整驱动了这次升版：版本 2 导入，版本 1 经 §22 接缝 supersede（`supersedePlanVersion` 指名继任者——该接缝的首条真实使用记录，事件序号 29；版本 1 的三个工作项保持 DONE 且逐字节不变），随后 `PW-ITEM-REVIEW-001`（`/project item` 审视图，建于新的 `readWorkItemReview` 账本接缝之上）由 `agent:mini-real-use-lane` 领取、verifier `pnpm exec vitest run mini-profile`（退出码 0）、工作项 DONE、doctor 0 问题、事件重放 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v2","workItemId":"wi:mini-dsh:PW-ITEM-REVIEW-001","stableKey":"PW-ITEM-REVIEW-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-ITEM-REVIEW-001:AC-PW-ITEM-REVIEW-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`，零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE）。`PW-REPLAY-VIEW-001` 在版本 2 中保持可领取，留给后续增量。

### 2026-09-19 —— 经 shipped 工具完成 PW-REPLAY-VIEW-001

同一 lane 对持久账本驱动了 `PW-REPLAY-VIEW-001`（`/project replay` 对账视图，建于新的 `readProjectReplay` 账本接缝之上：折叠项目全量事件，把重建投影与物化行逐族双向比对——物化侧多出的行与重放侧多出的实体同样算 drift）。同一增量内，lane 自身的通过判据也加入了该对账——`assertReplayClean` 在完成与已完结两条路径上运行，报告行新增 `replayDrift`。由 `agent:mini-real-use-lane` 领取、verifier `pnpm exec vitest run mini-profile`（退出码 0）、工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE；项目时间线现有 43 条事件。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v2","workItemId":"wi:mini-dsh:PW-REPLAY-VIEW-001","stableKey":"PW-REPLAY-VIEW-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-REPLAY-VIEW-001:AC-PW-REPLAY-VIEW-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、`replayDrift: 0`、零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE）。版本 2 的两个条目至此全部完成；后续真实使用条目来自新的计划版本。

### 2026-09-19 —— 计划版本 3 与经 shipped 工具完成 PW-DOCSYNC-GREEN-001

计划文档升到版本 3 并携带全新一批条目（`PW-DOCSYNC-GREEN-001`、`PW-EVIDENCE-DIGEST-001`），同一 lane 对持久账本完整驱动了这次升版：版本 3 导入，版本 2 经 §22 接缝 supersede（事件序号 47；此前每个条目保持 DONE 且逐字节不变），随后 `PW-DOCSYNC-GREEN-001`（仓库完整 doc-sync 门在本 fork 转绿：补全 40 处导出 API JSDoc、把 `ctx.projectLedger` 服务登记进 cordis catalog、capability-seams 表与新增的双语 subsystems 页、再生成双语言同步的各 catalog、修复归档方案文档的代码围栏与包路径引用）由 `agent:mini-real-use-lane` 领取。其存储 verifier 就是门本身——`pnpm run doc-sync` 作为真实子进程运行（退出码 0、41/41 检查、约 6 分钟），这同时逼出一处 lane 修复：工作插件现在以两倍 verifier 超时的 `leaseTtlMs` 挂载，因为默认租约在 verifier 中途过期、报告落在 reaper 接管的租约上。工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v3","workItemId":"wi:mini-dsh:PW-DOCSYNC-GREEN-001","stableKey":"PW-DOCSYNC-GREEN-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-DOCSYNC-GREEN-001:AC-PW-DOCSYNC-GREEN-001","command":"pnpm run doc-sync","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、`replayDrift: 0`、零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE）。`PW-EVIDENCE-DIGEST-001` 在版本 3 中保持可领取，留给后续增量。

### 2026-09-19 —— 经 shipped 工具完成 PW-EVIDENCE-DIGEST-001

同一 lane 对持久账本驱动了 `PW-EVIDENCE-DIGEST-001`：新的 `readProjectDigest` 账本读取接缝以一次只读遍历聚合整个 owner 记录——每个 plan 及其全部版本的生命周期状态与钉定 baseline、每个条目的标准计数与最新判定计数（每条标准的最新选取抽成与 review 接缝共享的辅助函数，两者保持同一 rowid 决胜规则）、以及按报告原样内嵌的重放对账结论。`/project digest [<project-id>]` 渲染它，owner 无需 SQL 或逐条目命令即可读完整个 §33 记录。`agent:mini-real-use-lane` 领取，存储 verifier `pnpm exec vitest run mini-profile`（退出码 0），工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE；项目时间线现有 61 事件，三个版本下全部七条真实使用条目均 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v3","workItemId":"wi:mini-dsh:PW-EVIDENCE-DIGEST-001","stableKey":"PW-EVIDENCE-DIGEST-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-EVIDENCE-DIGEST-001:AC-PW-EVIDENCE-DIGEST-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、`replayDrift: 0`、零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE），仓库完整 doc-sync 门也保持绿色（41/41），新接缝已双语成文。

### 2026-09-19 —— 计划版本 4 与经 shipped 工具完成 PW-EXPORT-VIEW-001

计划文档升到版本 4 并携带全新一批条目（`PW-EXPORT-VIEW-001`、`PW-ITEM-HISTORY-001`），同一 lane 对持久账本完整驱动了这次升版：版本 4 导入，版本 3 经 §22 接缝 supersede，随后 `PW-EXPORT-VIEW-001`——`/project export` owner 证据导出——完成。digest 读取接缝现在携带逐标准行（每条标准的投影状态与最新评估，行组装经 `reviewedCriterionOf` 与 review 接缝共享，取代原先的计数记录），`/project export [<project-id>]` 把整个记录渲染成单个可归档的 markdown 块：带 baseline 与 supersede 戳的 plan 版本、逐条目完成度（逐标准判定、评估者、时间、观察到的 exitCode 与输出尾部摘录）、以及重放对账结论。对本持久账本运行，export 渲染出 4 个 plan 版本与 9 个工作项——无需 SQL 或逐条目命令的完整 §33 记录。`agent:mini-real-use-lane` 领取，存储 verifier `pnpm exec vitest run mini-profile`（退出码 0），工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v4","workItemId":"wi:mini-dsh:PW-EXPORT-VIEW-001","stableKey":"PW-EXPORT-VIEW-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-EXPORT-VIEW-001:AC-PW-EXPORT-VIEW-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、`replayDrift: 0`、零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE），仓库完整 doc-sync 门也保持绿色（41/41），重塑后的 digest 已双语成文。`PW-ITEM-HISTORY-001` 在版本 4 中保持可领取，留给后续增量。

### 2026-09-19 —— 经 shipped 工具完成 PW-ITEM-HISTORY-001

同一 lane 对持久账本驱动了 `PW-ITEM-HISTORY-001`：新的 `readWorkItemHistory` 账本读取接缝按最新在前列出单个工作项的全部已记录评估——每次尝试的判定、评估者、时间与 observed 载荷——即 latest-only 评审折叠掉的那些尝试。条目 ref 解析与身份字段移入共享辅助函数（`resolveWorkItemRow`、`workItemIdentityOf`），评审与历史两个接缝共同消费，两个逐条目读取从此保持同一解析契约、同一重载歧义错误与同一 id 品牌化路径。`/project history <stable-key-or-id> [<project-id>]` 渲染时间线，每次尝试附观察到的 exitCode 与输出尾部摘录。`agent:mini-real-use-lane` 领取，存储 verifier `pnpm exec vitest run mini-profile`（退出码 0），工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE；项目时间线现有 79 事件，版本 4 全部完成。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v4","workItemId":"wi:mini-dsh:PW-ITEM-HISTORY-001","stableKey":"PW-ITEM-HISTORY-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-ITEM-HISTORY-001:AC-PW-ITEM-HISTORY-001","command":"pnpm exec vitest run mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、`replayDrift: 0`、零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE）。四个 plan 版本下全部九条真实使用条目均 DONE；后续真实使用条目需要版本 5 批次。

### 2026-09-19 —— 计划版本 5 与经 shipped 工具完成 PW-LEASE-DOCTOR-001

计划文档升到版本 5 并携带全新一批条目（`PW-LEASE-DOCTOR-001`、`PW-4K-GATE-001`），同一 lane 对持久账本完整驱动了这次升版：版本 5 导入，版本 4 经 §22 接缝 supersede（既有条目全部保持 DONE 且逐字节不变），随后 `PW-LEASE-DOCTOR-001`——doctor 的租约过期检查——完成。`planDoctor` 现在接受读时钟（`options.nowMs`，默认 `Date.now()`），并按 reaper 自己的判定谓词报告每一行过了自身有效期仍记 ACTIVE 的 `work_leases` 行：reaper 由调用方驱动且有界分批，冷账本或落后的 reaper 会留下这些行，而重放对账看不到它们——事件折叠投影出的同样是 ACTIVE。doctor 把它们点名，操作者由此知道有恢复欠着；`/project doctor` 对 issue 逐条通用渲染，命令层零改动。`agent:mini-real-use-lane` 领取，存储 verifier `pnpm exec vitest run project-ledger mini-profile`（退出码 0，两个包的套件都跑），工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE；项目时间线现有 90 事件。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v5","workItemId":"wi:mini-dsh:PW-LEASE-DOCTOR-001","stableKey":"PW-LEASE-DOCTOR-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-LEASE-DOCTOR-001:AC-PW-LEASE-DOCTOR-001","command":"pnpm exec vitest run project-ledger mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、`replayDrift: 0`、零写入）。4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE）。`PW-4K-GATE-001`——把 §33 的 BOOT/4K 无回归门槛本身作为存储 verifier（直接跑钉住的 4K lane）——在版本 5 中保持可领取，留给后续增量。

### 2026-09-19 —— 经 shipped 工具完成 PW-4K-GATE-001

同一 lane 领取了 `PW-4K-GATE-001`，§33 的 BOOT/4K 无回归门槛随之进入账本记录本身：该条目的存储 verifier 在领取租约内把钉住的 4K context-light 真实使用切片（`sh benchmarks/context-light/run-4k.sh`）作为真实子进程完整执行，门槛的结论从此是账本数据——带观察到的退出码的验收评估，落在这份文字日志旁边，是 §33 要的那种进入证据而非设计声明。本次没有产品代码改动；lane 的默认目标移到该条目，其余全部由 shipped 工具完成。`agent:mini-real-use-lane` 领取，verifier 退出码 0（lane 观察并报告的正是 4K lane 本身），工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE；项目时间线现有 97 事件，版本 5 全部完成。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-post-v16a-increments:v5","workItemId":"wi:mini-dsh:PW-4K-GATE-001","stableKey":"PW-4K-GATE-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PW-4K-GATE-001:AC-PW-4K-GATE-001","command":"sh benchmarks/context-light/run-4k.sh","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

紧接着的重跑幂等通过（`alreadyComplete: true`、零写入）。版本 5 两项条目全部完成；后续真实使用条目需要版本 6 批次。

### 2026-09-19 —— v1.6b 进入：decision 域带着它自己的进入决策落地

§33(c) 经既定 go 门确认（证据简报已从本账本实时渲染 digest、doctor 与 history），本增量随之完成 `PB-DECISION-RECORD-001`、开启提案的 v1.6b 范围——新计划（`mini-dsh-v16b-owner-decision`，自有版本链，与仍 ACTIVE 的 post-v1.6a v5 并存）的第一个条目。decision 记录闭环：schema 版本 2（`decision_requests` / `decision_options` / `decisions`，经一次追加的 1→2 迁移）、两个必需词汇事件（`decision/requested`、`decision/recorded`）把事件格式升到 2 并采用相邻读取——更旧戳记的行可解码、只有更新戳记才拒绝，本账本 97 条 format-1 事件因此跨升版保持可读——事务性写入接缝（`openDecisionRequest`、`recordDecision`）、最新在前的 `readProjectDecisions`、覆盖新族的重放对账与 doctor 奇偶校验、只读的 `/project decisions` 视图。lane 还在持久账本上抓到一个真实解析缺陷：同项目出现第二个 plan 后隐式 `/project` 解析失败（"more than one project: mini-dsh, mini-dsh"）；解析器现在把 plan id 去重为 project id，只在跨不同项目时才保持歧义。`agent:mini-real-use-lane` 领取，存储 verifier `pnpm exec vitest run project-ledger project-ledger-sqlite mini-profile`（退出码 0；269 项测试、三包 per-file 100% 覆盖），工作项 DONE、doctor 0 问题、重放对账 0 drift、事件重放 DONE。首次运行报告行：

```json
{"lane":"real-use","ledger":"~/.dsh/project-ledger/ledger.sqlite","alreadyComplete":false,"planVersionId":"plv:mini-dsh-v16b-owner-decision:v1","workItemId":"wi:mini-dsh:PB-DECISION-RECORD-001","stableKey":"PB-DECISION-RECORD-001","verifierResults":[{"criterionId":"ac:wi:mini-dsh:PB-DECISION-RECORD-001:AC-PB-DECISION-RECORD-001","command":"pnpm exec vitest run project-ledger project-ledger-sqlite mini-profile","exitCode":0}],"itemStatus":"DONE","doctorIssues":0,"replayDrift":0,"replayItemStatus":"DONE","toolCalls":{"project_work_next":1,"project_work_claim":1,"project_work_update":1}}
```

运行之后，owner 的 §33 进入确认本身成为该域第一条记录的决策：请求 `dr:mini-dsh:v1.6b-entry`（选项 `enter-v1.6b`（推荐）/ `keep-accumulating` / `more-evidence`，挂在 v1.6b plan 版本上）由 `owner` 选中 `enter-v1.6b` 解除，即事件 109——打开这个域的那道门，就是这个域的第一行。项目时间线现有 109 事件：97 条 format-1 在 format-2 编解码器下正常解码，旁边是 12 条 format-2；持久账本在首次打开时就地迁移 schema 1→2，已提交的 v1 夹具保持冻结并成为该迁移的升级探针。紧接着的重跑幂等通过（`alreadyComplete: true`、零写入），4K 切片重跑保持绿色（6 请求、最大 2,444/4,096 估算 token、DONE）。`PB-APPROVAL-RECORD-001`——按类型化 subject 引用的 approvals，按蓝图裁定与 decisions 分表——在 v1.6b 计划中保持 READY。

## 相对门槛的状态


经账本完成的工作项：27（15 个黄金计划项由 v1.6a 构建本身完成，加上面十二条）。BOOT/4K 回归：无记录——4K 门槛本身已是完成的账本条目（`PW-4K-GATE-001`，存储 verifier `run-4k.sh`，退出码 0）且每个增量的复跑保持绿色；BOOT 验收套件保持绿色。用户价值确认：**已于 2026-09-19 给出**——经既定 go 门确认、并记为决策 `dr:mini-dsh:v1.6b-entry`（选中 `enter-v1.6b`）——v1.6b 已进入；v1.6a 门槛就此关闭。
