---
description: "在 dsh-base 之上挂载 v1.6a Project Ledger 能力、其 /project 命令面及其 project_work 工具的实验性 mini profile bundle，不含任何包 bin。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-experimental-mini-profile`

[English](README.md) | 中文

## 概述

当 `mini` profile 需要以唯一受支持的启动形态挂载 v1.6a Project Ledger 能力时，使用本 bundle。它在 `dsh-base` 之上叠加三个插入：`mini-project-ledger` 插件经 SQLite store 的 fail-closed 打开账本数据库、以 `ctx.projectLedger` 暴露；`mini-project-commands` 插件注册只读的 `/project` 命令（todo §11、doctor F05、item 审阅/历史、重放对账、摘要/导出、owner 决策）；`mini-project-work` 插件注册认领工作、交付有界 WorkPacket（§16/§17）的 `project_work_*` 工具。账本路径来自 `DSH_MINI_LEDGER_PATH`（带回退到 dsh home）。本包不新增 bin，也不运行 verifier。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先创建 profile，再把本 bundle 作为持久依赖挂上：

```sh
dsh --profile mini
dsh plugin --profile mini add @deepseek-ai/dsh-experimental-mini-profile
```

启动前把 `DSH_MINI_LEDGER_PATH` 设为绝对文件路径，可将账本放到 Harness home 之外；目录与文件在首次使用时以 owner-only 权限创建。profile 内任何插件或命令都读取同一个已打开的句柄：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-mini-profile'

