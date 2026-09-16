---
description: "Plan-as-Data 项目账本的入口接缝：严格 plan 解析、v1.1 schema 校验、语义检查、规范 IR 编译与事务性不可变导入，供维护者在 v1.6a Ledger Core 之上构建计划工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

[English](README.md) | 中文

## 概述

`dsh-experimental-project-ledger` 拥有 v1.6a Ledger Core（docs/mini/v1.6a）的 plan 文档接缝。plan 文档是惰性数据：`parsePlanDocument` 解析 YAML 并带源位置，拒绝重复键、锚点与别名；`validatePlanSchema` 镜像已发布的宪法 `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`；`validatePlanSemantics` 检查引用、层级与排序关系。`compilePlan` 把已校验文档编译为带确定性品牌行身份的规范 IR，`importPlanVersion` 以单个原子事务写入该 IR；事件接缝负责版本化信封的盖章、fail-closed 读取与重放。本包绝不执行 verifier 命令，也绝不激活计划。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先解析字节，再校验 schema，检查语义，编译，最后导入；每次拒绝都是 `PlanDocumentError`（或 `PlanImportError`），携带全部独立问题及其点分路径：

```ts
import { openProjectLedgerDatabase } from '@deepseek-ai/dsh-experimental-project-ledger-sqlite'
import { compilePlan, importPlanVersion, parsePlanDocument, readProjectEvents, replayProjectEvents, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

const { text, value } = parsePlanDocument(planBytes)
const document = validatePlanSchema(value)
validatePlanSemantics(document)
const compiled = compilePlan(document, { sourceText: text })
const db = await openProjectLedgerDatabase(ledgerPath)
const result = importPlanVersion(db, compiled, { sourcePath: planPath })
const timeline = readProjectEvents(db, compiled.projectId)
const projection = replayProjectEvents(db, compiled.projectId)
```

一个测试把 zod 镜像钉在已发布的 schema 文件上：只改宪法或镜像其一而不同步另一方，测试套件即失败。

<a id="understand-the-implementation"></a>
## 理解实现

- **别名/锚点策略**——锚点与别名一律拒绝：它们是唯一能让两个文档路径共享同一可变对象的 YAML 特性，而账本把 plan 文档当作惰性数据，解析顺序绝不可被观测。
- **版本 fail closed**——`schemaVersion` 不是 `1` 的文档只产生一条 `schema-version-unsupported` 问题，不在其余字段上级联报错。
- **确定性身份**——行 id 由账本稳定键推导（`wi:<project>:<work id>`、`plv:<plan>:v<n>`），同样的源字节在每个账本数据库中编译出相同的主键；规范 IR hash 是全部产出行按成员键排序 JSON 的 SHA-256。
- **按 hash 幂等**——重复提交同一源文本会返回已记录版本且不写任何行；同一版本号携带不同源内容抛 `version-conflict`；新版本重复声明已属于其他版本的工作项抛 `work-item-conflict`。
- **事务与事件原子**——单个 `BEGIN IMMEDIATE` 事务写入版本各表并追加 `plan/imported` 与 `work/created` 事件；任何失败回滚，账本不留部分行。导入绝不激活：版本以 `DRAFT` 落库，`plans.current_version_id` 不被触碰。
- **事件读取 fail closed**——v1 词表全部是 required 事件：读取遇到未知 required 事件类型或外来 `event_format_version` 时拒绝整条时间线；未知 ignorable 行（更新的写入者的观察性扩展）被保留且不改变重放状态。required 词表条目拒绝以 ignorable 落库。

<a id="dev-note"></a>
## 开发备注

不发布运行时不变量伴随包：导入的保证由数据库自身约束加单个事务构成，编译趟是纯函数，不存在独立观察者会分歧的关系；宪法镜像与导入规则由包自身测试强制执行。

<a id="model-experience"></a>
## Model Experience

无，因为解析器与导入器只持久化 plan 事实、不注册任何模型可见内容；verifier 命令在此是存储数据，绝不会被执行。

#### KV Cache effect

无——本包不组装也不发送任何 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延迟工作

以下是当前包约束，不是任务清单。

- **尚无激活与 supersede**——导入绝不激活版本，且拒绝已属于其他版本或 backlog 的工作项；这些迁移由 supersede 流程负责。
- **账本读取仅限事件层**——`readProjectEvents` 与 `replayProjectEvents` 暴露事件时间线及其投影；readiness、项目状态与租约的查询随后续账本工作包到来。
- **英文诊断**——问题消息仅英文；它们是编译器输入，不是 UI 文案。
