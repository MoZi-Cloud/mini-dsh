---
description: "SQLite 项目记忆库：仓库快照、符号、调用图、Markdown 大纲、项目对象、带证据的记忆与有界上下文包，供用户和维护者选择、配置或调试该存储。"
kind: "package-reference"
---

# @deepseek-ai/dsh-project-memory

[English](README.md) | 中文

## 概述

`dsh-project-memory` 是仓库智能的 SQLite 事实源存储。每次打开独占一个数据库，以单调 schema 版本（`PRAGMA user_version`）盖章；任何其他已盖章版本都会拒绝——这是持久的项目数据，绝不静默重建。v1 表集覆盖内容库、源码现实（repositories、snapshots、files、symbols、symbol_versions、imports、call_sites、symbol_references、`project_objects`）、文档（`document_headings`）与项目知识（带证据的记忆、带历史的分析单元、运行事件）。`buildContextPacket` 把存储查询变成 token 预算内的检索；4K 上下文车道据此定义。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

打开存储（首次使用时以 owner-only 权限创建），通过 `project-analysis` 索引器填充，然后直接查询：

```ts
import { ProjectMemory, buildContextPacket } from '@deepseek-ai/dsh-project-memory'

const memory = await ProjectMemory.open('.mini-dsh/project-memory.sqlite')
const report = indexRepository(memory, { root: '.', snapshotKind: 'worktree' })
const packet = buildContextPacket(memory, { kind: 'symbol', snapshotId: report.snapshotId, name: 'indexRepository' })
memory.close()
```

快照是 append-only 的：重新索引是新增快照，绝不改写旧快照。多行变更在 `transaction()` 内执行——最外层是 `BEGIN IMMEDIATE`，嵌套调用退化为 savepoint，组合的辅助函数因此加入调用者的事务而不是失败。

<a id="understand-the-implementation"></a>
## 理解实现

- **schema 版本控制**——`PROJECT_MEMORY_SCHEMA_VERSION` 最后才写入 `PRAGMA user_version`，首次物化被中断后可以干净重试；任何非当前版本都拒绝。未来的布局变更以相邻迁移交付。
- **身份**——行 id 是不透明的 `<prefix>_<uuid>` 字符串并在 TypeScript 中按表品牌化；内容 id 是 `sha256:<hex>` 摘要，相同文本去重为一行。
- **调用图**——`call_sites` 行携带 caller/callee 符号版本链接及解析结果（`resolved` 仅当 callee 链接存在，另有 `external`、`unresolved`、`dynamic`）与产出它们的提取级别。
- **上下文包**——章节按存储顺序加入直到预算耗尽；放不下的部分报告为省略。`overflow` 标记车道违规（仅头部就超出预算）。

<a id="dev-note"></a>
## 开发备注

不发布运行时不变量伴随包：本存储是单进程库，其观测不会在独立视点间分歧；schema 版本控制、事务语义与车道预算由包自身测试强制执行。

<a id="model-experience"></a>
## Model Experience

无，因为存储只持久化仓库事实并直接服务调用者；消费方转发给模型的任何内容由消费方负责记录。

#### KV Cache effect

无——本包不发起模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延迟工作

以下是当前包约束，不是任务清单。

- **无全文检索**——符号与文档查找是精确名匹配；快照之上的 FTS 层在有消费者需要时再引入。
- **单连接存储**——一个 `ProjectMemory` 独占一个 SQLite 连接；多进程协调属于将构建其上的账本层。
- **事件无序号**——`run_events` 是无项目级序号的 append-only 运行记录；带回放能力的版本化项目事件账本是独立能力。
