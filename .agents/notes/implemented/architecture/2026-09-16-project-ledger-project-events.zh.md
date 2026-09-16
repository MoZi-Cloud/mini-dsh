# Agent Note：Project Ledger 版本化事件与重放

Status: implemented

[English](2026-09-16-project-ledger-project-events.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W04「Project event format/projection」（EVENT-001）：未知 required 事件必须失败，未知 ignorable 事件必须保留重放，且重放必须等于物化投影。W03 把事件写入留成了导入私有的插入语句，`PROJECT_EVENT_FORMAT_VERSION` 在核心包与 SQLite 包各有一份，附件 §11 的读取语义没有任何东西强制执行。

## 决策

事件信封、词表与编解码器住进一个家：`packages/experimental/project-ledger`（`project-events.ts`）；SQLite 包不再导出格式常量——存储拥有物理布局，核心拥有事件语义。写入者继续只拿裸 `DatabaseSync`，依赖方向保持单向。

- **追加接缝同时校验词表与 ignorable。** `appendProjectEvent` 接受 §16 v1 类型与未注册名称，但 required 条目拒绝 `ignorable: true`（影响投影的语义不得藏进重放会跳过的行），未注册名称则必须带上它——这一对正是 §16 的前向兼容机制，在写入处显式化，而不是靠约定自觉。
- **读取对编解码器无法解释的东西 fail closed。** 以 required 落库的未知事件类型、外来的 `event_format_version`、无法解析的 payload，各自拒绝整条时间线（`readProjectEvents` 绝不返回部分解释的列表）；未知 ignorable 行保留在时间线中且不改变任何状态。观察性扩展不得抬高格式版本（§16），因此任何版本错配都意味着本构建无法推理的 required 编解码器演进。
- **重放是逐构建的折叠加一致性测试。** `replayProjectEvents` 只应用本构建已有投影效应的类型（`plan/imported`、`work/created`）；尚无效应的词表类型与 ignorable 外来行走文档化的 no-op 分支。未来的每个写入者都在同一个 PR 里补上自己的 payload 解码器与 applier，events 套件把折叠结果与直接从物化表读出的行做比较——这就是 BOOT-04 的模式，逐步延伸。
- **导入现在经由接缝追加事件**，序列分配、信封盖章与词表校验只剩一个实现；W03 的 parity-pin 测试随之失效，与它钉住的常量一起移除。

验证：`packages/experimental/project-ledger/tests/events.spec.ts`——golden 导入追加、按项目隔离的序列、两个追加拒绝、带解码 payload 的时间线读取、未知 required 事件 / 外来格式版本 / 不可解析 payload 的 fail-closed 读取、ignorable 保留、以及对物化 `plan_versions`/`work_items` 行的重放一致性加逐字段的 payload 形状拒绝。导入套件除移除的 pin 测试外原样全绿。

## 已考虑的替代方案

**把常量留在 SQLite 包、由核心包导入。** 否——这颠倒了 W03 确立的接缝：核心对物理存储产生运行时依赖，后续每个写入者（W05–W07、W11）都得照做。

**给 `appendProjectEvent` 配每类型 payload 参数。** 暂缓——v1 的十四个类型有十二个还没有写入者，现在定义只会造出空壳类型；接缝先收 JSON 对象，等携带 payload 的写入者落地时再同时给各自的 draft 配型。

**读取时容忍更旧的格式版本。** 否——v1 是第一个格式；容忍错配会把损坏或外来行变成静默降级的时间线，而不是响亮的错误。

## 后果

W05（readiness）、W06（acceptance）、W07（leases）与 W11（supersede）扩展 `PROJECT_EVENT_TYPES` 的前提是在同一个 PR 里带上各自的 payload 解码器、重放 applier 与重放一致性断言——本包的词表注册表、编解码器与 parity 测试架就是它们的扩展点。
