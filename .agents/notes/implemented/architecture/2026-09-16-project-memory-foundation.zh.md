# Agent Note: 项目记忆基础设施

Status: implemented

[English](2026-09-16-project-memory-foundation.md) | 中文

## 问题

mini-DSH 分级方案（docs/mini）在任何项目账本把计划目标绑定到代码之前，需要仓库智能基础设施：仓库内容的持久记录（符号、调用图、文档）与有界的检索方式。上游没有这样的存储——SQLite 只作为 KV 后端与可重建的 FTS 索引出现——整个树里也没有符号或调用点提取器。

## 决策

在新的 `packages/project/` 组下引入两个库包，作为经评审的 v1.6a 垂直切片的存储基础：

- `dsh-project-memory`——SQLite 事实源存储（不是可重建缓存）：单调 `PRAGMA user_version` 且版本不符拒绝、`foreign_keys=ON`、受验证的 journal 模式、owner-only 文件创建；v1 表集覆盖内容库、源码现实（repositories、snapshots、files、symbols、symbol_versions、imports、call_sites、symbol_references、`project_objects`）、Markdown 大纲（`document_headings`）与项目知识（记忆+证据、分析单元+历史、运行事件）。嵌套 `transaction()` 退化为 savepoint，组合的辅助函数因此加入调用者的事务。
- `dsh-project-analysis`——索引器：纯文件系统的 git HEAD 解析（loose refs、packed refs、linked worktree、commondir）、确定性文件/文档遍历、句法 AST 提取，以及遍历程序自身 SourceFile 并解包 import 别名的 TypeChecker 提取，使跨文件调用边落到声明文件。只有边链接到已存符号版本时才写 `resolved`；重载集获得带次序号的 stable key。一次运行在单个事务内提交一个 append-only 快照。

4K 上下文车道在此定义：任何喂给 worker 上下文的有界检索都 fits 经评审的 4,096 token 预算（确定性的 UTF-8 字节÷4 估算器；放不下的章节显式报告，绝不悄悄塞入）。门是合成仓库上的包内 `context-lane-4k` 规范——基准树自身的规则禁止把语义断言混入 `test:bench`。

尚未发布 Cordis 服务 seam：两个包都是单实现库，没有第二个 provider 或运行时消费者，此时建 seam 只是为 seam 而 seam。账本层在其消费者（profile 命令、工作工具、packet 构建器）到来时再定义 Service Definition。不发布 `./invariant` 伴随包：这里没有任何能在独立视点间分歧的观测。

## 考虑过的替代方案

**现在就挂到 `ctx.service`。**推迟——只有一个实现且没有消费者角色的 seam 违反 current-owner 规则；账本层将面向真实消费者定义 seam。

**把会话或日志存进这个数据库。**拒绝——会话日志留在 session-persistence 平面；本存储只记录仓库事实、记忆与运行标记。

**只用名字解析调用边（默认句法级）。**拒绝作为默认——名字级边在重载与跨文件遮蔽下会错误解析；TypeChecker 提取是默认，句法级保留为显式的廉价模式。

**为车道在 `benchmarks/` 建墙钟基准条目。**拒绝——该树的契约禁止把基准完成变成语义断言；确定性预算门属于包测试。

## 后果

索引 harness 仓库自身（排除 vendor/native/website/python/snapshots/benchmarks）在 `typechecker` 级别约需两分钟与提高的堆上限：6,805 个文件（3,216 篇 Markdown 文档、33,235 个标题）、28,725 个符号版本、384,549 个调用点（65,445 resolved、224,777 external、91,583 unresolved、2,744 dynamic）与 35,871 个项目对象，作为钉在当前 HEAD 的一个 worktree 快照提交。被排除在遍历之外的依赖记为 `external`，绝不展开。

验证：50 个包测试（存储生命周期、版本拒绝、内容去重、调用图查询、事务 savepoint、packet 预算与省略、HEAD 解析变体、提取器 fixture、重载消歧、文档结构化），加上断言合成工作负载零溢出包的车道规范。两个包的覆盖率由仓库覆盖率门强制执行。
