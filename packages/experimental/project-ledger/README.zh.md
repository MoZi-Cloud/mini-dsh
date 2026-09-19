---
description: "Plan-as-Data 项目账本的入口接缝：严格 plan 解析、v1.1 schema 校验、语义检查、规范 IR 编译与事务性不可变导入，供维护者在 v1.6a Ledger Core 之上构建计划工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-project-ledger

[English](README.md) | 中文

## 概述

`dsh-experimental-project-ledger` 拥有 v1.6a Ledger Core 的 plan 文档接缝。plan 文档是惰性的：`parsePlanDocument` 解析 YAML，拒绝重复键、锚点与别名；`validatePlanSchema` 镜像宪法 schema；`validatePlanSemantics` 检查引用与关系。`compilePlan` 编译出规范 IR，`importPlanVersion` 原子写入；事件接缝 fail-closed 重放；`computeWorkReadiness` 重算可领取性；租约接缝为每个工作项仲裁唯一租约；`buildWorkPacket` 准备有界 WorkPacket；todo 视图按 executor kind 划分工作；supersede 与 drift 退役版本、封堵漂移 baseline；`listPlans`、`readWorkItemReview`、`readProjectReplay` 与 `readProjectDigest` 读回 plan、评审、重放对账与全项目证据摘要。本包绝不执行 verifier 命令。

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
import { buildWorkPacket, changeWorkStatus, claimWorkItem, compilePlan, computeWorkReadiness, detectWorkGraphCycles, evaluateAcceptanceCriterion, heartbeatWorkLease, importPlanVersion, listAgentTodo, listOwnerTodo, parsePlanDocument, readProjectEvents, rebuildWorkPacket, releaseWorkLease, replayProjectEvents, serializeWorkPacket, validatePlanSchema, validatePlanSemantics } from '@deepseek-ai/dsh-experimental-project-ledger'

declare const planBytes: string
declare const ledgerPath: string
declare const planPath: string

const { text, value } = parsePlanDocument(planBytes)
const document = validatePlanSchema(value)
validatePlanSemantics(document)
const compiled = compilePlan(document, { sourceText: text })
const db = await openProjectLedgerDatabase(ledgerPath)
const result = importPlanVersion(db, compiled, { sourcePath: planPath })
const timeline = readProjectEvents(db, compiled.projectId)
const projection = replayProjectEvents(db, compiled.projectId)
const first = compiled.workItems[0]
if (first === undefined) throw new Error('plan records no work item')
const readiness = computeWorkReadiness(db, first.id)
const cycles = detectWorkGraphCycles(db, compiled.projectId)
const criterion = first.acceptance[0]
if (criterion === undefined) throw new Error('work item records no criterion')
const evaluation = evaluateAcceptanceCriterion(db, criterion.id, 'PASS')
const claim = claimWorkItem(db, first.id, 'worker/session-7')
const lease = heartbeatWorkLease(db, claim.leaseId, claim.leaseToken)
releaseWorkLease(db, claim.leaseId, claim.leaseToken)
const packet = buildWorkPacket(db, first.id)
const packetText = serializeWorkPacket(packet)
const rebuild = rebuildWorkPacket(db, packet.packetId)
const ownerTodo = listOwnerTodo(db, compiled.projectId)
const agentTodo = listAgentTodo(db, compiled.projectId)
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
- **验收是唯一的完成权威**——`changeWorkStatus` 只能从 `VERIFYING` 到达 `DONE`，且仅当全部 required 标准处于 `PASSING` 或 `WAIVED`；session todo、plan-mode 编辑或账本之外的任何调用者都无法把项目工作抄近路变成完成。
- **每个工作项只有一个活跃租约**——`claimWorkItem` 在单个 `BEGIN IMMEDIATE` 事务内完成 readiness 重算、陈旧租约回收与租约插入（§13），竞争的 claimer 只会在其后串行并被活跃租约阻塞项拒绝；`uq_one_active_lease_per_work` 部分唯一索引是最终仲裁者。心跳与释放必须在过期前到达，reaper 重算被遗弃项的 `READY`/`BLOCKED` 投影，绝不宣布 `FAILED`。
- **令牌只存哈希，绝不入日志**——认领返回一次性 bearer 令牌；账本只存其 SHA-256 哈希，任何租约事件都不携带它，日志重建租约状态时无需重放机密。
- **packet 是配方，不是行**——`buildWorkPacket` 只读 §17 列出的逐项输入（plan 身份、目标、phase 摘要、关系回执、带存储 spec 的验收标准、baseline），为每个被引用小节计算哈希，并追加携带完整配方的 `project/work-packet-prepared` 事件；不存在物化 packet 表，因为事件就是持久记录且 packet 可重建。`rebuildWorkPacket` 仅从当前行重组 packet 并点名漂移的引用，审计模型所见永远不需要 Master Plan 全文。
- **有界靠拒绝而非截断**——`serializeWorkPacket` 输出必须低于 `maxSerializedBytes`（默认 65,536）；超限即抛错而不是截断，模型可见文档要么完整要么缺席，相同行永远序列化出相同字节。
- **Owner 与 Agent todo 是按执行者分离的视图**——`listOwnerTodo` 与 `listAgentTodo` 对 `executor_kind`（§11）跑一条只读查询，覆盖全部非终态状态，按种类、优先级降序、年龄与 id 排序；每个条目携带重算的 readiness 与活跃租约，阻塞原因与持有者随任务一并呈现。视图绝不变更：完成权威仍在验收接缝，没有稳定 item id、没有项目身份的 session todo 在账本中没有入口。
- **supersede 退役版本，绝不改写历史**——`supersedePlanVersion` 在单个 `BEGIN IMMEDIATE` 内只移动生命周期列（`SUPERSEDED`、`superseded_at_ms`）与 `plans.current_version_id` 指针，并随 `plan/version-superseded` 事件落库；readiness 随即以 `plan-version-not-active` 拒绝该版本的每个新认领，活跃尝试保留租约、放弃租约后落 `BLOCKED`，事件载荷记录 review 队列。工作项、plan 事实与评估逐字节不变。
- **drift 封堵认领，绝不改写 baseline 钉**——`recordBaselineDrift` 把调用方观测的仓库事实与版本钉住的 baseline 比较，追加 `baseline/drift-detected`，并在工作项上打开 `BASELINE_DRIFT` 外部阻塞，下一次认领被拒，直到 owner 解决、豁免或 supersede；baseline 列本身绝不移动（§21）。
- **doctor 是只读巡检**——`planDoctor` 一趟重验已导入版本：验收与 verifier 的存在性、层级与排序环、关系的项目内约束、事件时间线可解码，以及工作项/标准/租约状态的投影对等；全部独立问题连同版本身份、baseline 与行数一并报告。
- **plan 经由唯一目录解析**——`listPlans` 读取每个 `plans` 行及其 `current_version_id` 指针，按 project、plan id 排序；需要回答"哪个项目""哪个版本是 current"的消费方从这个清单推导，而不是重新拥有 `plans` 表语义。目录只读：行随 import 出现，指针随 supersede 移动。
- **item review 一次联读作答**——`readWorkItemReview` 按完整 id 或 stable key 解析单个工作项，返回每条验收标准及其投影状态与最新评估（判定、评估者、时间戳、解析后的 observed 载荷）；每条标准的最新行按评估时间选取，同毫秒并列以 append-only 的写入顺序决出。review 只读：评估与状态归各自的写入者所有。
- **digest 只聚合，不裁决**——`readProjectDigest` 读回每个 plan 的全部版本及其生命周期状态与 baseline、每个条目逐条标准的投影状态与最新评估（评估者、时间、observed 载荷），并内嵌重放对账结论；owner 无需 SQL 或逐条目命令即可读全量记录。
- **重放对账双向比对**——`readProjectReplay` 折叠项目的全量事件时间线，把重建投影与物化表逐族比对——plan 版本按身份事实、工作项、标准与租约按状态——物化侧多出的行与重放侧多出的实体同样算 drift。WorkPacket 只计入重放侧（recipe 即持久记录）；本构建无法解码的时间线只报告原因，不做半程比对。对账只读：parity 是事实，不是修复。

