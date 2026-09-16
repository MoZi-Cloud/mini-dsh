---
description: "Plan-as-Data 项目账本的入口接缝：严格 plan 文档解析、v1.1 schema 校验与语义编译检查，供维护者在 v1.6a Ledger Core 之上构建计划导入、激活或项目 todo 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

[English](README.md) | 中文

## 概述

`dsh-experimental-project-ledger` 拥有 v1.6a Ledger Core（docs/mini/v1.6a）的 plan 文档接缝。plan 文档是惰性数据：`parsePlanDocument` 解析 YAML 并带源位置，拒绝重复键、锚点与别名；`validatePlanSchema` 镜像已发布的宪法 `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`（字段封闭、受控枚举、判别式 verifier 联合、不支持的 `schemaVersion` fail closed）；`validatePlanSemantics` 检查引用、层级与排序关系（`BLOCKS`/`PRECEDES`/`SUPERSEDES` 必须无环）。解析、校验与语义检查都是纯函数：它们绝不执行 verifier 命令，也绝不激活计划。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先解析字节，再校验 schema，最后检查语义；每次拒绝都是 `PlanDocumentError`，携带全部独立问题及其点分路径，已知处还有源位置：

```ts
import { parsePlanDocument, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

const { value } = parsePlanDocument(planBytes)
const document = validatePlanSchema(value)
validatePlanSemantics(document)
```

一个测试把 zod 镜像钉在已发布的 schema 文件上：只改宪法或镜像其一而不同步另一方，测试套件即失败。

<a id="understand-the-implementation"></a>
## 理解实现

- **别名/锚点策略**——锚点与别名一律拒绝：它们是唯一能让两个文档路径共享同一可变对象的 YAML 特性，而账本把 plan 文档当作惰性数据，解析顺序绝不可被观测。
- **版本 fail closed**——`schemaVersion` 不是 `1` 的文档只产生一条 `schema-version-unsupported` 问题，不在其余字段上级联报错。
- **仅排序关系**——环检测覆盖 `BLOCKS`、`PRECEDES` 与 `SUPERSEDES`，它们为工作排序、遇环即死锁；`RELATES_TO` 与 `DUPLICATES` 不携带排序。自环只以 `self-relation` 报告一次。
- **Verifier kind 一致**——acceptance 的 `kind` 必须等于其 verifier 的 `kind`；这两个字段在宪法中冗余，不一致会让验收被错误的接缝执行。

<a id="dev-note"></a>
## 开发备注

不发布运行时不变量伴随包：本包是纯库，其各趟检查不会在独立视点间分歧；宪法镜像、解析器策略与环规则由包自身测试强制执行。

<a id="model-experience"></a>
## Model Experience

无，因为解析器只校验惰性 plan 文档、不注册任何模型可见内容；verifier 命令在此是存储数据，绝不会被执行。

#### KV Cache effect

无——本包不组装也不发送任何 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延迟工作

以下是当前包约束，不是任务清单。

- **尚无规范 IR**——`compilePlan`（v1.6a F03）与事务导入属于计划编译工作包；本包止步于已校验文档。
- **计划域身份**——工作项与 phase id 是普通文档字符串；品牌化账本 id 出现在持久化接缝。
- **英文诊断**——问题消息仅英文；它们是编译器输入，不是 UI 文案。
