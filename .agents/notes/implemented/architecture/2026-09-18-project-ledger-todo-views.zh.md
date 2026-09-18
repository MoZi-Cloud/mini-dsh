# Agent Note: Project Ledger Todo 视图

Status: implemented

[English](2026-09-18-project-ledger-todo-views.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W10（TODO-001，BOOT-03）：Owner 与 Agent 的 work 查询必须相互独立，且 session todo 完成不能直接完成项目工作项（§11、§5.3，AC-TODO-001）。账本此前只有逐项查询（`computeWorkReadiness`）而没有清单面：没有任何东西回答"这个执行者还有什么未完成"，§11 的分离只以数据（`executor_kind`）存在，不是一个接缝。

## 决策

`todo-views.ts`（packages/experimental/project-ledger）拥有该接缝。`resolveWorkTodoSpec` 是显式的 request/spec 步骤：省略种类过滤默认为全部 executor kind，显式过滤去重并排序以保证查询与回显 `executorKinds` 稳定，显式空过滤大声失败（`empty-executor-kinds`）而不是静默列出空集。`listWorkTodo` 跑一条只读查询——executor 种类 × 非终态状态，按种类、优先级降序、年龄、id 排序（与 `idx_work_items_ready` 列序一致）——并为每个条目附加重算的 readiness（与认领用的同一个 `computeWorkReadiness`，绝不信任物化状态）与活跃租约（`ACTIVE` 且未过期，因此过期未回收的行不会显示为被持有）。`listOwnerTodo` 与 `listAgentTodo` 是把过滤固定为 `OWNER` / `AGENT` 的 §11 视图，即 `/project todo --owner` 与 `--agent` 将投影的查询。

- **视图绝不变更。** 任何视图路径都不移动状态、不记录事件、不暴露写入：完成权威留在 `changeWorkStatus` 的验收门，认领留在租约接缝，该模块完全不拥有写入者。
- **边界是行为的，早已强制，如今在 AC 测试中钉死。** session todo 没有稳定 item id 与项目身份，状态写入者也没有接受外部"已完成"标志的 API：`todo-views.spec.ts` 展示 `DONE` 从非 `VERIFYING` 状态被拒（`transition-not-allowed`）、在 required 标准未决时从 `VERIFYING` 被拒（`acceptance-not-passed`）、仅在评估移动标准后可达——随后已完成项离开视图。`bridges.spec.ts`（W08）另行钉死 `dsh-tool-todo` 不声明账本依赖。
- **v1.6b 延展轴，而不是另起平行接缝。** §11 推迟 actor/role/assignment；它落地时扩展种类过滤，两个命名视图保持契约不变。

验证：`packages/experimental/project-ledger/tests/todo-views.spec.ts`（8 个测试）覆盖 AC-TODO-001——spec 解析、黄金计划上的分离（owner = 唯一 OWNER 项及其重算阻塞项；agent = 14 个 AGENT 项，互不相交、有序）、认领后的活跃/过期租约展示、混合种类排序、无 phase 的 ad hoc 项、以及端到端的完成边界；包内 173 个测试；per-file 100% 覆盖率保持。

## 备选方案

**一个参数化函数加文档约定来区分 owner/agent。** 否决——§11 命名了两个视图；命名接缝（`listOwnerTodo`/`listAgentTodo`）让分离成为 API 而非调用方纪律，同时 `listWorkTodo` 保留给通用与未来的 actor 过滤查询。

**按 readiness 过滤只列可执行工作。** 否决——隐藏受阻工作的 todo 会隐藏工作卡住的原因；条目携带重算的阻塞项，`--owner` 恰好向 owner 展示是什么拖住了他们的项（未激活的 plan 版本、未解决的外部阻塞、失败的标准）。

**在此构建 `/project todo` 斜杠命令。** 否决——账本是 cordis-free 的库（W08 的隔离设计）；命令面属于 mini profile，AC 的验证器落在查询接缝上。

## 后果

W12 真实使用切片与任何 mini-profile 命令都可以直接从这些查询投影 `/project todo --owner`/`--agent`，账本侧没有剩余工作；`WorkTodoEntry` 的 readiness 加租约形态让展示无需逐项二次查询。v1.6b 加入 actor/role/assignment 时，`resolveWorkTodoSpec` 是默认值与校验的唯一居所。