<a id="dev-note"></a>
## 开发备注

不发布运行时不变量伴随包：导入的保证由数据库自身约束加单个事务构成，编译趟是纯函数，不存在独立观察者会分歧的关系；宪法镜像与导入规则由包自身测试强制执行。

<a id="model-experience"></a>
## Model Experience

### 每个已准备任务一份有界 WorkPacket

#### What the model sees

`serializeWorkPacket` 输出一份规范 JSON 文档：packet 与 builder 版本、带内容哈希的有序引用清单、工作项目标、父 phase 摘要、带来源状态的阻塞关系回执、带存储 verification spec 的验收标准，以及 baseline 快照。其他工作项、其他 phase 或 plan 文档的内容一律不出现，本包自身也不注册任何 prompt 或工具。

#### Token effect

一个已准备任务贡献一块有界的逐项事实；verification spec 以存储文本到达，绝不是执行输出。对未变更行的重复准备输出相同字节，不新增内容。

#### KV Cache effect

对相同行确定：同一账本状态以相同键序与相同引用序序列化，未变更项的重复准备精确复现模型可见前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延迟工作

以下是当前包约束，不是任务清单。

- **尚无激活与 supersede**——导入绝不激活版本，且拒绝已属于其他版本或 backlog 的工作项；这些迁移由 supersede 流程负责，指向本项的 `SUPERSEDES` 边在其落地前不进入 readiness。
- **packet 尚无项目记忆引用**——§17 允许在存在持久记忆能力后加入显式关联的 memory 引用；v1 packet 不记录任何记忆引用，重建因此只读账本行。
- **todo 视图只是查询**——`/project todo --owner`/`--agent` 斜杠面与 `project_work_*` 工具属于命令接缝；v1.6b 把 executor identity 扩展为 actor/role/assignment（§11）。
- **尚无 carry-forward 绑定**——supersede 命名的继任版本只被记录、未被应用：重复声明继承的工作项属于 adoption 流程（§9.3），漂移阻塞的解决与豁免也尚无写入者。
- **`REVOKED` 是保留行状态**——租约生命周期只写 `ACTIVE`、`RELEASED` 与 `EXPIRED`；Owner 侧吊销尚无写入者，reaper 循环节奏（`reaperIntervalMs`）属于有界 `reapExpiredLeases` 批次的调用方。
- **英文诊断**——问题消息仅英文；它们是编译器输入，不是 UI 文案。
