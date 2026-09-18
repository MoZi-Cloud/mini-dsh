# mini-DSH v1.6a BOOT 验收报告

[English](fork-mini-DSH-v1.6a-BOOT-acceptance.md) | 中文

日期 2026-09-18；验收基线为引入本报告的这一批提交（首个版本见 `git log --follow` 对本文件；不写死 hash 以免文档随 rebase 腐化）。依据：`fork-mini-DSH改造方案-v1.6a.md` §29 BOOT 清单、§32 DoD、§34 最终报告要求；黄金计划 `fork-mini-DSH-v1.6a.plan.yaml` 的 15 个工作项全部完成。

## 版本与工件

- pinned SHA：以本报告首次入库的提交为准（`git log --reverse -- docs/mini/v1.6a/fork-mini-DSH-v1.6a-BOOT-acceptance.zh.md` 的首条）；W01–W12 各工作项的交付提交见各 Agent Note。
- schema version：`PROJECT_LEDGER_SCHEMA_VERSION = 1`（SQLite `user_version`，单调、mismatch fail closed，见 `dsh-experimental-project-ledger-sqlite`）。
- event format version：`PROJECT_EVENT_FORMAT_VERSION = 1`；v1 词表 14 个 required 事件全部有读取/重放语义（其中 `plan/version-superseded`、`baseline/drift-detected` 为校验型 applier）。
- packet format version：`WORK_PACKET_FORMAT_VERSION = 1`，builder version `1`。
- 表（13）：plans、plan_versions、phases、work_items、work_item_relations、work_external_blockers、acceptance_criteria、verification_specs、acceptance_evaluations、project_events、plan_imports、plan_compile_diagnostics、work_leases。
- 索引：plan_versions(plan,status)、work_items 三枚（ready/phase/parent）、relations 双向、external blockers、evaluations、project_events(project,type,seq)、compile diagnostics、`uq_one_active_lease_per_work` 部分唯一索引、lease expiry。
- 迁移 fixture：`schema.spec.ts` 的相邻迁移/拒绝降级测试，加上 `fixtures/project-ledger/v1.6a-empty.db`（空库探针）与 `v1.6a-populated.db`（黄金导入 + 三个真实 DONE，28 事件，doctor 0 issues）；由 `scripts/gen-project-ledger-fixtures.ts` 以固定时间戳再生。

## BOOT-01..08

- BOOT-01 golden import + doctor = 0 errors：`tests/doctor.spec.ts`（F05 `planDoctor` 本批实现；黄金导入前后均 0 issues，真实工作环后仍 0）；populated fixture 生成时 doctor 通过。
- BOOT-02 Fresh Agent 不读 Master Plan：`benchmarks/context-light` 确定性车道——脚本化 agent 的每一步（工作项 id、verifier 命令）都从会话中的 WorkPacket 提取，plan 文档不进入模型上下文；`work-packet.spec.ts` 另证重开数据库可凭配方重建 packet。
- BOOT-03 Owner/Agent 查询分离：`tests/todo-views.spec.ts`（listOwnerTodo/listAgentTodo 按 executor_kind 互斥、有序、携带 readiness 与活跃租约）。
- BOOT-04 replay == 物化投影：`events/readiness/acceptance/lease/work-packet/versioning` 各 spec 的 materializedProjection 对等断言，外加 doctor 的 projection-drift 检查（含对 raw 越权写的发现）。
- BOOT-05 未知 schema 字段/enum/verifier 形态 fail closed：`tests/plan-schema.spec.ts`（宪法镜像 parity、unknown field/enum/verifier 拒绝）与 `tests/import.spec.ts`。
- BOOT-06 并发 claim 唯一 lease、过期安全回收：`tests/lease.spec.ts`（BEGIN IMMEDIATE 锁边界双连接测试、部分唯一索引兜底、reaper 有界批次且绝不宣布 FAILED）。
- BOOT-07 WorkPacket hash 重建一致：`tests/work-packet.spec.ts`（文件账本重开、仅凭 DB + packetId 重建，hash 与记录一致；漂移逐引用点名）。
- BOOT-08 supersede 历史不变：`tests/versioning.spec.ts`（版本可查询、新认领停止、活跃尝试落 BLOCKED 待 review、评估逐字节保留、baseline 钉不被改写）。

