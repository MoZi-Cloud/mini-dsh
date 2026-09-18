# Project Ledger（项目账本）

[English](project-ledger.md) | 中文

Project Ledger 是仓库工作的 Plan-as-Data 事实源：plan 文档经解析、校验、编译写入不可变的版本化行，此后的每次变更都以版本化项目事件追加。重放项目的事件时间线即重建物化表所存的投影，账本完整性随时可以只读核验。

## 挂载账本

`mini` profile 组合挂载 [`dsh-experimental-mini-profile`](../../packages/experimental/mini-profile/README.zh.md)，其 `mini-project-ledger` 插件经 store 的 fail-closed 打开（owner-only 文件、PRAGMA、相邻迁移、版本戳）打开 SQLite 数据库，并以 `ctx.projectLedger` 暴露句柄。挂载在加载时校验 `ledgerPath` 与 `busyTimeoutMs`；戳版本高于本构建的数据库会拒绝启动而非降级。账本路径来自 `DSH_MINI_LEDGER_PATH`，带回退到 dsh home。

## 经接缝做工作

没有任何表面直接写账本表。[`dsh-experimental-project-ledger`](../../packages/experimental/project-ledger/README.zh.md) 拥有全部接缝：导入 plan 版本、重算工作 readiness、租约生命周期、追加验收评估、supersede 版本、记录 baseline 漂移、构建有界 WorkPacket。两个 profile 表面消费它们：

- `/project` 命令只读：按 executor kind 的 todo 视图、plan doctor、带观察证据的条目审视、把重建投影与物化行双向比对的重放对账、以及聚合 plan 版本、条目完成度（含最新判定）与重放结论的证据摘要。
- `project_work_next`、`project_work_claim`、`project_work_update` 三个工具让 agent 经每任务一个有界 WorkPacket 处理同样的工作；领取持有的 bearer token 绝不进入模型可见值。

## 完整性是事实，不是修复

评估是 append-only 历史，状态是投影；验收是唯一的完成权威，会话 todo 或 plan 编辑都无法把工作抄近路到 done。doctor 一次扫描复验已导入版本，重放对账报告事件与行的任何分道——两者都不变更、不执行 verifier 命令。WorkPacket 只携带记录在案的 recipe；重建从当前行重组 packet 并指名漂移之处。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxprojectledger--miniprojectledger"></a>

### `ctx.projectLedger` — `MiniProjectLedger`

The mounted Project Ledger capability, exposed as `ctx.projectLedger`.

Source: [`packages/experimental/mini-profile/src/index.ts`](../../packages/experimental/mini-profile/src/index.ts)
<!-- END GENERATED cordis-surface -->
