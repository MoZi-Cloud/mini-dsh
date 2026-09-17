---
description: "Plan-as-Data 项目账本的入口接缝：严格 plan 解析、v1.1 schema 校验、语义检查、规范 IR 编译与事务性不可变导入，供维护者在 v1.6a Ledger Core 之上构建计划工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

[English](README.md) | 中文

## 概述

`dsh-experimental-project-ledger` 拥有 v1.6a Ledger Core（docs/mini/v1.6a）的 plan 文档接缝。plan 文档是惰性数据：`parsePlanDocument` 解析 YAML，拒绝重复键、锚点与别名；`validatePlanSchema` 镜像宪法 schema；`validatePlanSemantics` 检查引用、层级与排序关系。`compilePlan` 编译出带确定性身份的规范 IR，`importPlanVersion` 以单个原子事务写入；事件接缝负责盖章与 fail-closed 重放；`computeWorkReadiness` 从因果行重算可领取性；`evaluateAcceptanceCriterion` 追加调用方报告的评估；`claimWorkItem` 为每个工作项仲裁唯一活跃租约，并附带心跳、过期与重算投影的 reaper 生命周期。本包绝不执行 verifier 命令，也绝不激活计划。

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
import { changeWorkStatus, claimWorkItem, compilePlan, computeWorkReadiness, detectWorkGraphCycles, evaluateAcceptanceCriterion, heartbeatWorkLease, importPlanVersion, parsePlanDocument, readProjectEvents, releaseWorkLease, replayProjectEvents, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

const { text, value } = parsePlanDocument(planBytes)
const document = validatePlanSchema(value)
validatePlanSemantics(document)
const compiled = compilePlan(document, { sourceText: text })
const db = await openProjectLedgerDatabase(ledgerPath)
const result = importPlanVersion(db, compiled, { sourcePath: planPath })
const timeline = readProjectEvents(db, compiled.projectId)
const projection = replayProjectEvents(db, compiled.projectId)
const readiness = computeWorkReadiness(db, compiled.workItems[0].id)
const cycles = detectWorkGraphCycles(db, compiled.projectId)
const evaluation = evaluateAcceptanceCriterion(db, compiled.workItems[0].acceptance[0].id, 'PASS')
const claim = claimWorkItem(db, compiled.workItems[0].id, 'worker/session-7')
const lease = heartbeatWorkLease(db, claim.leaseId, claim.leaseToken)
releaseWorkLease(db, claim.leaseId, claim.leaseToken)
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
- **readiness 只重算、绝不信任**——`computeWorkReadiness` 从因果行推导可领取性（plan 版本、phase、`BLOCKS`/`PRECEDES` 边、外部阻塞、required 验收标准、活跃租约，以及工作项自身状态）；物化的 `READY`/`BLOCKED` 状态只是这些输入的投影，层级绝不进入决策（`parent_work_item_id` 是组成关系，不是依赖）。
- **环语义只有一个家**——编译期校验与账本侧 `detectWorkGraphCycles` 共享 `relation-graph.ts` 的排序关系种类与环 walks，同一张图在文档与其产出行上永远得到相同判定。
- **评估是历史，状态是投影**——`evaluateAcceptanceCriterion` 把调用方报告的结果追加进 `acceptance_evaluations`，并在同一事务内随 `acceptance/evaluated` 事件移动标准状态。`ERROR` 只记历史、不动投影。结果由调用方报告：本包存储 `command_text`，绝不运行它。
- **每个工作项只有一个活跃租约**——`claimWorkItem` 在单个 `BEGIN IMMEDIATE` 事务内完成 readiness 重算、陈旧租约回收与租约插入（§13），竞争的 claimer 只会在其后串行并被活跃租约阻塞项拒绝；`uq_one_active_lease_per_work` 部分唯一索引是最终仲裁者。心跳与释放必须在过期前到达，reaper 重算被遗弃项的 `READY`/`BLOCKED` 投影，绝不宣布 `FAILED`。
- **令牌只存哈希，绝不入日志**——认领返回一次性 bearer 令牌；账本只存其 SHA-256 哈希，任何租约事件都不携带它，日志重建租约状态时无需重放机密。

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

- **尚无激活与 supersede**——导入绝不激活版本，且拒绝已属于其他版本或 backlog 的工作项；这些迁移由 supersede 流程负责，指向本项的 `SUPERSEDES` 边在其落地前不进入 readiness。
- **`REVOKED` 是保留行状态**——租约生命周期只写 `ACTIVE`、`RELEASED` 与 `EXPIRED`；Owner 侧吊销尚无写入者，reaper 循环节奏（`reaperIntervalMs`）属于有界 `reapExpiredLeases` 批次的调用方。
- **英文诊断**——问题消息仅英文；它们是编译器输入，不是 UI 文案。