declare const ctx: Context
const db = ctx.projectLedger.db
```

挂载后的 `/project` 命令在 profile 的交互式命令适配器中应答：`/project todo [--agent] [<project-id>]` 列出未完成的 owner（或 agent）工作，附带重算的 readiness 与活跃租约；`/project doctor [<plan-version-id>]` 对 current（或指定）plan 版本运行只读 plan doctor；`/project item <stable-key-or-id> [<project-id>]` 经账本的 review 接缝审视单个工作项——每条标准的投影状态与最新评估，附观察到的 exitCode 与折叠成单行的输出尾部摘录；`/project history <stable-key-or-id> [<project-id>]` 经账本的历史接缝按最新在前列出该条目的全部已记录尝试——判定、评估者、时间与同一摘录格式；`/project replay [<project-id>]` 经重放接缝对账账本——折叠项目全量事件，把重建投影与物化行逐族双向比对；`/project digest [<project-id>]` 经 digest 接缝读取全项目证据摘要——每个 plan 及其版本与生命周期戳、每个条目逐条标准的完成度与最新判定、以及重放结论；`/project export [<project-id>]` 把同一记录渲染成单个可归档的 markdown 块，逐条证据摘录俱全，可直接粘进 §33 记录或评审；裸 `/project` 打印用法。未指明时，命令经账本的 plan 目录解析项目与版本。

profile 内的 agent 还获得三个面向模型的工具。`project_work_next` 列出 agent todo 视图，附带可认领性、阻塞原因与租约持有者；`project_work_claim` 对一个就绪条目取得租约并返回有界 work packet——目标、阶段、阻塞回执、验收标准与存储的 verifier 规格；`project_work_update` 推进持有的认领：`heartbeat` 延长租约，`release` 归还条目，`report` 记录 agent 的 verifier 观察——判定连同可选 exitCode 与有界输出尾部，存入每条评估的 observed 载荷——把条目移入 `VERIFYING` 或 `FAILED`，且只有当全部必备标准都已通过时才完成它。认领与心跳时长是部署配置（`leaseTtlMs`、`leaseHeartbeatIntervalMs`）。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

patch 只插入三行。挂载插件在加载时校验 `ledgerPath`（必填）与 `busyTimeoutMs`，在服务 init 期间打开数据库——整棵树只有在 store 完成迁移与盖章后才算就绪——并交出一个在插件卸载时关闭句柄的释放器。数据库版本检查由 store 自己执行：比本构建更新的账本拒绝启动而不是降级。命令插件注入 `commands` 与 `projectLedger`，以 effect 归属注册 `/project`，并渲染只读接缝结果——它不拥有账本语义，也不拥有生命周期。project-work 插件注入 `tools` 与 `projectLedger`，急切校验其租约策略使不兼容的组合在加载时失败，并把每个认领 agent 的 bearer 租约 token 保存在进程内存——token 绝不进入模型可见值，因此 session log 的任何重放都无法心跳或释放租约；丢失持有者由过期与 reaper 收回。report 路径只为 verifier 规格存有可执行文本（agent 能经其普通工具运行的命令或查询）的标准写评估，绝不写 `OWNER_CONFIRMATION`，且只能经账本自身的验收门到达 `DONE`。两个消费者入口共享一个基于 plan 目录的项目解析模块。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Project Ledger 行及其环境变量兜底路径、`/project` 命令行与 project-work 工具行 |
| [`src/index.ts`](src/index.ts) | `mini-project-ledger` 插件与 `ctx.projectLedger` 服务 |
| [`src/commands.ts`](src/commands.ts) | 注册只读 `/project` 命令的 `mini-project-commands` 插件 |
| [`src/project-work.ts`](src/project-work.ts) | 注册 `project_work_next` / `claim` / `update` 三件的 `mini-project-work` 插件 |
| [`src/project-resolution.ts`](src/project-resolution.ts) | 两个消费者入口共享的单项目解析 |
| — | 不发布运行时不变量伴随包：本包只携带静态 profile patch、一个生命周期提供者与报告面；账本接缝自身拥有其关系。 |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | 精确组合与清单检查 |
| [`tests/service.spec.ts`](tests/service.spec.ts) | 打开、服务、配置与释放检查 |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | `/project` 的解析、解析目标、渲染与生命周期检查 |
| [`tests/project-work.spec.ts`](tests/project-work.spec.ts) | 工具语法、认领生命周期、packet 交付与验收边界检查 |
| [`tests/plans.ts`](tests/plans.ts) | 各 spec 共享的 plan 文档与播种助手 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 人类 `/project` 报告

#### What the model sees

斜杠输入与直接的状态/错误输出都不进入模型请求。命令注册表在会话上把每次调用记录为 `command/run` 与 `command/done`；输出背后的账本行不会经本面进入任何模型请求。

#### Token effect

无——命令读取账本并直接应答人类；本 bundle 不代表它组装或发送任何 provider 请求。

#### KV Cache effect

无——本命令不添加任何请求前缀。

### 面向模型的 `project_work_*` 工具

#### What the model sees

三个工具 schema（名称、描述、参数形状）进入 system-prompt 组装；每次调用及其规范结果都经标准工具生命周期记录在会话上。`project_work_next` 返回 agent todo 列表；`project_work_claim` 返回租约回执与 work-packet 文档——packet 由记录在案的 `project/work-packet-prepared` recipe 哈希钉住，模型所见可仅凭持久状态重建；`project_work_update` 返回动作结果、已记录的评估与仍待决的标准。租约 bearer token 绝不对模型可见。

#### Token effect

三个 schema 条目是常驻 system-prompt 成本。每次调用增加一个工具结果：一个列表、一个动作回执，或一个认领结果——其 packet 部分受账本强制执行的序列化字节上限约束。

#### KV Cache effect

schema 条目扩展稳定的 system-prompt 前缀；逐轮结果作为普通工具结果追加在其后。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

以下是当前包约束，不是任务清单。

- **命令保持只读；工具只经账本写入者变更**——`/project` 只做列举与诊断；工具通过调用账本的持有接缝来认领、评估与转移，Owner 域仍是 v1.6b 范围。
- **租约 token 存活在认领进程内**——重启后的 agent 无法心跳或释放重启前的认领；过期与 reaper 负责收回，任何 session log 重放都不携带可用 token。
- **每个可观察标准一个判定**——`report` 为 verifier 规格存有可执行文本的每个标准恰好携带一条 `{criterionId, result, exitCode?, outputTail?}`；exitCode 与至多末尾 2048 字符的尾部落入该条评估的 observed 载荷，`OWNER_CONFIRMATION` 与结构性断言绝不经此写入，`DONE` 仍要求全部必备标准通过，owner 门控条目因此在 `VERIFYING` 等待。
- **仅交互式命令适配器**——`/project` 依托 `ctx.commands`，由交互式适配器消费；headless 与 JSON-RPC 面没有命令平面。
- **无专属 Web 卡片**——工具为 Host UI 声明纯 `presentCall` 视图；Web Client 仍从原始事件派生卡片，尚无键槽卡片。
- **agent 由 `dsh-base` 承担**——本 bundle 刻意只新增账本面；超出 base 的 profile 组合属于用户的 patch 层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本 bundle 拥有生命周期与表面，绝不拥有账本语义：挂载插件拥有打开顺序、经校验的配置与关闭释放器；命令插件解析封闭语法、经共享的 plan 目录解析解析 id 并渲染接缝结果；project-work 插件把账本接缝映射到三个封闭工具语法上，把 bearer-token 映射作为按 worker identity 键控的普通插件状态保存，并以 verifier 规格存储的可执行文本来标记 agent 可观察的标准。这里的测试断言组合、句柄生命周期、命令面与端到端的认领生命周期；账本语义由 `@deepseek-ai/dsh-experimental-project-ledger` 自己的测试套覆盖。

</details>
