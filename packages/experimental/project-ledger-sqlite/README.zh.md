---
description: "v1.6a Project Ledger Core 的 SQLite 持久层：十三表布局、相邻迁移与 fail-closed 打开，供维护者在账本之上构建计划导入、激活或项目 todo 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger-sqlite

[English](README.md) | 中文

## 概述

`dsh-experimental-project-ledger-sqlite` 拥有 v1.6a Ledger Core 的 SQLite 持久化接缝。`openProjectLedgerDatabase` 物化 v1 布局——从 `plans`、`plan_versions` 到 `work_leases` 的十三张 STRICT 表——文件仅属主可访问，`foreign_keys` 开启，默认持久 WAL 日志，并为争用写入者配置 busy timeout。数据库是事实源：`user_version` 比构建更新的库直接拒绝；更旧的版本通过相邻迁移步骤升级，每步一个 `BEGIN IMMEDIATE` 事务，版本戳只在迁移后布局完整时落笔。verifier 命令是存储数据；本包绝不执行它们。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

打开数据库路径（或 `:memory:`）；返回的句柄是应用过 pragma、布局已达当前的 `node:sqlite` `DatabaseSync`：

```ts
import { openProjectLedgerDatabase, PROJECT_LEDGER_SCHEMA_VERSION } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'

const db = await openProjectLedgerDatabase(ledgerPath, { journalMode: 'wal', busyTimeoutMs: 5000 })
// STRICT tables, foreign keys on, stamped with PROJECT_LEDGER_SCHEMA_VERSION
db.close()
```

`PROJECT_LEDGER_MIGRATIONS` 是冻结的相邻步骤注册表；`applyProjectLedgerMigrations` 在打开的句柄上执行它，打开流程自身也走这一条路。`user_version` 为未知版本的数据库以 `ProjectLedgerError` 的 `version-mismatch` 拒绝，文件保持原样。

<a id="understand-the-implementation"></a>
## 理解实现

- **最后落戳、拒绝更新**——`user_version` 戳断言迁移后布局完整，打开中途失败时旧版本戳仍在，下次打开重试该步；比构建更新的版本 fail closed，绝不降级。
- **仅相邻步骤**——每次布局变更追加一个迁移（`0 → 1 → …`）；已发布步骤冻结，各自独立事务，失败即回滚、绝不半途生效。跳版本或止步中途的注册表会响亮报错。
- **计划无第二权威**——`plans` 不携带 status；计划状态只存在于 `plan_versions.status`。`work_items.plan_version_id` 可空，计划外 backlog 工作是一等行。
- **类型化 verifier 存储**——`verification_specs` 每条验收标准一行标记行，表级 CHECK 镜像 plan schema 的判别式 verifier 联合；`acceptance_evaluations` 是 append-only 历史，单活跃租约不变量由部分唯一索引承载。

<a id="dev-note"></a>
## 开发备注

不发布运行时不变量伴随包：布局、打开顺序与迁移引擎由本包自身测试对着本地 SQLite 句柄强制执行；这里没有会在独立视点间分歧的内容。

<a id="model-experience"></a>
## Model Experience

无，因为存储层持久化计划与工作事实并直接服务调用者；verifier 命令在此是存储数据，绝不会被执行。

#### KV Cache effect

无——本包不组装也不发送任何 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延迟工作

以下是当前包约束，不是任务清单。

- **只有 schema，尚无类型化访问**——读写这些表的类型化接口位于 `dsh-experimental-project-ledger`，作用于打开的句柄：计划导入（W03）与项目事件信封（W04）已在该包交付，就绪投影（W05）、验收存储（W06）与租约认领（W07）随后交付；本包交付身份、布局与打开顺序。
- **只有一个迁移步骤**——注册表止于 `0 → 1`；fixture 协议（外键检查、完整性检查、行平价）由套件在已发布步骤上演练。
- **无跨进程协调**——并发防御是 `busy_timeout`；事件与租约的 `BEGIN IMMEDIATE` 分配路径随对应工作包交付。
