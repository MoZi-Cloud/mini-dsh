# Agent Note：post-v1.6a 真实使用 lane 与 §33 证据记录

Status: implemented

[English](2026-09-18-post-v16a-real-use-lane.md) | 中文

## Problem

§33 只在账本记录的真实使用连续覆盖 N 个工作项、且证据来自账本的前提下才开启 v1.6b，而验收报告的 §33 一节目前只计一次真实使用切片（4K lane）加黄金计划自身的历史。但 4K lane 驱动的是针对 `:memory:` 数据库的 fixture 工具克隆——shipped 的 `mini-project-work` 插件从未在单测之外完成过真实工作项，持久账本不存在，而增量积压（工具交付时的 presenter 缺口）只活在 README 文字里。无 key 环境拿不出模型会话：本环境没有 `DEEPSEEK_API_KEY`。

## Decision

三件事一起落地。第一，载荷：三个 `project_work_*` 工具获得纯 `presentCall` 通用视图（goal 工具模式——只用 args、共享 `present` 辅助、软校验对畸形重放 args 返回 `undefined`；不写 `presentResult`，因为渲染出的模型内容已服务完成态卡片，且 Web Client 本就从原始事件派生卡片）。第二，积压变成 plan-as-data：`docs/mini/v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml` 记录 presenter 项与两个未来增量（`PW-REPORT-VERDICTS-001` 按标准报告判定、`PW-OBSERVED-TAIL-001` 在 observed 评估中记录 verifier 输出尾），各项存储 `pnpm exec vitest run mini-profile` verifier。第三，驱动器：`benchmarks/real-use/run-real-use.sh`（镜像 4K 脚手架的 built-worker lane——tsdown `neverBundle`、`assertBuiltBenchmarkRuntime`、纯 Node）挂载 SHIPPED 的 `SystemPrompt` → `ToolRuntime` → `MiniProjectLedger` → `mini-project-work` 组合，幂等导入计划（已存在的版本被复用，激活是有注释的裸 owner 更新），并对一个目标项走真实工具面——`next` 找到它、`claim` 收到 WorkPacket、以真实 `sh -c` 子进程执行 packet 存储的 verifier 命令、带观测到的退出码 `report`——只接受 DONE 且 doctor 0 问题且事件重放 DONE。

lane 默认用全新临时账本；`DSH_REAL_USE_LEDGER` 指向持久文件。首次持久运行瞄准 profile 默认 `~/.dsh/project-ledger/ledger.sqlite`，记录因此落在真实 `dsh --profile mini` 会话读取的位置，且紧接着的重跑幂等通过（`alreadyComplete: true`，零写入）。`docs/mini/real-use-log.md` 是常青证据日志：每次持久运行一条，另有门槛现状（经账本完成 16 项、BOOT/4K 无回归、§33 的用户确认待定）。

验证：presenter 用例（含软失败畸形 args）使 mini-profile 达到 27 个测试、逐文件 100% 覆盖；lane 在临时账本与持久 profile 账本上各绿行（完成加幂等重跑），每次都以子进程执行真实 verifier 套件（退出码 0）、doctor 0 问题、重放 DONE；完整 typecheck、oxlint、`test:docs`、hygiene、duplication 均只带既有基线。`benchmarks/package.json` 新增 `dsh-system-prompt` 与 `dsh-experimental-mini-profile` devDependencies——worker 经它解析运行时导入。

## Alternatives considered

**像 fixture 生成器那样直接驱动 seam。** 否——证据的意义在于 shipped 的模型面完成真实工作；seam 调用只能再次证明账本，而不是 §33 门槛即将依赖的 profile 组合。

**提交一个生成的证据数据库，如 `v1.6a-populated.db`。** 否——工具路径使用真实时钟（租约到期、事件时间戳），不提供工具刻意不给的时钟注入就无法字节稳定再生；一条可以反复重跑、绿色退出即再次证明记录的 lane，是比冻结文件更强的证据。

**等真实模型会话再记录真实使用。** 否——验收报告已把确定性 4K 切片计为真实使用，本 lane 是该先例在 shipped 表面上的应用，且 §33 的 N 项计时不应取决于 key 是否可得。

**在 lane 里同时挂载 `/project` 命令面。** 否——`CommandRuntime` 是 TypertRemoteService；为拿到账本 seam 已可读的输出而把它挂进 lane 会让 lane 耦合 typert 图。命令面保留自己的单测。

## Consequences

后续每个增量经 lane（或真实会话）对同一持久账本认领自己的计划项，§33 记录因此在原地累积，日志的项数可与账本本身核对。lane 是"shipped profile 表面是否完成了真实工作"的常青无 key 答案：CI 不运行它（4K lane 政策——功能性门，不是计时 benchmark），日志记录每次持久运行。积压项如今是带存储 verifier 的账本事实，这也约束未来增量：完成一项意味着认领、验证、报告，而不是改 README 文字。