## 4K benchmark（AC-4K-001）

`./benchmarks/context-light/run-4k.sh` exit 0：确定性车道 6 个模型请求，最大估算 2,308 tokens（预算 4,096，含 512 预留输出；换算 4 字符/token），WorkPacket 序列化 2,301 字节，5 个工具各一次，verifier 子进程 exit 0，工作项 DONE、标准 PASSING、重放投影一致；context overflow = 0（超预算即抛错，本运行零触发）。live 车道（DSH_4K_LIVE=1 + DEEPSEEK_API_KEY）以 provider usage 为最终裁决；本环境无 key，按仓库 real-API 政策自跳过。

## WorkPacket token/context 拆分

峰值请求 7,184 字节 ≈ 1,796 估算 tokens + 512 预留 = 2,308：由 persona（5 行）、5 个工具 schema、WorkPacket（2,301 字节 ≈ 575 tokens）与逐轮累积的工具结果构成；首请求 949 tokens，增量主要来自工具结果与历史。4K 预算内余量约 1,788 tokens。

## plan-mode / todo 边界与桥接结果

不自动把 plan-mode 状态同步为项目计划，也不把 session todo 当项目身份（§5）。`tests/bridges.spec.ts` 钉住结构性解耦：agent-loop、agent、plan-mode、tool-todo 均不依赖 ledger，ledger 不依赖 harness 运行时。§5.3 的 `todo completed != project work item done` 由账本强制：`acceptance-not-passed` 门使 DONE 只能经 VERIFYING 且 required 标准全数 PASSING/WAIVED。可选的「packet 局部步骤投影到 session todo」桥接未实施，属未来集成。

## 应用入口门

`pnpm run verify-application-entrypoints` 绿：dsh 是唯一受支持 Node 应用启动入口；产品形态为 `dsh --profile mini`（经 `dsh plugin --profile mini add @deepseek-ai/dsh-experimental-mini-profile` 挂载，W08 的隔离合规设计），无任何包 bin。

## 聚焦回归与仓库门

三个 experimental 包共 215 个测试全绿（ledger 186 + sqlite 24 + mini-profile 5）；per-file 100% 覆盖率；全量 typecheck 绿；hygiene 16/16；`test:docs` 20/20；duplication 仅 2 个既有 clone。上游核心包零改动：W05–W12 未触碰 `packages/core/agent-loop` 等任何 core 实现（bridges.spec 结构性钉住）。

## §32 DoD 核对

已满足且各有 verifier/证据：前置入仓（PRE-001 verifier PASS；v1.6 设计史在 `docs/mini/HISTORY/`，v1.4/v1.5 无代码且 v1.6a 不假设其存在）、无独立 bin、profile 唯一形态、strict schema fail closed、verifier 判别联合、import 与 activation 分离（激活为 owner 接缝，尚无写入者）、边界测试、`user_version` 单调 + fail closed、相邻迁移 fixture、事件格式版本 + ignorable 语义、replay 对等、层级/依赖分离、环检测、评估 append-only、verifier 执行不绕过 shell/sandbox（账本只存命令，4K 切片经真实子进程执行）、lease 闭环、WorkPacket 不变量、4K 门存在且通过、BOOT-01..08 全绿、context overflow = 0、不修改 core agent loop、未伪装 Function Contract 机械事实（v1.6c 推迟，未声称 effects/call-prohibit 可机械判定）、未复制第二套 workflow 权威状态机（workflow 包零改动）。

## v1.6b/c/d 进入门（§33）

协议要求「真实 mini-DSH 开发连续使用 ≥ N 个 work items、BOOT/4K 无回归、Owner 确认价值」。当前真实使用记录为一次钉住的 4K 切片（脚本化车道 + 可选 live 车道）与黄金计划本身的执行历史；N 由 Owner 决定，进入决策留待 Owner 基于账本中的真实使用记录作出。
