# mini-DSH v1.7 代码改进计划

[English](fork-mini-DSH-v1.7-improvement-plan.md) | 中文

日期 2026-09-21。本计划把[评审及改进建议 v1.1](../评审及改进建议.zh.md)中采纳并修正后的建议落成分阶段修复系列：先修两个 P0，再补受支持入口，最后收敛证据与维护。依据：评审的[分阶段实施建议](../评审及改进建议.zh.md#phased-proposal)与[验收矩阵](../评审及改进建议.zh.md#acceptance-matrix)（A-01–A-14）、[v1.6a 提案](../v1.6a/fork-mini-DSH改造方案-v1.6a.md) §8 与 §18、[v1.6d 完成报告](../v1.6d/fork-mini-DSH-v1.6d-completion-report.zh.md)。v1.6c 保持 research-gated；v1.7 是评审最终判断要求在任何新领域之前完成的修复系列。

## 依据与采纳结论

- **采纳**：F-01 与 F-02（P0）、F-03 与 F-04（P1）、F-05、F-07、F-08（P2）。F-06 维持决策项：v1.6d 已按收窄范围交付协作记录与认领可见性，调度约束保持案例驱动（评审的阶段 D，此处不排期）。
- **F-01 归类修正**：v1.6a BOOT 验收已披露这一推迟（"账本只存命令"），因此不可信验收是已披露的范围推迟而非隐藏偏差；其 P0 优先级与修复内容不变。
- **F-05 校准后采纳**：experimental 各包在任何地方都不执行命令；采纳点是新操作——激活、受信验证、原子汇报——由一个 typed service 拥有者收口，而不是为理论上的 provider 可替换性重写。
- **最低修复必须携带的落地成本条款**：`plan/version-superseded` 折叠接管接替写入者拥有的生命周期列；持久账本现无任何激活事件，生命周期 parity 须先为现役版本补录；各写入接缝各自拥有事务且 `BEGIN IMMEDIATE` 不可嵌套，原子汇报需要事务作用域的核心变体；owner 命令需要 session-agent→ledger-actor 的身份映射。
- **无 schema 迁移**：`plan_versions` 已带 `activated_at_ms` 与 `superseded_at_ms`；阶段 A 升事件格式（9→10），`PROJECT_LEDGER_SCHEMA_VERSION` 停在 9。

## 目标与退出条件

- **阶段 A——结果真实性与版本权威**：伪造 PASS 不能使工作 DONE；每个 ACTIVE 版本可追溯到一条合法激活事件；回放与 doctor 能发现对生命周期列的直接篡改（A-01–A-08）。
- **阶段 B——受支持入口与中断语义**：新用户仅凭 `dsh --profile mini` 即可建立第一个 READY 工作项（A-09）；每次被中断的汇报都有确定、经测试的恢复结果（A-10）。
- **阶段 C——证据与维护收敛**：required 事件注册时缺 decoder 或 fold policy 即失败（A-13）；deterministic 4K 挂载 shipped 工具，或只作为 payload 预算证据（A-11、A-12）；产品价值结论不再依赖自举任务；README 与包描述陈述当前行为。
- 阶段按序执行，各为一个独立 gated 工作包；阶段的退出条件从 keyed 验证主张，不单凭 keyless 实现增量。

## 阶段 A——恢复结果真实性与版本权威

- **A1，激活生命周期（F-02；A-06、A-07、A-08）**：`activatePlanVersion` 在一个 `BEGIN IMMEDIATE` 内校验 DRAFT 状态、每计划至多一个 ACTIVE 版本的约束与干净的导入诊断，写入 status、`activated_at_ms` 与 `plans.current_version_id`，并追加严格的 `plan/version-activated` 事件。事件补 payload decoder；未知版本、重复激活、非法迁移一律失败关闭。折叠纳入版本 status、两个生命周期时间戳与 current pointer，supersede 折叠同步接管其生命周期列。接替加激活保持两操作形态，无 ACTIVE 的中间态对调用者成文；原子性保证附着在每个操作上。
- **A2，历史连续性与 benchmark 迁移（持久账本上的 A-08）**：持久时间线现含 9 条 `plan/imported`、6 条 `plan/version-superseded`、零条激活事件——至今每个版本都由 owner 直接 SQL 激活。生命周期 parity 因此恰好为三个现役版本补录（format 10，追记性质在 real-use log 披露）：追加式时间线里，补录的激活不可能先于已记录的接替，六个已接替版本按时间线已有记录原样折叠。补录后 replay 读出 0 drift、doctor 0 issues。context-light 与 real-use worker 经正式操作激活与接替——淘汰 context-light worker 无条件的 `UPDATE plan_versions SET status = 'ACTIVE'`——其 verifier verdict 改经 A3 核心计算。
- **A3，受信 verifier consumer（F-01；A-01–A-05）**：账本内的受信评价核心由存储 spec 加记录在案的执行事实计算可执行 criterion 的 verdict，核对实际退出码与 `expected_exit_code`；`sandbox_required` 为真而事实缺失、被拒或 runner 失败时失败关闭。mini profile 的汇报路径在持有 agent 的开放 turn 内自行经 harness shell 执行 COMMAND/TEST，`approval_required` 为真时调用运行时 `ctx.approval`；调用方传入的 `result` 不再决定可执行 criterion，裸汇报把该主张记为 reported-evaluation 历史而不动投影。SQL_ASSERTION 与 GRAPH_ASSERTION 保持不可自动完成；OWNER_CONFIRMATION 仅限 owner。执行事实进入评价事件，保持 model-visible ⟺ logged；reported evaluation 仍是一条有名有实的独立写入路径。

## 阶段 B——受支持入口与中断语义

- **Owner import/activate/supersede（F-03；A-09）**：owner 专属的 `/project import <plan-path>`、`/project activate <version>` 与 `/project supersede` 调用阶段 A 的同一批操作——import 只解析、校验并写入 DRAFT；activate 展示诊断、baseline 与目标版本。每个入口经本阶段定义的 session-agent→owner 映射点名自己的 ledger actor。
- **汇报提交语义（F-04；A-10）**：执行器在事务外完成，随后一个操作在单个 `BEGIN IMMEDIATE` 内提交全部评价、工作状态与租约收尾；保留逐步提交之处以 operation id 与显式阶段使重试幂等。故障注入覆盖每个写点；因现有接缝各自拥有事务，事务作用域核心变体先行落地。
- **Typed service 收口（F-05）**：阶段 A 与阶段 B 的操作成为 SQLite provider 之上的 `ProjectLedger` service 方法；没有第二消费者或事务所有权需求的只读函数保持库 API。

## 阶段 C——证据与维护收敛

- **注册表强制的事件组织（F-08；A-13）**：注册 required 事件类型必须在注册点同时给出 decoder 与 fold policy；`readProjectReplay` 成为投影 parity 的唯一拥有者，doctor 负责把漂移转为 issue 并只追加回放无法表达的运行健康检查。
- **证据纪律（F-07；A-11、A-12）**：deterministic 4K 挂载 shipped mini-profile 工具，或只作为 payload 预算证据；启发式估算与 provider 上报用量分开标注；live-model 对照在非 ledger 仓库任务上运行，记录成功率、token、重试与人工介入。
- **当前状态文档**：README 与包描述陈述当前行为——project-ledger 的限制条目、SQLite 的迁移说明、包描述停止描述 v1.6a 时代的事实。

## v1.7 有意排除的部分

- **阶段 D 调度约束（F-06；A-14）**：按 assignment 授权领取、交接转移领取权、PATH 重叠强制、冲突入 blocker，全部保持由两个独立 Agent session 的真实案例驱动；v1.6d 已记录的各域维持纯记录语义。
- **v1.6c（Function Contract）**：research-gated，不触及。
- **版本化 plan 源文档与内容寻址工件**：source hash、路径与 Git 历史继续作为证据组合，除非审计必须脱离仓库历史独立还原旧输入。
- **独立 durable-receipt 实体**：既有评价与事件已承载事实；新实体等跨 session 审计需求真实出现再议。

## 验证模式与进入门

- **Keyless 增量**运行聚焦单测、typecheck、文档门，并经构建后库的 owner 接缝完成记账（计划导入、门决策、补录）。**Keyed 运行**拥有经 shipped 工具的 lane 认领/汇报与 live-4K 重跑；阶段的退出条件从这些运行主张。
- **进入门**：`dr:mini-dsh:v1.7-entry` 经 decisions 域的 shipped 接缝开启，循 `dr:mini-dsh:v1.6b-entry` 与 `dr:mini-dsh:v1.6d-entry` 先例；选项为 `enter-v1.7-stage-a`（推荐）、`enter-v1.7-stages-a-and-b`、`hold-until-keyed-run`。owner 对本计划的 go 即把门裁决为 `enter-v1.7-stage-a`；阶段 B 与阶段 C 各等自己的门。
