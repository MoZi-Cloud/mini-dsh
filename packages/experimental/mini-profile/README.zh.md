---
description: "在 dsh-base 之上挂载 v1.6a Project Ledger 能力及其 /project 命令面的实验性 mini profile bundle，不含任何包 bin。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-experimental-mini-profile`

[English](README.md) | 中文

## 概述

当 `mini` profile 需要以唯一受支持的启动形态挂载 v1.6a Project Ledger 能力时，使用本 bundle。它在 `dsh-base` 之上叠加两个插入：`mini-project-ledger` 插件经 SQLite store 的 fail-closed 打开账本数据库，以 `ctx.projectLedger` 暴露，并在卸载时关闭；`mini-project-commands` 插件注册只读的 `/project` 命令（Owner/Agent todo 视图 §11、plan doctor F05）。账本路径来自 `DSH_MINI_LEDGER_PATH`（带回退到 dsh home）。本包不新增 bin，不执行 verifier 命令，也不改动账本状态。本 bundle 位于 experimental 组，隔离规则把它挡在默认组合之外。

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
declare const ctx: Context
const db = ctx.projectLedger.db
```

挂载后的 `/project` 命令在 profile 的交互式命令适配器中应答：`/project todo [--agent] [<project-id>]` 列出未完成的 owner（或 agent）工作，附带重算的 readiness 与活跃租约；`/project doctor [<plan-version-id>]` 对 current（或指定）plan 版本运行只读 plan doctor；裸 `/project` 打印用法。未指明时，命令经账本的 plan 目录解析项目与版本。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

patch 只插入两行。挂载插件在加载时校验 `ledgerPath`（必填）与 `busyTimeoutMs`，在服务 init 期间打开数据库——整棵树只有在 store 完成迁移与盖章后才算就绪——并交出一个在插件卸载时关闭句柄的释放器。数据库版本检查由 store 自己执行：比本构建更新的账本拒绝启动而不是降级。命令插件注入 `commands` 与 `projectLedger`，以 effect 归属注册 `/project`，并渲染只读接缝结果——它不拥有账本语义，也不拥有生命周期。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Project Ledger 行及其环境变量兜底路径，加上 `/project` 命令行 |
| [`src/index.ts`](src/index.ts) | `mini-project-ledger` 插件与 `ctx.projectLedger` 服务 |
| [`src/commands.ts`](src/commands.ts) | 注册只读 `/project` 命令的 `mini-project-commands` 插件 |
| — | 不发布运行时不变量伴随包：本包只携带静态 profile patch、一个生命周期提供者与一个报告命令；账本接缝自身拥有其关系。 |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | 精确组合与清单检查 |
| [`tests/service.spec.ts`](tests/service.spec.ts) | 打开、服务、配置与释放检查 |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | `/project` 的解析、解析目标、渲染与生命周期检查 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 人类 `/project` 报告

#### What the model sees

斜杠输入与直接的状态/错误输出都不进入模型请求。命令注册表在会话上把每次调用记录为 `command/run` 与 `command/done`；输出背后的账本行不会经本面进入任何模型请求。本 bundle 不注册提示词，也不注册工具。

#### Token effect

无——命令读取账本并直接应答人类；本 bundle 不组装也不发送任何 provider 请求。

#### KV Cache effect

无——本命令不添加任何请求前缀。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

以下是当前包约束，不是任务清单。

- **构造上只读**——`/project` 只做列举与诊断；认领、评估、supersede、记录 drift 及其余变更流程都留在各自的写入者手中，Owner 域仍是 v1.6b 范围。
- **仅交互式命令适配器**——`/project` 依托 `ctx.commands`，由交互式适配器消费；headless 与 JSON-RPC 面没有命令平面。
- **尚无面向模型的项目工具**——面向模型的 project-work 工具与 WorkPacket 投递仍是同一挂载句柄的后续消费者。
- **agent 由 `dsh-base` 承担**——本 bundle 刻意只新增账本面；超出 base 的 profile 组合属于用户的 patch 层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本 bundle 拥有生命周期与报告，绝不拥有账本语义：挂载插件拥有打开顺序、经校验的配置与关闭释放器；命令插件解析封闭语法、经 plan 目录解析 id 并渲染接缝结果。这里的测试断言组合、句柄生命周期与命令面；账本语义由 `@deepseek-ai/dsh-experimental-project-ledger` 自己的测试套覆盖。

</details>
