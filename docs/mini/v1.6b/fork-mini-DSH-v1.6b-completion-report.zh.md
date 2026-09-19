# mini-DSH v1.6b 完成报告

[English](fork-mini-DSH-v1.6b-completion-report.md) | 中文

日期 2026-09-19；验收基线为引入本报告的这一批提交（首个版本见 `git log --follow` 对本文件；不写死 hash 以免文档随 rebase 腐化）。依据：`fork-mini-DSH改造方案-v1.6a.md` 分级路线 §1 的「v1.6b — Owner / Decision / Resource Domain」族，2026-09-19 经 §33 进入门进入；表布局改编自 v1.6 蓝图附件（`docs/mini/HISTORY/fork-mini-DSH-v1.6-SQLite数据库架构附件.md` §22/§23 decisions、§24 approvals、§25–27 resources、§3/§4 actors/roles）；`fork-mini-DSH-v1.6b.plan.yaml` 的四个账本工作项全部完成——decisions 与 approvals 在计划版本 1，resources 与 actors 在接替的版本 2。

## 版本与工件

- schema version：`PROJECT_LEDGER_SCHEMA_VERSION = 5`——五条冻结的相邻步骤（0→1→…→5，每步一个 `BEGIN IMMEDIATE` 事务）；v1 fixture `v1.6a-empty.db`/`v1.6a-populated.db` 保持戳 1 并成为常备升级探针：每个已提交代次都在副本上经全部 shipped 步骤打开，行无损。
- event format version：`PROJECT_EVENT_FORMAT_VERSION = 5`；词表为 24 个 required 事件——14 个 v1 类型加十个 v1.6b 新增（`decision/requested`、`decision/recorded`、`approval/requested`、`approval/decided`、`resource/required`、`resource/provided`、`resource/verified`、`actor/registered`、`role/defined`、`role/assigned`），每个都有载荷校验与 replay applier。解码器只拒绝戳记比本构建更新的行（`this build reads up to format 5`），因此 1–5 混合戳的时间线可干净解码。
- 表（23）：13 张 v1 表加 `decision_requests`、`decision_options`、`decisions`、`approvals`、`resource_requirements`、`resource_instances`、`resource_verifications`、`actors`、`roles`、`actor_roles`。
- 随新表新增的索引：`idx_decision_requests_project`；`idx_approvals_project`、`idx_approvals_subject`；`idx_resource_requirements_project`、`idx_resource_instances_requirement`、`idx_resource_verifications_instance`；`idx_actors_project_kind`（蓝图原名，未改）、`idx_actor_roles_actor`，以及部分唯一索引 `uq_one_live_assignment_per_pair(actor_id, role_id) WHERE valid_to_ms IS NULL`——每对 actor-role 一条活跃指派是数据库事实，不只是接缝检查。
- 改编逐域记录在模块文档与 Agent Note：项目内 `UNIQUE` 键替代蓝图的 plan-version 作用域或可空 UNIQUE 习语、内联文本替代 `content_id` 间接引用、actor 字符串替代 actor id、kind/status 值按账本惯例大写、新增一列 `actors.actor_key` 恰好承载其他域已在记录的字符串、`roles.role_kind` 收拢为 `GOVERNANCE`/`EXECUTION`（蓝图标 NOT NULL 但未赋值）。
- WorkPacket 格式未动（`WORK_PACKET_FORMAT_VERSION = 1`）：v1.6b 各域新增的是库接缝与只读视图，无 packet 面。

## 四个域

