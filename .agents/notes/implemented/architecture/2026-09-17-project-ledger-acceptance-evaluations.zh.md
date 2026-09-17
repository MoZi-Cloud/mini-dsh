# Agent Note：Project Ledger 验收评估

Status: implemented

[English](2026-09-17-project-ledger-acceptance-evaluations.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W06「Acceptance and verifier storage」（ACCEPT-001）：评估必须追加历史、标准行的状态必须作为投影移动、整体必须能从事件时间线重建——同时本包保持绝不执行 verifier（§9）。重放 fold 还必须决定验收标准住在哪里，因为 v1 没有创建标准的事件。

## 决策

`evaluateAcceptanceCriterion` 在单个 `BEGIN IMMEDIATE` 事务内记录调用方报告的结果：append-only 的 `acceptance_evaluations` 行、标准的投影状态、以及 `acceptance/evaluated` 事件。没有任何代码带着运行意图去读 `command_text`——结果就是调用方报告的那个值，这也让 driver、人工确认或未来的引擎各自拥有真正的执行。

- **`ERROR` 只记历史、不动投影。** result-to-status 映射为 `PASS`、`FAIL`、`BLOCKED`、`WAIVED` 产出状态；一次出错验证没有产出判定，标准保持当前状态。事件 payload 无论如何都携带评估后状态，重放 applier 因此保持全函数。
- **标准经 `work/created` 进入 fold。** v1 词表没有标准创建事件，而标准随其工作项一起创建，所以 `work/created` payload 现在携带它们（id、ordinal、kind、required，以及显式的初始 `PENDING` 状态），重放后的工作项持有 criteria map。重放 parity 由此端到端覆盖标准状态；指派未知工作项或未知标准的 `acceptance/evaluated` 让重放 fail closed。
- **评估行 id 从事件序列推导**（`ev:<criterionId>:<sequenceNo>`）：行与其事件诞生于同一事务，无需计数器查询即互相引用。
- **readiness 闭环合拢。** W05 的 readiness 读取处于 `FAILING`/`BLOCKED` 的 required 标准；评估为 `WAIVED` 或 `PASS` 经同一批行解除工作项阻塞，验收测试对 `computeWorkReadiness` 断言了这条链。

验证：`packages/experimental/project-ledger/tests/acceptance.spec.ts`——每种 verifier kind 的 tagged 列原样存储、存储命令绝不运行的阴性证明（不可运行的命令照样评估出 `PASS`）、完整的 result-to-status 表、作为纯历史的 `ERROR`、跨重评估的 append-only 历史、未知标准的无写入拒绝、触发器强制的回滚、穿越评估的重放 parity、以及 readiness 闭环。文件集内 27 个验收与编解码测试，逐文件 100% 覆盖。

## 已考虑的替代方案

**执行 verifier 并记录结果。** 否——§9 禁止 Project Ledger 执行 `command_text`；接缝保持存储加投影，执行属于拥有这次运行的 driver。

**导入时每个标准一个事件。** 否——v1 词表没有这种事件，而且 16 条额外事件会重复 `work/created` 已绑定到其工作项的事实；把标准放进 created payload 是唯一无需词表扩张就能保持重放全函数的分解。

**推导初始状态而非存储。** 否——假设 `PENDING` 的解码器是在悄悄猜测；显式字段让每个 payload 自描述，并让编解码器对其他任何值 fail closed。

**为 payload 扩展提升 `PROJECT_EVENT_FORMAT_VERSION`。** 否——同 W05：不存在任何由旧构建写入的 v1 账本；提升会宣告一个从未发布的前代。

## 后果

W07（租约）可以在包含失败标准的 readiness 上设认领门，并针对事件维护的标准投影做回收；W09（WorkPacket）读取同一批 tagged spec 行告诉 agent「完成」意味着什么；未来的 verifier 执行 driver 经 `evaluateAcceptanceCriterion` 报告结果，而不是让本包继续生长。
