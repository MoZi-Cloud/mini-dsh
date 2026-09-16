# Agent Note：Project Ledger 工作就绪与状态迁移

Status: implemented

[English](2026-09-16-project-ledger-work-readiness.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W05「Work relations and readiness」（READY-001）：blocked 的工作不可被领取、层级不得充当依赖、环检测必须守护账本而不只是文档。readiness 必须决定自己读取什么、物化状态是否为真理、以及哪个写入者拥有 `work/status-changed`。

## 决策

`computeWorkReadiness` 从宪法列出的因果行重算可领取性（§12/§17）；物化的 `READY`/`BLOCKED` 状态只是这些输入的投影，绝不作为真理被读取。

- **状态门枚举开放集。** 只有 `PROPOSED`、`READY`、`BLOCKED` 对认领开放；中途与终态一律关闭。枚举开放侧让未知状态默认关闭。没有因果阻塞的陈旧 `BLOCKED` 重算为 ready——这次重算正是投影把行移回去的依据（§13）。
- **层级在构造上被排除。** `parent_work_item_id` 是组成关系（§10）；readiness 绝不读取它。验收测试让一个未 DONE 父项的子项保持可领取。
- **「parent phase active」读作对工作开放。** phase 接受 `READY` 或 `ACTIVE`；`PLANNED` 阻塞。尚无写入者能把 phase 置为 `ACTIVE`，所以这一较宽的解读是让导入的 `READY` phase 端到端可领取的前提。
- **阻塞边是源项未 `DONE` 的 `BLOCKS`/`PRECEDES`。** 指向本项的 `SUPERSEDES` 边属于 supersede 流程的投影（W11）。外部阻塞在 `OPEN` 时阻塞；required 标准在 `FAILING`/`BLOCKED` 时阻塞；租约在 `ACTIVE` 且未过期时阻塞。计划外 backlog（`plan_version_id` NULL）按设计跳过版本检查（§9.3）。
- **环语义只有一个家。** `relation-graph.ts` 拥有排序关系种类与两个 walks；`validatePlanSemantics` 与账本侧 `detectWorkGraphCycles` 共同消费它们，同一张图在文档与其产出行上永远得到相同判定。编译期问题的消息与抽取前逐字节一致。
- **`work/status-changed` 拿到通用写入者。** `changeWorkStatus` 按封闭迁移表工作，并拒绝专用事件拥有的迁移：认领（经 `work/claimed` 置 `IN_PROGRESS`）与 readiness 投影的 `work/blocked`/`work/unblocked`。重复提交当前状态是一次拒绝而非 no-op——no-op 写入会追加一个没有迁移的事件。`work/created` payload 现在携带初始状态，让重放 parity 覆盖状态字段；`PROJECT_EVENT_FORMAT_VERSION` 保持 `1`，因为不存在任何由旧构建写入的 v1 账本——版本门守护跨构建读取者，暗示存在前代格式是不实的。

验证：`packages/experimental/project-ledger/tests/readiness.spec.ts`——每种阻塞 kind 的开放与关闭两侧、层级独立性、陈旧状态重算、租约过期的两个时钟侧、含触发器强制回滚的完整迁移表、含跨项目跳过的环检测、以及穿越状态迁移的重放 parity。23 个测试，逐文件 100% 覆盖。

## 已考虑的替代方案

**信任状态字段。** 否——§17 明确 readiness 不是单一状态真理；信任 `READY` 会复活宪法明令禁止的陈旧投影认领。

**读取父项状态。** 否——§10 把组成与依赖分开；父项的进度绝不给子项的认领设门。

**第二个账本侧环 walk。** 否——重新实现会与编译期语义漂移；共享 walks 是两侧保持同一判定的唯一方式。

**为 payload 扩展提升事件格式版本。** 否——版本提升宣告一个读取兼容代际；在零个已发布 v1 账本的情况下它会宣告一个不存在的前代。

## 后果

W06（验收）填充 readiness 已经读取的标准状态；W07（租约）继承一个租约感知的 readiness，可在自己的 `BEGIN IMMEDIATE` 内调用，并补上 `work/claimed` applier；W11（supersede）用指向本项的 `SUPERSEDES` 边扩展 readiness。未来的激活写入者只需要行更新加 `plan/version-activated` 事件，即可打开 golden plan 的 W00 条目。
