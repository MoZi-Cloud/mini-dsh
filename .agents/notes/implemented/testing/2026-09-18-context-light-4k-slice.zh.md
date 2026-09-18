# Agent Note: Context-Light 4K 切片

Status: implemented

[English](2026-09-18-context-light-4k-slice.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W12（REAL-4K-001，前置 PRE-002 的唯一标准就是本基准的定义入库）：钉住的 4K 基准必须在无上下文加宽的情况下成功退出（§3，AC-4K-001），且切片必须真实用 Project Ledger 推进一个任务——一个不读任何 plan 文档、只凭数据库与 WorkPacket 工作的全新 agent（BOOT-02）。`benchmarks/context-light/` 此前不存在，也没有任何组合曾在硬 4096-token 窗口下，用真实 agent 运行时驱动账本的完整工作环——todo、认领、packet、verifier 执行、评估、完成。

## 决策

`benchmarks/context-light/` 拥有该切片：`task-plan.yaml`（符合严格 schema 的 plan，钉住一个 IMPLEMENTATION 工作项，其 COMMAND verifier 是 `node --test test/math.test.mjs`）、fixture `workspace/`（一个 stub 模块加证明 stub 已被实现的钉住测试）、`run-4k.worker.ts`（harness）、专属 tsdown 配置，以及 `run-4k.sh` 入口（AC-4K-001 的 verifier 命令）。worker 经 agent-loop testkit 启动真实的生产 `AgentLoop`，注册五个 harness 私有工具（`project_work_next`、`project_work_claim`、`write_file`、`run_command`、`project_work_update`），直接接到账本接缝函数上，并把一个全新 agent 驱动到 `whenIdle`。verifier 命令在复制的临时工作区里以真实子进程执行；评估、`VERIFYING` 与 `DONE` 移动都走账本自己的写入者；worker 在打印报告前断言最终行、记录的评估与重放投影。

- **双车道，一个循环（§3）。** 确定性车道（默认、无 key）由脚本化的 `LlmAdapter` 驱动，其声明的上下文窗口是 4096；它的每一步动作——工作项 id、verifier 命令——都从会话中已有的 packet 文本提取，因此可证明 packet 是唯一的任务载体。每个请求按序列化字节数（每 token 四字符）加 512-token 预留输出度量，必须装进 4096 否则运行失败；第七个请求直接失败而不是循环。live 车道（`DSH_4K_LIVE=1` 携带 `DEEPSEEK_API_KEY`）把同一循环在同样的钉住窗口后发给真实 provider，并按 §3 以 provider 上报的 usage 为最终裁决；启发式只保留为其预检。live 车道的无 key 自跳过遵循仓库的 real-API key 政策；确定性车道总是运行，因此 verifier 命令本身在无 key 的 CI 里也以 0 退出。
- **persona 是预算的一部分。** 系统 prompt 以关闭 harness 身份与运行时上下文的方式挂载，外加五行 persona——生产 persona 自身就会吃掉窗口；§3 约束的是整个请求。
- **工具是 benchmark 私有的。** `/project` 命令与工具面仍归 mini profile（W08 的隔离设计）；benchmarks 树明确允许在公开导出未覆盖被测用户路径时使用私有集成 adapter，而账本的公开函数正是那条路径。
- **激活是 owner 接缝。** harness 直接 raw-激活导入的版本，因为 v1.6a 没有激活写入者；README 与本 note 记录了这一点。

验证：`./benchmarks/context-light/run-4k.sh` 以 0 退出——六个请求，最大估算请求 2,308 token 对 4,096 预算（packet 2,301 字节），五个工具各一次，verifier 退出码 0，工作项 `DONE`，标准 `PASSING`，重放投影 `DONE`。全量 typecheck（worker 位于 host 程序内）、oxlint、`verify-application-entrypoints` 与文档门保持绿。

## 备选方案

**等 `/project` 工具面落地后经 `dsh --profile mini` 跑切片。** 对 W12 否决——命令面是下一版本的接缝，而 §3 的 lane 契约现在就能对真实循环证明；benchmark 的私有工具调用的正是 profile 将要调用的同一批账本公开函数。

**把确定性车道做成单元测试而非模型车道运行。** 否决——lane 的主语是请求组装：系统 prompt、工具 schema、packet 与历史在同一预算下。驱动真实 AgentLoop 才让度量成为 provider 将看到的那个请求。

**用分词器做 token 精确预检。** 否决——§3 自己就把启发式降为预检并命名 provider usage 为最终标准；对这个 persona 加 packet 的形态，每 token 四字符已属保守，还避免把分词器引进 benchmarks 树。

**靠选模型钉住 provider 窗口。** 延后——托管 provider 的服务端窗口不是请求参数；live 车道钉住 adapter 声明的窗口、按响应强制 usage 上限，README 记录了本地 llama.cpp 端点（`DSH_4K_BASE_URL`）才是按 §3 精确钉住服务端的方式。

## 后果

4K lane 从此有了一个钉住、可复现的门，对任何载荷增长都会大声失败：WorkPacket 格式变更、persona 修改或工具 schema 膨胀一旦破坏预算，verifier 会在到达 provider 之前失败。live 车道是 W13 验收的模板——同一个驱动器、一个真实开发任务——而确定性车道的 packet 派生脚本同时是 BOOT-02"全新 agent 只需要账本"的长期证明。
