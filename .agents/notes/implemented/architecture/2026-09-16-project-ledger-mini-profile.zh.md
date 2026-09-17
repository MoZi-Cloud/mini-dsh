# Agent Note: Project Ledger mini profile 挂载

Status: implemented

[English](2026-09-16-project-ledger-mini-profile.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W08（INTEGRATE-001）：Project Ledger 必须经由 `dsh --profile mini` 挂载——唯一受支持的启动形态，不新增包 bin——并且 Project Ledger、plan mode 与 session todo 工具之间的权威边界需要有针对性的测试（§4-§6，AC-INTEGRATE-001/002）。此前账本是纯库：没有任何东西在真实 profile 中打开数据库，也没有任何东西阻止其他界面宣称完成权威。

## 决策

新增实验性 profile bundle `@deepseek-ai/dsh-experimental-mini-profile`（packages/experimental/mini-profile），在 `dsh-base` 之上叠加一个插入。其 `mini-project-ledger` 插件拥有能力的生命周期：schemastery 校验的 `ledgerPath`（由 patch 从 `DSH_MINI_LEDGER_PATH` 解析、带回退到 dsh home）与 `busyTimeoutMs`；异步服务 init 经 SQLite store 的 fail-closed 打开数据库，store 完成迁移与盖章后整棵树才算就绪；并交出一个关闭句柄的释放器。服务注册为 `ctx.projectLedger`，暴露已打开的句柄；它刻意不拥有任何账本语义——消费者调用接缝函数，库保持无 cordis 依赖，提供者保持单薄。

本 bundle 刻意不加入 `PROFILE_TEMPLATES`，`apps/cli` 也不依赖它：默认产品隔离门拒绝任何发布组合与安装默认中的实验性包，而账本包被钉在 experimental 组（§6）。`mini` profile 走普通流程创建——`dsh --profile mini` 在 `dsh-base` 之上初始化，随后 `dsh plugin --profile mini add @deepseek-ai/dsh-experimental-mini-profile` 把 bundle 作为持久依赖挂上——既保住「`dsh --profile mini` 是唯一启动形态、无 bin」，又让能力保持私有实验验证。

- **完成权威移入账本（§5.3）。** `changeWorkStatus` 现在在任何 required 标准未达 `PASSING` 或 `WAIVED` 时拒绝 `VERIFYING -> DONE`（`acceptance-not-passed`），叠加在既有闭表（只允许从 `VERIFYING` 到 `DONE`）之上。`todo completed != project work item done` 现在由账本自身强制，而非靠约定。
- **边界在真实存在的接缝上测试。** `bridges.spec.ts` 钉住清单解耦（agent-loop、agent、plan-mode、tool-todo 均不声明账本依赖；账本不声明任何 harness 运行时依赖）、纯编译步骤与唯一显式导入接缝、面对后续 plan 文档编辑的版本不可变性（`version-conflict`）、`DONE` 的闭合可达性，以及端到端的验收门。它同时钉住隔离形态：`PROFILE_TEMPLATES` 无 `mini` 条目，bundle 无 `bin`、只挂载一行。

验证：`pnpm run verify-application-entrypoints` 绿；`packages/experimental/project-ledger/tests/bridges.spec.ts`（5 个测试）对应 AC-INTEGRATE-002；`packages/bundle/mini/tests/`（5 个测试）覆盖精确组合与打开/服务/释放生命周期；账本与新 bundle src 单文件 100% 覆盖；两包合计 132 个测试。

## 已考虑的替代方案

**把 provider 插件放进 `dsh-experimental-project-ledger`。** 拒绝——账本会在任何消费者出现之前长出 cordis peer 依赖与插件协议面；§6 让 v1.6a 包保持私有能力验证，bundle 才是 profile 胶水所在（headless bundle 先例）。

**在服务上暴露账本操作的类型化门面。** 暂时拒绝——在每个消费者落地（W09 WorkPacket、`/project` 命令）之前，每个方法都是未测试的透传。句柄加 store 自身的打开契约是最小的诚实接缝；类型化方法随消费者增长。

**在插件内部给账本路径设默认值。** 拒绝——随部署变化的取值属于由组合提供的、经校验的 config；patch 负责解析环境覆盖与 dsh-home 兜底，插件对空路径 fail loud。

**把 `mini` 发进 `PROFILE_TEMPLATES`、bundle 放在 `packages/bundle/`。** 拒绝——`verify-default-product-isolation` 遍历每个发布模板与 CLI 依赖，并在其中拒绝实验性包；该门与 §6 的 experimental 位置就是仓库权威，因此挂载以「按 profile 挂载的实验性 bundle」方式随行。

**让 `changeWorkStatus` 保持纯表驱动、把权威当约定测试。** 拒绝——§5.3 规定验收是完成权威，只靠清单 grep 守住的边界不是边界；该门是既有事务内的一条查询，并带着未决标准 id fail loud。

## 后果

W09（WorkPacket）与 `/project` 命令面可以在 mini profile 中直接读取 `ctx.projectLedger.db` 而无需新接线；真实工作的完成现在总是在 `work/status-changed` 事件之前留下 `acceptance/evaluated` 轨迹，强化重放作为审计记录；未来的吊销或激活写入者可进入同一词表而不触碰本挂载。
