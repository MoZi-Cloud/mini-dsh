# Agent Note: Project Ledger 版本 Supersede 与 Baseline 漂移

Status: implemented

[English](2026-09-18-project-ledger-versioning.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W11（VERSION-001，BOOT-08）：被 supersede 的 plan 版本必须仍可查询、新认领必须停止、进行中的尝试必须要求 review、历史评估必须保持不变（§21/§22，AC-VERSION-001）。版本生命周期此前只有行与词表（`SUPERSEDED`、`superseded_at_ms`、`plan/version-superseded`、`baseline/drift-detected`）而没有写入者：激活与退役只以测试里的 raw UPDATE 存在，也没有任何东西回应已偏离版本钉住 baseline 的仓库。

## 决策

`versioning.ts`（packages/experimental/project-ledger）拥有这两个写入者。`supersedePlanVersion` 在单个 `BEGIN IMMEDIATE` 内退役一个 `ACTIVE` 版本：追加 required 事件 `plan/version-superseded`（载荷：plan id、版本 id、可选继任者、`freeze-new-claims-and-review-active` 策略、活跃尝试的 review 队列），只移动生命周期列，并在 `plans.current_version_id` 指向被退役版本时重指它。`recordBaselineDrift` 把调用方观测的仓库事实与版本钉住的 baseline 比较，追加 `baseline/drift-detected`，并在工作项上打开 `BASELINE_DRIFT` 外部阻塞——漂移 id 由事件序号推导（`dr:<workItemId>:<sequence>`），与租约、packet id 对称。

- **冻结与 review 来自既有接缝，而非新增门。** 版本变为 `SUPERSEDED` 后，`computeWorkReadiness` 以 `plan-version-not-active` 拒绝每个新认领；活跃尝试保留租约与版本绑定，release/reap 路径的投影重算让它们落 `BLOCKED`——绝不复活——恢复是 owner 的 rebind 决策。review 队列就是事件载荷加返回的 `reviewAttempts`；不为它发明阻塞行。
- **不可变性按列限定。** supersede 只触碰 `status`、`superseded_at_ms` 与 plans 指针；source/IR 哈希、baseline 钉、工作项版本绑定与每条评估行逐字节不变；drift 绝不移动 baseline 列——观测事实只活在事件与阻塞行里。
- **两个 applier 只做校验。** 重放折叠 `plan/version-superseded` 与 `baseline/drift-detected` 而不产生投影状态：它们的写入者拥有生命周期列与外部阻塞行，而 fold 的版本事实不携带这些。fold 仍对命名未知版本或条目、plan id 不匹配、错误策略字面量、双重退役或字段类型错误的载荷 fail closed。`SUPERSEDE_POLICY` 归事件模块所有（如同 packet 引用种类），载荷校验因此无需从 versioning 模块做运行时导入。
- **未钉 baseline 的版本不能漂移。** 两列皆 null 意味着什么都没钉，漂移无定义（`baseline-unpinned`）；等于钉的事实不是漂移（`baseline-unchanged`）。两者都大声失败而不是记录噪声。

验证：`packages/experimental/project-ledger/tests/versioning.spec.ts`（8 个测试）覆盖 AC-VERSION-001——黄金计划上退役/冻结/review/历史的端到端、继任者与各拒绝路径、经真实钉 baseline 的 plan fixture 记录漂移并封堵认领且钉不被触碰、部分钉住的 baseline、以及 fail-closed 的重放用例；三个 experimental 包共 186 个测试；per-file 100% 覆盖率保持。

## 备选方案

**为需要 review 的尝试写 `APPROVAL` 阻塞行。** 否决——外部阻塞是 owner 侧的世界事实（且此前没有任何写入者）；把 review 队列复制进一张 fold 不投影的表只增加状态而不增加读者。事件载荷就是持久队列，尝试自身的租约生命周期已承载 review 所决定的走向。

**在重放投影中跟踪版本状态。** 否决——对等校验把 fold 与物化行比较，而激活没有写入者与事件 applier，重放出的状态会与测试经激活接缝设置的行分叉。等激活写入者随其事件落地时，重放可以在真实对等校验的支撑下再长出该字段。

**在本包内解决或豁免漂移阻塞。** 否决——解决是 owner 决策（修复、豁免或 supersede）；在此发放豁免写入者会让同一接缝既制造又解除阻塞，正是 §21 禁止的静默 rebind 形态。

**把漂移计算放进认领路径。** 否决——账本看不见仓库；§21 的比较是调用方报告的观测，写入者因此接收观测事实，并在其等于钉或版本从未钉过时大声失败。

## 后果

W12 真实使用切片可以在继任版本出现的那一刻退役黄金 v1 版本；任何认领时集成都可以用它已经观测到的仓库事实调用 `recordBaselineDrift`；阻塞种类走既有 readiness 阻塞面，todo 视图与 readiness 无需改动。carry-forward/adoption 流程（在继任版本下重复声明继承的工作项，§9.3）仍隔着一个 import 的 `work-item-conflict`——那是下一版本的接缝——漂移阻塞的解决同样保持 owner 侧，直到该流程落地。
