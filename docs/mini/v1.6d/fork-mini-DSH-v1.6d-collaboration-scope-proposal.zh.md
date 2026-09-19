# mini-DSH v1.6d 范围提案：多 Agent 协作

[English](fork-mini-DSH-v1.6d-collaboration-scope-proposal.md) | 中文

日期 2026-09-19。本文是 v1.6b 收尾门点名的 v1.6d 前置物：一份范围拆解与最小协作切片提案，供 owner 评审；不随文交付任何实现，进入决策仍由 owner 经 §33 门作出。依据：`fork-mini-DSH改造方案-v1.6a.md` 分级路线 §1 的 "v1.6d — Multi-Agent Project Collaboration" 家族，以及 v1.6 SQLite 架构附件（`docs/mini/HISTORY/fork-mini-DSH-v1.6-SQLite数据库架构附件.md`）的 §18 assignments、§21 scope_reservations、§28 handoffs、§29 collaboration_conflicts、§46–48 投影。v1.6c（Function Contract）保持 research-gated，本文不涉及。

## 已经就位的部分

- **Actor、role、角色指派**（v1.6b，schema 5）：`actors`（`HUMAN`/`AGENT`/`SERVICE`/`SYSTEM`）、`roles`（`GOVERNANCE`/`EXECUTION`）与 `actor_roles`——每对 actor-role 一条活跃指派是数据库事实。账本自己的班底已注册：`actor:mini-dsh:owner`（HUMAN）与 `actor:mini-dsh:agent:mini-real-use-lane`（AGENT）。
- **租约已点名持有人**（v1.6a）：`work_leases.worker_identity` 携带 actor 字符串，每个工作项一条 `ACTIVE` 租约；至今每条真实领取记录都指向同一个 lane。
- **decisions 域**（v1.6b）是冲突可以指向的裁决记录——蓝图 §29 的 `resolution_decision_id` 已有活的指向物。
- **投影**（v1.6a）：带类型化 blocker 的 `computeWorkReadiness`、按 `executor_kind` 分区的 `listOwnerTodo`/`listAgentTodo`——一个单 Agent 现实的调度投影：所有条目由同一个 agent 领取。

## "assignments" 一词指两张不同的表

§1 家族行 "actors / roles / assignments" 读起来像已交付一半，而这一半必须分清：v1.6b 交付的是项目级 `actor_roles`（谁在项目里持哪个角色），不是蓝图 §18 `assignments`（谁在某工作项上担哪份职责，`assignment_kind` 为 primary/collaborator/reviewer/tester/observer/accountable）。本提案把 "assignments" 仅用于 §18，两表保持不同；中文以 角色指派（actor_roles）与 工作指派（§18）区分。

## 范围拆解

- **工作指派（§18）**：家族行中缺的那块——一个 actor 在一个条目上的职责。适配遵循既有模式：项目级键、actor 字符串代替 actor id、kind/status 值大写；`assignment_kind` 需要闭合词表，留给 owner 的问题是全收蓝图六值还是从更小起步。
- **交接（§28）**：一个条目在 actor 之间一次有记录的传递——`from_actor`、`to_actor` 或 `to_role`、内联摘要文本代替 `summary_content_id`、artifact 与 memory 引用作为解析接缝处的 JSON 对象。接受是自然的第二个事件；若无消费者随行，未接受状态可保持 CHECK 合法且无写入者（`REVOKED` 租约先例）。
- **范围预留（§21）**：跨条目持有某个范围（`scope_kind`/`scope_value`）——租约不覆盖的那块：租约拥有一个条目的执行，预留把其他条目的 agent 挡在范围之外。蓝图原名 `idx_scope_active` 原样交付。
- **协作冲突（§29）**：从预留缝隙漏出来的部分——一个 `conflict_kind`、两个条目，裁决作为一条 decision 记入 v1.6b 的 decisions 域。
- **调度投影**：不新增权威——readiness 保持计算所得、todo 视图保持不变；变化是按 actor 的领取可见性，第二个 agent 看得到队列，看不到另一个 agent 的活跃领取。

## v1.6d 有意排除的部分

- **蓝图 §30/§31 workflow 表**：§1 的裁决继续成立——DSH workflow/subagent 仍是执行引擎，把 workflow 定义与运行记录进项目 DB 等于复制第二套 workflow 权威。workflow 包零改动（v1.6a §32 DoD 项继续成立）。
- **`work_attempts`（§19）**：尝试历史已由事件时间线与租约生命周期承载；第二套记录只会在没有消费者的情况下追加 parity 义务。
- **v1.6c 的表**（function contracts、parameters、planned call edges、bindings）：按提案保持 research-gated，不在本文范围内。

## 最小协作切片——两阶段

- **阶段 A，顺序协作**：工作指派 + 交接 + 按 actor 的领取可见性。第二个 `AGENT` actor 注册；一个工作项经一次有记录的交接在两个 agent 之间传递。领取互不重叠，暂不需要冲突面。一次追加迁移（schema 5→6）与一次事件格式升版（5→6）承载本阶段事件。
- **阶段 B，并行协作**：范围预留 + 协作冲突。两个 agent 领取重叠范围；预留挡住重叠，冲突记录漏网部分，裁决落入 decisions 域。再一次追加迁移（6→7）与格式升版（6→7）。
- 分阶段的理由：每个阶段是一次自带 §33 式证据的真实 lane 运行；阶段 A 的交接行正是阶段 B 的冲突所需的原料；四表一批会把两种风险画像捆在一起。若 owner 宁可一次进入决策，单批方案也可行。

## 继承的结构约束

- schema 5、五个冻结相邻步骤：每个阶段恰好追加一步、各自一次 `BEGIN IMMEDIATE`；入库的 v1 fixtures 继续充当常备升级探针；持久时间线（145 事件、戳 1–5）继续可解码。
- format 5、24 个 required 事件类型：每阶段事件带 payload 校验、replay applier，并在两个 sweep（`readProjectReplay` 与 doctor）中双向 parity；解码器继续只拒绝比构建更新的戳。
- 无消费者随行的预留状态保持 CHECK 合法且无写入者（未接受的交接、已结束的工作指派）。
- owner 面保持只读：`/project` 视图扩展；写入是 owner 脚本直接调用的库接缝。
- 4K 确定性门按 agent 成立：两个 agent 是两个上下文，各自在 4,096 token 预算内——不是一个翻倍的预算。

## 进入门

§33 原样适用：进入依据必须来自账本中的真实使用记录，不凭"设计看起来完整"。今日记录：账本内 30 个完成工作项（15 黄金计划 + 15 真实使用），至今每次 lane 运行无 BOOT/4K 回归，v1.6b 完成报告已验收。进入决策本身可以是 decisions 域的第二次门用途——一条 `decision/requested` 由 owner 裁决，如同 `dr:mini-dsh:v1.6b-entry` 开启 v1.6b 那样。留给 owner 的开放问题：阶段顺序（先 A 后 B，还是一批）、`assignment_kind` 词表大小、第二 agent 的 actor 命名（`actor:mini-dsh:agent:<lane>` 模式已在）、以及阶段 B 的 `conflict_kind` 在进入时闭合还是留到阶段 B 的计划。
