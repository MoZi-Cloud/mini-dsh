---
description: "在 dsh-base 之上挂载 v1.6a Project Ledger 能力的实验性 mini profile bundle，不含任何包 bin。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-experimental-mini-profile`

[English](README.md) | 中文

## 概述

当 `mini` profile 需要以唯一受支持的启动形态挂载 v1.6a Project Ledger 能力时，使用本 bundle。它在 `dsh-base` 之上只叠加一个插入：`mini-project-ledger` 插件经 SQLite store 的 fail-closed 打开账本数据库，以 `ctx.projectLedger` 暴露，并在卸载时关闭。账本路径来自 `DSH_MINI_LEDGER_PATH`（带回退到 dsh home）。本包不新增 bin，不执行 verifier 命令，也不激活计划。本 bundle 位于 experimental 组，默认安装不发布 `mini` 模板——隔离规则把实验性能力挡在默认组合之外。

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

对该句柄调用 `@deepseek-ai/dsh-experimental-project-ledger` 的接缝函数——本服务只拥有身份、打开顺序与生命周期，绝不拥有账本语义。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

patch 只插入一行。插件在加载时校验 `ledgerPath`（必填）与 `busyTimeoutMs`，在服务 init 期间打开数据库——整棵树只有在 store 完成迁移与盖章后才算就绪——并交出一个在插件卸载时关闭句柄的释放器。数据库版本检查由 store 自己执行：比本构建更新的账本拒绝启动而不是降级。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 唯一的 Project Ledger 行及其环境变量兜底路径 |
| [`src/index.ts`](src/index.ts) | `mini-project-ledger` 插件与 `ctx.projectLedger` 服务 |
| — | 不发布运行时不变量伴随包：本包只携带静态 profile patch 与生命周期提供者，账本接缝自身拥有其关系。 |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | 精确组合与清单检查 |
| [`tests/service.spec.ts`](tests/service.spec.ts) | 打开、服务、配置与释放检查 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 无面向模型的面

#### What the model sees

本 bundle 不产生任何模型可见内容。挂载的行不添加任何提示词、工具或请求面；`ctx.projectLedger` 只暴露一个数据库句柄，其语义位于 `@deepseek-ai/dsh-experimental-project-ledger`。

#### Token effect

无——本 bundle 不组装也不发送任何 provider 请求。

#### KV Cache effect

无——本 bundle 不添加任何请求前缀。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

以下是当前包约束，不是任务清单。

- **尚无账本命令或工具**——本挂载把能力暴露给后续消费者（`/project` 命令、面向模型的 project-work 工具、WorkPacket 构建器）；目前没有任何面向模型的东西挂在本 bundle 上。
- **agent 由 `dsh-base` 承担**——本 bundle 刻意只新增账本；超出 base 的 profile 组合属于用户的 patch 层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本 bundle 只拥有生命周期：打开顺序、经校验的配置与关闭释放器。账本语义留在 `@deepseek-ai/dsh-experimental-project-ledger`，因此这里的测试只断言组合与句柄生命周期，从不断言账本行为。

</details>
