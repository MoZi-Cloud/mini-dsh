# mini-DSH v1.6d 完成报告

[English](fork-mini-DSH-v1.6d-completion-report.md) | 中文

日期 2026-09-20；验收基线为引入本报告的这一批提交（首个版本见 `git log --follow` 对本文件；不写死 hash 以免文档随 rebase 腐化）。依据：`fork-mini-DSH改造方案-v1.6a.md` 分级路线 §1 的「v1.6d — Multi-Agent Collaboration」族，2026-09-20 经 §33 go 门进入，并记录为 decisions 域的第二次门使用（`dr:mini-dsh:v1.6d-entry` 解决选择 `enter-v1.6d-stage-a`，decision `dc:dr:mini-dsh:v1.6d-entry:147`，事件 146–147）；范围来自 `docs/mini/v1.6d/fork-mini-DSH-v1.6d-collaboration-scope-proposal.md` 提出的两阶段最小切片；表布局改编自 v1.6 蓝图附件（`docs/mini/HISTORY/fork-mini-DSH-v1.6-SQLite数据库架构附件.md` §18 assignments、§21 scope reservations、§28 handoffs、§29 collaboration conflicts）；`fork-mini-DSH-v1.6d.plan.yaml` 的五个账本工作项全部完成——三个阶段 A 项在版本 1，两个阶段 B 项在接替的版本 2。

## 版本与工件

- schema version：`PROJECT_LEDGER_SCHEMA_VERSION = 9`——九条冻结的相邻步骤（0→1→…→9，每步一个 `BEGIN IMMEDIATE` 事务）；v1.6d 新增其中四条（5→6 assignments、6→7 handoffs、7→8 reservations、8→9 conflicts）。已提交的 v1 fixture 保持戳 1 并仍是常备升级探针：每个已提交代次都在副本上经全部 shipped 步骤打开，行无损。
- event format version：`PROJECT_EVENT_FORMAT_VERSION = 9`；词表为 31 个 required 事件——v1.6b 为止的 24 个类型加七个 v1.6d 新增（`work/assigned`、`handoff/recorded`、`scope/reserved`、`scope/released`、`scope/expired`、`conflict/recorded`、`conflict/resolved`），每个都有载荷校验与 replay applier。解码器只拒绝戳记比本构建更新的行（`this build reads up to format 9`），因此 1–9 混合戳的时间线可干净解码。
- 表（27）：v1.6b 为止的 23 张表加 `work_assignments`、`handoffs`、`scope_reservations`、`collaboration_conflicts`。
- 随新表新增的索引：部分唯一索引 `uq_one_live_primary_per_work(work_item_id) WHERE status = 'ACTIVE' AND assignment_kind = 'PRIMARY'`、`idx_work_assignments_item`、`idx_work_assignments_actor`；`idx_handoffs_item`；蓝图原样的 `idx_scope_active`、部分唯一索引 `uq_one_active_reservation_per_scope(project_id, scope_kind, scope_value) WHERE status = 'ACTIVE'`、`idx_scope_reservation_expiry`；`idx_conflicts_item_a`。
- 改编逐域记录在模块文档与 Agent Note：v1.6b 的 actor 行把蓝图的 actor 字符串变成外键，v1.6d 每张表直接引用 `work_items`、`actors`（及可空处的 `roles`）；assignment、handoff、conflict 三表的 `project_id` 经工作项派生，reservation 表自持该列，因为范围唯一性谓词以它打头；内联文本替代 `*_content_id` 间接引用（handoff `summary`、conflict `description`）；`repo_snapshot_id` 被去除（无指涉物）；kind 词表收拢到消费者真正区分的程度——`assignment_kind` 一次收全六个值（扩 CHECK 要花一次迁移步骤）、`handoff_kind` 收为 `DELEGATE`/`RETURN`、`scope_kind` 收为 `PATH`、`conflict_kind` 收为 `SCOPE_OVERLAP`；蓝图 reservation 的 `mode` 列被去除——每条预留都排他，单合法值的列是噪音。
- 两条不变式是数据库事实，不只是接缝检查：每个工作项一条活跃 `PRIMARY` 指派、每个项目范围一条活跃预留——各自同时是部分唯一索引、接缝拒绝与 fold 检查。
- 阶段粒度有意偏离提案措辞：阶段 A 以两次迁移落地（先 assignments、后 handoffs），而非一步合并，避免任何表先于它的事件落地；偏离记录在计划 yaml 与 Agent Note。
- WorkPacket 格式未动（`WORK_PACKET_FORMAT_VERSION = 1`）：v1.6d 各域新增的是库接缝与只读视图，无 packet 面。

