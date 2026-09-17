# Agent Note: Project Ledger 工作租约

Status: implemented

[English](2026-09-16-project-ledger-work-leases.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W07「Work lease」（LEASE-001）：两个 claimer 竞争同一工作项时必须恰好产生一个活跃租约，过期租约必须可安全回收，过期或释放的认领必须以重算投影把工作项归还到 `READY`/`BLOCKED`——绝不宣布任务 `FAILED`（§13）。v1 词表的 `work/claimed`、`work/lease-heartbeat`、`work/lease-expired`、`work/lease-released`、`work/blocked`、`work/unblocked` 六个写入者尚缺，重放 fold 也必须能在移动租约与工作项并存的时间线上存活。

## 决策

`claimWorkItem` 在单个 `BEGIN IMMEDIATE` 事务内遵循 §13 概念顺序：重算 readiness、为本项回收陈旧租约、创建恰好一个活跃租约。`uq_one_active_lease_per_work` 部分唯一索引是最终仲裁者；竞争的 claimer 要么拿不到写锁（`SQLITE_BUSY`），要么串行在胜者之后并被重算出的活跃租约阻塞项拒绝。心跳与释放必须出示 bearer 令牌且在过期前到达；过期之后的一切属于 `reapExpiredLeases`——一个有界批次，为每条租约记录 `work/lease-expired` 并重算各项投影。

- **只有令牌持有者能续期或交还租约。** 认领返回一次性随机令牌；账本只存其 SHA-256 哈希，任何租约事件都不携带它，日志重建租约状态时无需重放机密。过期时刻及之后的心跳与释放会被拒绝而非复活租约——回收归 reaper 所有。
- **交还走重算，不做降级。** `work/lease-expired` 与 `work/lease-released` 只移动 `IN_PROGRESS` 项：重算排除其自身状态门与正被交还的租约，其余 readiness 输入决定 `READY` 还是 `BLOCKED`。生命周期已前移的项（`VERIFYING`、终态）保持状态、事件只记录它，reaper 因此无法复活 `DONE` 项。
- **`work/blocked`/`work/unblocked` 物化重算后的 readiness。** 它们只移动 `READY`/`BLOCKED` 对：干净的重算无可阻塞、受阻的重算无可解锁，其余状态一律拒绝。`work/blocked` 携带重算出的 reasons，物化状态因此可以从日志审计。
- **租约 id 由 claimed 事件的序列推导**（`ls:<workItemId>:<sequenceNo>`）；写入者预读分配（`nextProjectEventSequence`），因为 payload 必须先写明 id，而持有的 `BEGIN IMMEDIATE` 保证预读值等于追加信封的序列。重放 fold 现在携带租约表，重放 parity 覆盖完整租约生命周期；与已重放租约状态矛盾的心跳、过期或释放都会 fail closed。
- **`LeaseConfig` 在 resolve 时 fail loud**（`heartbeatIntervalMs < ttlMs / 2`，§13）；`ttlMs` 覆盖必须连同兼容的心跳一起给出，而不是与默认心跳静默混搭。

验证：`packages/experimental/project-ledger/tests/lease.spec.ts` —— AC 竞争在锁边界上以两条真实连接于事务中途对抗（一个 `SQLITE_BUSY`、一个活跃租约拒绝，恰一个活跃租约），外加唯一索引兜底；针对重算阻塞项的认领拒绝、claim 内的陈旧租约回收、令牌不匹配、心跳续期与过期拒绝、释放到 `READY` 与 `BLOCKED`、不动非在途状态的批量回收、claim 与 reaper 的触发器强制回滚、含租约生命周期的完整重放 parity，以及每个新 payload 形状的 fail-closed applier。该文件 33 个测试，包内 122 个，单文件 100% 覆盖。

## 已考虑的替代方案

**用两个线程或进程真实竞争做并发测试。** 拒绝——`node:sqlite` 是同步 API，进程内无法交错；子进程竞争只增加调度不确定性而不增加断言：失败方的结局就是锁边界测试已确定性钉住的两个分支之一（busy 或 readiness 拒绝）。

**Reaper 把被遗弃工作宣布为 `FAILED`。** 拒绝——§13 明令禁止；失败判定须经 `changeWorkStatus` 显式作出，reaper 只把项恢复进开放集或保持阻塞。

**把租约令牌（或明文）存进事件 payload。** 拒绝——令牌是 bearer 凭据；落盘哈希且不入日志意味着时间线泄漏不授予任何认领，只有租约表本身认证持有者。

**为六个新 applier 提升 `PROJECT_EVENT_FORMAT_VERSION`。** 拒绝——与 W05/W06 相同，词表本就包含这些类型，缺乏本构建的 v1 读取器按设计对其 fail closed；不存在更早构建写出的 v1 账本，提升版本只会宣告一个从未发布的先行世代。

## 后果

W08 把账本挂载进 mini profile：驱动以 `claimWorkItem` 认领、按其 `LeaseConfig` 节奏心跳、并调度 `reapExpiredLeases`；`work/blocked`/`work/unblocked` 为计划激活与 supersede 流程（W11）提供可复用的投影写入者；readiness 选项 `treatStatusAsOpen`/`ignoreLeaseId` 是未来任何「先重算、后落地自身变更」的写入者的文档化接缝。
