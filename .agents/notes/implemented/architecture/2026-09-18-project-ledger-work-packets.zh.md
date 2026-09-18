# Agent Note: Project Ledger Work Packet

Status: implemented

[English](2026-09-18-project-ledger-work-packets.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W09（PACKET-001，BOOT-02）：全新 agent 必须通过有界、确定性的 WorkPacket 获得一个 ready 任务，且模型可见 packet 必须可从持久状态审计——重建 packet hash 等于最终请求 packet hash，且不需要 Master Plan 全文（§16/§17，AC-PACKET-001）。账本此前没有 packet 接缝：没有任何东西约束模型按任务看到的内容，也没有记录可重新推导它的配方。

## 决策

`work-packet.ts`（packages/experimental/project-ledger）拥有该接缝。`buildWorkPacket` 在单个 `BEGIN IMMEDIATE` 事务内运行，只读 §17 列出的逐项输入——plan/版本身份、工作项目标、父 phase 摘要、带来源状态的阻塞关系回执、带存储 verification spec 的验收标准、版本的 baseline 快照——组成有序引用 `{kind, refId, contentHash}`（每个内容哈希恰好覆盖该引用钉住的文档小节），把配方（身份字段加有序引用）哈希为 `packetHash`，强制序列化字节上限，并追加携带完整配方的 required 事件 `project/work-packet-prepared`。packet id 由事件序号推导，与租约 id 对称。

- **事件即配方；无物化 packet 表。** packet 可重建而非事实源，为它存行会让账本变成自身的派生索引。重放把配方折叠进 `workPackets`（按 packet id 键控，校验其命名的工作项并拒绝重复 id），`rebuildWorkPacket` 仅从当前行重组 packet——输入只有数据库和 packet id——在被钉住的行移动后报告 `matchesRecordedHash` 与漂移的引用 id。验收测试在文件账本的第二个连接上重建，证明 plan 文档绝不是输入。
- **有界意味着拒绝而非截断。** `serializeWorkPacket` 输出必须低于 `maxSerializedBytes`（默认 65,536），否则构建抛错；未规划（无版本）工作项以 `work-item-unplanned` 大声失败，因为 v1 packet 只读 plan 版本拥有的行。重建路径跳过上限检查：准备之后增长的行是漂移证据，不是障碍。
- **引用种类词表归事件编解码器所有。** `WORK_PACKET_REFERENCE_KINDS` 由 `project-events.ts` 拥有（如同 `ACCEPTANCE_CRITERION_STATUSES`），载荷校验因此无需从 packet 模块做运行时导入，packet→events 的导入方向保持单向。
- **v1 无记忆引用。** §17 允许"该能力存在时"的显式关联项目记忆引用；本构建没有支撑它们的持久载体，而配方引用必须是重建可重读的行，所以构建器不记录任何记忆引用，README 记录了该延迟。

验证：`packages/experimental/project-ledger/tests/work-packet.spec.ts`（14 个测试）覆盖 AC-PACKET-001，含文件账本重开重建、确定性、漂移点名、字节上限回滚、重放拒绝，以及无 phase/回执/标准的 ad hoc 工作项；三个 experimental 包共 170 个测试；per-file 100% 覆盖率保持。

## 备选方案

**物化 `work_packets` 表（schema v2 迁移）。** 否决——配方已携带身份、有序引用 id、有序内容哈希与 packet hash；表会重复事件并让账本索引自身。重放获得一个 map，对等校验即重建测试，schema 留在版本 1。

**对完整序列化文档而非配方计算哈希。** 否决——§16 固定了事件记录的字段（引用 id 与内容哈希），逐引用内容哈希已传递性地钉住每个小节；对文档哈希会把 packet hash 耦合到配方未命名的排版细节。

**接受来自构建选项的可选记忆引用。** 否决——重建只读持久行，配方引用必须可从数据库重读；选项提供的引用一旦被使用就会破坏 §16 重建证明。该接缝等待持久的记忆能力。

**让 `buildWorkPacket` 以 readiness 为门。** 否决——§17 的读取清单不含 readiness，且认领接缝（W07）已拥有它；为尚未就绪的项准备上下文是无害观察，而复制 readiness 门会让一个决策出现两个权威。

## 后果

请求侧（BOOT-02 的全新 agent、未来的 mini-profile 消费者）发送 `serializeWorkPacket(packet)` 并以 `packet.packetHash` 审计；session 日志之后可在请求时记录 packet hash，并在任意后续数据库上对 `rebuildWorkPacket` 证明相等。每次准备如今都记录全部 §16 字段，加入请求审计联动是消费侧变更，无需账本迁移。W11 落地 supersede/漂移处理时，`driftedReferenceIds` 直接提供逐引用证据。
