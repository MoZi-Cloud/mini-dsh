# Agent Note：计划版本 2、lane 的 supersede 流程与 /project item 审视

Status: implemented

[English](2026-09-18-plan-v2-supersede-and-item-review.md) | 中文

## 问题

post-v1.6a 增量计划的版本 1 已全部经账本完成，§33 记录只能靠新的计划版本增长——但版本更替从未在真实账本上行使过：`supersedePlanVersion`（§22）只有单元覆盖，real-use lane 用单行查找解析"那个"计划版本（第二个版本会让它变得歧义），且计划文档升版本会对已导入的版本 1 触发 `version-conflict`，除非条目本身更换。另一面，账本如今存储的证据（逐标准判定附带 exitCode 与输出尾部）只能经 SQL 读到：§33 要求确认账本价值的 owner 无法读到任何工作项为何通过或失败。

## 决策

三件事一同落地。其一，计划文档升到版本 2 并使用全新条目 key（`PW-ITEM-REVIEW-001`、`PW-REPLAY-VIEW-001`）——import 把 stable key 视为项目级，重新声明版本 1 的条目会失败；一个版本是新工作的全新快照，已完成的版本 1 条目留作历史。其二，lane 改按 `(plan_id, version_no)` 解析版本：导入文档当前版本，经 §22 接缝 supersede 同计划任何其他 ACTIVE 版本并指名继任者，再激活——两个 owner 动作均为裸更新，沿固定 fixture 确立的激活先例；临时账本只导入 v2，持有 ACTIVE v1 的持久账本记录 supersede 事件且版本 1 每一行逐字节不变。其三，面向 owner 的答案：新的 `readWorkItemReview` 账本读取接缝按完整 id 或 stable key 解析单个工作项，并把每条验收标准与其最新评估联读（判定、评估者、时间戳、解析后的 observed 载荷；最新行按评估时间选取，同毫秒并列以 append-only 写入顺序决出——评估 id 的序号跨数字位数时不按数值排序）；`/project item <stable-key-or-id> [<project-id>]` 渲染它——标准状态、最新评估附带观察到的 exitCode、以及每条标准折叠为单行的 160 字符输出尾部摘录。

验证：ledger 套件新增 `work-item-review.spec.ts`（按 key 与按 id 解析、同毫秒 latest-wins、歧义 ref 拒绝、无版本的 backlog 行），mini-profile 命令套件覆盖审视渲染、可选标准、无尾部或无 exitCode 的载荷、摘录截断、backlog 的 `version none` 行——两包逐文件 100%；lane 在临时账本（v2 全新导入）与持久 profile 账本（v1 于事件序号 29 被 supersede，`PW-ITEM-REVIEW-001` 由 `agent:mini-real-use-lane` 完成 DONE、doctor 0、重放 DONE）绿色，随后重跑幂等；4K 切片保持绿色，峰值 2,444/4,096 估算 token。

## 曾考虑的替代方案

**保持单一版本并向其追加条目。** 否决——import 把版本钉在其源文档哈希上；编辑条目清单产生的不同文档不得静默改写账本已验证的版本。版本是计划变更的单位，§22 正是为这次更替而存在。

**让 lane 挑"ACTIVE 的那个版本"而不是文档的版本。** 否决——lane 驱动的是树中的计划文档；按 `(plan_id, version_no)` 解析使运行可从检出复现，并让过期文档响亮失败，而不是驱动树已不再指名的版本。

**命令层直接用 SQL 读评估。** 否决——命令面只消费读取接缝（`listPlans` 先例）；在消费方重新拥有 `acceptance_evaluations` 语义会复制接缝本应独有的 latest-per-criterion 规则。

**展示每条标准的全部评估历史。** 否决——owner 的问题是"这个工作项为何处于当前状态"；最新评估即可作答，更少见的审计需要历史时仍可经账本自身的表查询。

## 后果

计划演进从此有了端到端的真实使用记录：后续增量升版本，lane supersede 并驱动首个条目，日志计数持续增长而无需手工账本操作。§33 的 owner 价值确认对话多了一个可读表面——`/project item` 展示记录在案的证据，而不只是状态。Backlog 行（无计划版本）仍没有写入者；review 与 readiness 接缝都对其建模，无论哪个写入者先到来都有一致的读法。`PW-REPLAY-VIEW-001` 在版本 2 中保持可领取，作为下一个增量。
