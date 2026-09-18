# Agent Note：mini Profile 的面向模型 project-work 工具

Status: implemented

[English](2026-09-18-mini-project-work-tool.md) | 中文

## Problem

v1.6a 的 BOOT-02 流程——fresh agent 认领一个就绪条目、领取其有界 WorkPacket、回报 verifier 结果——目前只存在于 4K 基准内联的工具夹具与账本接缝函数中。挂载的 bundle 暴露不了任何工具，真实 agent 会话无法驱动该循环，§33 的真实使用门也没有积累证据的器械。v1.6a 方案给出了确切表面：三个短工具 `project_work_next`、`project_work_claim`、`project_work_update`，作为同一 `ctx.projectLedger` 句柄的消费者（§5.4）。

## Decision

`src/project-work.ts`（packages/experimental/mini-profile）新增第三个 bundle 入口 `mini-project-work`，注入 `tools` 与 `projectLedger`，经 `ctx.effect` 在 `ctx.tools` 上注册三件工具。`next` 把 agent todo 视图（§11）投影为规范 JSON——id、状态、优先级、重算的阻塞原因、活跃租约持有者。`claim` 以 worker identity `agent:<session-id>` 运行账本的 `claimWorkItem`，随后 `buildWorkPacket`，返回租约回执加上经解析的 `serializeWorkPacket` 文档及 `packetId`/`packetHash`/`serializedBytes` 回执；schema 把 packet 声明为不受约束的 JSON 节点，因为该文档由记录在案的 recipe 哈希钉住，而在工具 schema 里复制其完整字段清单会随账本漂移。`update` 推进持有的认领——`heartbeat`、`release` 或 `report`——`report` 先心跳（过期租约归 reaper 所有），只对 verifier 规格存有可执行文本（agent 能经其普通工具运行的命令或查询）的标准写评估，经账本封闭转移表转到 `VERIFYING`/`FAILED`，只有当全部必备标准已是 `PASSING`/`WAIVED` 时才到达 `DONE`，且每种终结结果都释放租约。

lease bearer token 绝不进入模型可见值：插件以普通插件状态保存从 worker identity 到 `{leaseId, leaseToken, workItemId}` 的 per-agent `Map`，因此心跳与释放以编程方式出示 token，而每个工具结果——进而每段 session log 重放——都不含 token；丢失持有者由过期与 reaper 收回。`OWNER_CONFIRMATION` 与结构性 verifier 不携带可执行文本，report 路径因此永远写不了它们；owner 门控条目在 `VERIFYING` 等待，待决标准在规范值与渲染文本中都点名。租约时长是部署配置（`leaseTtlMs`、`leaseHeartbeatIntervalMs`），在加载时对照账本自身的 `resolveLeaseConfig` 策略急切校验。单项目解析从 `src/commands.ts` 移入两个消费者入口共享的 `src/project-resolution.ts`；命令插件其余部分不变（局部 `assertNever` 保留封闭联合兜底，并补上覆盖率门要求的声明处 v8 ignore）。

接线镜像命令入口：指向 `@deepseek-ai/dsh-experimental-mini-profile/project-work` 的 `project-work` patch 行、`./project-work` 导出、第三个包内 tsdown 入口、供源码启动的 tsconfig.base.json 子路径映射、作为运行时依赖的 `dsh-tools`，以及把 workspace 约束 bundle 规则泛化到 `./commands` 与 `./project-work` 一对。W08 生命周期插件保持字节不变。

验证：`tests/project-work.spec.ts`（13 个测试）驱动真实 `ctx.tools.execute`——封闭参数形状、空/多义/显式项目解析、竞争认领拒绝、配置过的租约时长、packet 交付且断言 token 不出现在任何值与文本中、心跳、`PASS`→`DONE` 端到端流程、owner 门控的 `VERIFYING` 等待（owner 经验收接缝完成）、`FAIL`→`FAILED` 流程、释放后重认领、每条语法拒绝、加载时租约策略失败；共享 plan 夹具与 owner 接缝激活移入 `tests/plans.ts`，spec 之间不再重复；包内 26 个测试、逐文件 100% 覆盖。

## Alternatives considered

**把 lease token 返还给模型供后续心跳。** 否决——模型可见的 token 会作为持久 bearer 凭证落入 session log，破坏 lease 模块自身的设计（token 绝不进入 project event）；per-agent map 以零暴露给出同等调用体验，重启只损失过期机制本就负责收回的东西。

**让 `report` 写所有标准的评估，包括 owner 确认。** 否决——模型将自我认证 §5.3 验收门；按存储的可执行文本判定资格是数据驱动的，覆盖 `COMMAND`/`TEST`/`SQL_ASSERTION`，把 `OWNER_CONFIRMATION` 与结构性断言留给各自 owner，而 `changeWorkStatus` 自身的必备标准门仍是到达 `DONE` 的唯一路径。

**用一个带 action 参数的 `project_work` 工具覆盖读取。** 否决——方案命名了三个短工具，基准钉住的流程也逐件脚本化它们；分开注册让每个 schema、描述与输出联合在 4K 航道上保持最小。

**把 packet schema 写成 `WorkPacket` 的完整类型镜像。** 否决——工具里复制的字段清单会随账本文档演进漂移；recipe 哈希钉住文档完整性，带顶层回执的不受约束 JSON 节点才是诚实投影。

## Consequences

`dsh --profile mini` 的 agent 现在能在模型侧驱动完整认领生命周期：观察就绪工作、带着有界且可重建的 packet 认领、保持或归还租约、回报由账本——而非工具——转成 `VERIFYING`、`DONE` 或 `FAILED` 的 verifier 观察。这是 §33 真实使用证据的“行动半边”；“观察半边”随 `/project` 命令落地，剩余的 v1.6b 门是 Owner 域。后续消费者（4K 基准的夹具、Web 卡片、owner 队列）现在既有解析接缝（`listPlans`）也有可依托的工具语法，基准的内联夹具最终可换成本 bundle 的真实注册。