## 五个交付物

- **Work assignments（schema v6、format 6）**——§18 的职责行，把一个 actor（与可选 role）绑定到工作项。id `wa:<projectId>:<eventSequence>`；fold 拒绝每项第二条活跃 `PRIMARY`，与索引互为镜像。首行：`wa:mini-dsh:159`（lane，role `executor` 下的 `PRIMARY`）与 `wa:mini-dsh:160`（owner，`ACCOUNTABLE`）挂在 `PA-HANDOFF-RECORD-001` 上——事件 159–160，后续条目在其下工作的职责结构；`wa:mini-dsh:170` 为 claim-visibility 项重复同一形态。只读 `/project assignments`。
- **Handoffs（schema v7、format 7）**——§28 的追加式工作传递记录；恰好一个接收方（actor 或 role），由 CHECK、接缝与解码器三者同时强制；`handoff_kind` 收为 `DELEGATE`/`RETURN`；无存活扫描——记录只追加、永不移动。id `ho:<projectId>:<eventSequence>`。首行：`ho:mini-dsh:168`（lane 把 `PA-CLAIM-VISIBILITY-001` 委派给 role `executor`，artifact 引用钉住计划）与 `ho:mini-dsh:172`（`agent:second` 把同一项交还给 lane）——双向都有记录的传递。只读 `/project handoffs`。
- **Claim visibility（无 schema 变更）**——按 actor 协调的读取侧：todo 请求上的 `viewerIdentity` 滤掉其他身份持有活跃认领的条目，`project_work_next` 在自己的输入处解析调用 agent 的身份，无会话的列表保持 owner 式全队列。经 `PA-CLAIM-VISIBILITY-001` 上一次有记录的双 agent 传递演练：`actor:mini-dsh:agent:second` 注册（事件 169）并以 `worker_identity agent:second` 认领（租约 `ls:wi:mini-dsh:PA-CLAIM-VISIBILITY-001:171`），可见性快照显示被持条目对 lane 隐藏、对第二 agent 带标注可见，handoff `ho:mini-dsh:172` 传递该项，lane 认领回来（租约 174）并完成至 DONE。
- **Scope reservations（schema v8、format 8）**——§21，一个 actor 工作期间对项目范围的排他持有。生命周期完整镜像工作租约：`reserveScope` 在事务内使过期的 `ACTIVE` 持有者过期（死行会堵住部分唯一索引），`releaseScopeReservation` 释放范围并拒绝二次释放，`reapExpiredScopeReservations` 移走过期批次，且每次行移动都携带其必需事件。`expiresAtMs` 由调用方命名且必须在未来；不存在默认 TTL。id `sr:<projectId>:<eventSequence>`。首行：`sr:mini-dsh:194`（lane 预留 `packages/experimental/project-ledger`）与 `sr:mini-dsh:195`（`agent:second` 预留 `packages/experimental/mini-profile`），均 ACTIVE；对已持有范围的第三次预留被拒绝并点名持有者。只读 `/project reservations`。
- **Collaboration conflicts（schema v9、format 9）**——§29，对两条范围仍然相撞的工作项的记录，由一个 actor 提出。`conflict_kind` 收为 `SCOPE_OVERLAP`——等值预留检查判不了的那一种包含重叠。解决不是自由文本：`resolveConflict` 要求同项目的一条已记录 decision（经 decision request 连接，因为 decisions 表无项目列），并拒绝二次解决；不存在 reopen 写入者。id `cf:<projectId>:<eventSequence>`。首行：`cf:mini-dsh:203`，介于 `SB-SCOPE-RESERVATION-001` 与 `SB-CONFLICT-RECORD-001` 之间，由 `agent:second` 提出，保持 OPEN——两条预留守住、第三次同值尝试被拒、嵌套路径本会漏掉的那次诚实擦边；其解决留给 owner。只读 `/project conflicts`。