- **Decisions（schema v2、format 2）**——`dr:<projectId>:<decisionKey>` 按身份，`do:`/`dc:` 请求作用域派生；`BLOCKING`/`ADVISORY` 级别；`UNIQUE(decision_request_id)` 使一个 decision 只解决一个 request。写入接缝与 replay fold 都拒绝重复项目键、外项目计划引用、重复 option 键、两个 recommended、二次解决；对等在 `readProjectReplay` 与 doctor 双向运行。首行：§33 进入确认本身——`dr:mini-dsh:v1.6b-entry` 由 `owner` 选 `enter-v1.6b` 于事件 109 解决，打开本域的门即本域的第一行。只读 `/project decisions`。
- **Approvals（schema v3、format 3）**——一张 `approvals` 表挂在类型化 subject 上（`plan-version`/`work-item`/`decision`，写入时校验同项目、fold 内要求存在），`required_role`/`requested_by`/`decided_by` actor 字符串、内联决定文本；三条 CHECK 把决定列与非 PENDING 状态全有或全无地耦合，读取形态将其作为一组返回，且一个 approval 只决定一次。按蓝图的一行裁定与 decisions 分表。id `ap:<projectId>:<eventSequence>`。首行：`ap:mini-dsh:117` 挂在 v1.6b 计划版本上（要求 `owner` 角色）于事件 117–118 决定 APPROVED。只读 `/project approvals`。
- **Resources（schema v4、format 4）**——项目开启需求，实例只服务 OPEN 需求，每次验证按存储 spec 记录 PASS/FAIL；`constraintsJson`/`metadataJson`/`observedJson` 必须在解析接缝解析为 JSON 对象；verifier spec 是存储数据，绝不执行；复验合法且每次验证有自己的时间线派生行。verifier-kind 词表由事件编解码器持有为 `ResourceVerifierKind`（cordis catalog 重名教训）。首行：需求 `rr:mini-dsh:persistent-ledger` 与实例 `ri:mini-dsh:131`——账本文件本身——以刚把整条时间线折叠干净的重放审计验证 PASS。只读 `/project resources`。
- **Actors/roles（schema v5、format 5）**——actors（`HUMAN`/`AGENT`/`SERVICE`/`SYSTEM`）、roles（`GOVERNANCE`/`EXECUTION`）与带 `valid_from_ms` 的指派；id `actor:`/`role:` 按身份、`asg:` 按时间线派生，因为未来的结束写入者必须允许再指派。fold 把每条指派经重放的 actors 与 roles 解析，并拒绝每对的第二条活跃指派，与索引互为镜像。首行：账本自己的班底——`actor:mini-dsh:owner`（HUMAN，go 门的持有人）与 `actor:mini-dsh:agent:mini-real-use-lane`（AGENT，领取了每个条目的 lane），role `owner`（GOVERNANCE，approvals 域已指向的名字）与 `executor`（EXECUTION），指派为 `asg:mini-dsh:144`/`asg:mini-dsh:145`（事件 140–145）。只读 `/project actors`。

## 混合戳就地折叠

持久账本（`~/.dsh/project-ledger/ledger.sqlite`）在每个增量首次打开时就地迁移 schema 1→2→3→4→5，现在把五戳时间线折叠干净：145 个事件中 97 个 format-1 + 19 个 format-2 + 2 个 format-3 + 14 个 format-4 + 13 个 format-5，每个戳对其写入表面如实。每个增量后 replay 审计与 doctor 均 0 drift、0 issues；重建表面上的幂等重跑以零工具调用通过。

## Plan supersede 真实演练

v1.6b 计划（`mini-dsh-v16b-owner-decision`）在 resource 项落地时经 §22 路径接替了自己的版本 1：版本 1（其 decisions 与 approvals 项 DONE）冻结，版本 2 以全新稳定键激活、绝不重列版本 1 的项，后者仍记录在版本 1 下。四个项全部 DONE，各经自己的存储 verifier（`pnpm exec vitest run project-ledger project-ledger-sqlite mini-profile`，exit 0），认领者为 `agent:mini-real-use-lane`。

## 4K benchmark

每个增量后 `./benchmarks/context-light/run-4k.sh` exit 0：6 个模型请求，最大估算 2,444/4,096 tokens（含 512 预留输出），context overflow 0；无 BOOT/4K 回归——4K 门本身就是已完成的账本项（`PW-4K-GATE-001`，存储 verifier `run-4k.sh`），§33 状态计数停在 30 项（v1.6a 的 15 个黄金计划项加真实使用记录的十五项）。

## 聚焦回归与仓库门

三个 experimental 包共 318 个测试全绿（四个域间 269 → 287 → 302 → 318 递增）；经 CI 门调用做 per-file 100% 覆盖率；oxlint 0/0；duplication 维持既有两克隆基线（无新克隆）；所有编辑过的双语对重新记录 pairing；doc 门与 hygiene 绿。上游核心包零改动——各域是 ledger/profile 追加，`bridges.spec` 仍钉住结构性解耦。

## v1.6b 有意不写的部分

保留状态保持 CHECK 合法且无写入者：`FULFILLED`/`CANCELLED` 需求、`RETIRED` 实例、`INACTIVE` actor、指派结束（`valid_to_ms`）等消费者出现再落，已记录在 README 限制区（`REVOKED` 租约先例）。owner 面保持只读：`/project` 视图只渲染事实；decision、approval、resource、actor/role 写入是 owner 脚本直接调用的库接缝。actor 列仍是自由字符串——typo 的 `decided_by` 仍可写入，`/project actors` 点名时间线真正认识的当事方。

## 通向 v1.6c/d 的位置

v1.6b 范围完成：decisions、approvals、resources、actors/roles 全部作为账本记录的域立于其主体旁。v1.6c（Function Contract）按提案维持 research-gated；v1.6d（多智能体协作）会发现它的 actors、roles、assignments 已是一等行。两者都留待 owner 经既定 go-gate 决定。
