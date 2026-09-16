# Agent Note: Project Ledger SQLite 存储层

Status: implemented

[English](2026-09-16-project-ledger-sqlite-store.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W02 "Ledger SQLite 身份/运行时"（DB-001）：十三表 Ledger Core schema 需要物理归宿，带 fail-closed 打开顺序——`user_version` 身份、WAL 与 busy timeout、仅属主文件、不匹配拒绝——外加相邻迁移方案，而此时计划导入或事件追加都还不存在。当唯一已发布的布局版本就是 1 时，验收 fixture 必须说清"升级不丢数据"是什么意思。

## 决策

一个包 `packages/experimental/project-ledger-sqlite` 拥有持久化身份：v1 DDL、打开顺序与迁移引擎。`openProjectLedgerDatabase` 创建仅属主文件，应用 `foreign_keys`/`journal_mode`/`busy_timeout`，再经 `applyProjectLedgerMigrations` 把 `user_version` 推到当前值。

- **初始物化就是迁移 `0 → 1`。** 版本 0 是"空库或被打断"，不是已发布布局：该步骤用 `IF NOT EXISTS` 建 v1 表，`COMMIT` 与落戳之间崩溃时版本仍是 0，下次打开无损重试。戳只在所有步骤提交后落笔。未来布局变更恰好追加一个冻结步骤；跳版本或止步于构建版本之前的注册表会被引擎拒绝。
- **健康检查属于 fixture，不属于打开路径。** 附件的 `foreign_key_check`/`integrity_check`/行平价协议在套件中按迁移 fixture 执行；每次生产打开都跑 `integrity_check` 会全库扫描却没有额外保护。fixture 模拟崩溃窗口（表已存在、版本戳重置为 0、行已提交），在唯一已发布步骤上断言版本恢复与行平价。
- **附件 SQL 逐字转写，不重新推导。** 每张表定义、CHECK、唯一约束与索引都与 v1.6a 附件文本一致；套件钉住精确的表与索引集合、`plans` 无 status 规则、STRICT 类型强制、逐子边的外键覆盖、标记行 verifier CHECK，以及单活跃租约部分唯一索引。
- **W02 不交付类型化数据访问。** 包接口就是打开顺序；计划导入（W03）、事件信封（W04）、就绪（W05）、验收存储（W06）与租约（W07）在此追加各自方法，让每个能力的事务规则与其 API 一起落地，而不是养出一个通用逃生口。

验证：24 个包测试覆盖 DB-001 矩阵——全新打开、未知版本拒绝且文件原样、被打断物化的迁移 fixture、注册表跳版/止步/回滚，以及上述 schema 契约检查；包源码每文件覆盖率 100%。

## 已考虑的替代方案

**在每次打开时运行 `foreign_key_check`/`integrity_check`。** 拒绝——两个扫描都与库大小线性，且防不住步骤事务性已经防住的东西；fixture 协议把保证留在真实生效的位置。

**把迁移列表作为代码烙进打开函数。** 拒绝——注册表是数据，未来一步只需追加一条带描述的条目；引擎的跳版/止步拒绝可在不伪造数据库的情况下单元测试。

**现在就交付带 `transaction()` 的 `ProjectLedger` 包装类。** 就本工作包拒绝——没有数据方法就没有可事务的东西，公开裸 SQL 逃生口会诱使调用者绕开 W03+ 拥有的能力接缝。

## 后果

W03 的编译器直接对着 `openProjectLedgerDatabase` 导入：布局已存在，外键与 STRICT 由 SQLite 强制，幂等重物化与落戳恢复已是经过测试的行为。将来加布局 v2 意味着追加一个 `ProjectLedgerMigration` 条目和一个 fixture——引擎与 fixture 协议不变。