## 混合戳就地折叠

持久账本（`~/.dsh/project-ledger/ledger.sqlite`）在每个增量首次打开时就地迁移 schema 5→6→7→8→9，现在把九戳时间线折叠干净：203 个事件中 97 个 format-1 + 19 个 format-2 + 2 个 format-3 + 14 个 format-4 + 15 个 format-5 + 13 个 format-6 + 22 个 format-7 + 13 个 format-8 + 8 个 format-9，每个戳对其写入表面如实。每个增量后 replay 审计与 doctor 均 0 drift、0 issues；重建表面上的幂等重跑以零工具调用通过。

## Plan supersede 与阶段 B 门

阶段 B 经 decisions 域的第三次门使用进入——`dr:mini-dsh:v1.6d-stage-b` 解决选择 `enter-v1.6d-stage-b`，事件 181–182，且只在阶段 A 以三项全 DONE 加时间线中的双 agent 传递收拢之后才记录——并经 §22 接替路径落地：版本 1（其三个阶段 A 项 DONE）冻结，版本 2 以绝不重列版本 1 项的两个阶段 B 稳定键激活。计划文档在版本 2 之后从未改动，因此最后一次运行的导入是幂等的，版本 2 即现役版本。五个项全部 DONE，各在 lane 的认领下经自己的存储 verifier 完成（`pnpm exec vitest run project-ledger project-ledger-sqlite mini-profile`，exit 0）——且 `PA-CLAIM-VISIBILITY-001` 的租约史在 lane 之外还记录了第二 agent 的认领与释放。

## 4K benchmark

每个增量后 `./benchmarks/context-light/run-4k.sh` exit 0：6 个模型请求，最大估算 2,444/4,096 tokens（含 512 预留输出），context overflow 0；无 BOOT/4K 回归。§33 状态计数停在 35 项（v1.6a 的 15 个黄金计划项加真实使用记录的二十项），分跨 22 条 real-use-log 条目，其中第 17、20 条是 v1.6d 的两次门确认——记录为 decision、无计划项。

## 聚焦回归与仓库门

三个 experimental 包共 376 个测试全绿（五个交付物间 318 → 330 → 342 → 345 → 362 → 376 递增）；经 CI 门调用做 per-file 100% 覆盖率；oxlint 0/0；duplication 维持既有两克隆基线（无新克隆）；所有编辑过的双语对重新记录 pairing；doc 门与 hygiene 绿。上游核心包零改动——交付物是 ledger/profile 追加，`bridges.spec` 仍钉住结构性解耦。

## v1.6d 有意不写的部分

保留状态保持 CHECK 合法且无写入者：指派结束（`ENDED` 与 `accepted_at_ms`/`completed_at_ms`）与 handoff 接受（`accepted_at_ms`）等接受/完成流程的消费者出现再落，已记录在 README 限制区（`REVOKED` 租约先例）。一个 conflict 恰好经 owner 脚本直接调用的库接缝解决一次——`/project conflicts` 渲染 OPEN 行但不做解决，也不存在 reopen 写入者；`conflict_kind` 在真实的第二种重叠类别出现时以一次 CHECK 迁移扩展，与 `scope_kind` 留下的路径相同。owner 面保持只读：`/project` 视图只渲染事实；assignment、handoff、reservation、conflict 写入是 owner 脚本直接调用的库接缝。预留活得恰好与调用方所说一样长——`expiresAtMs` 无默认 TTL，过期只经发出事件的写入者移动行。

## 位置

v1.6d 协作范围完成：职责已指派、传递已记录、认领按 actor 可见、范围排他预留、漏掉的撞界作为冲突立于账本等待 owner 决定——多 agent 切片端到端运行在账本事实之上。v1.6c（Function Contract）按提案维持 research-gated。仍开放的是 owner 的：解决 `cf:mini-dsh:203`，以及经既定 go-gate 的任何后续指向。
