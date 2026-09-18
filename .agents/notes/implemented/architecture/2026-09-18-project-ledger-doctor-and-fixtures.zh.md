# Agent Note: Project Ledger Doctor、fixtures 与 v1.6a 验收

Status: implemented

[English](2026-09-18-project-ledger-doctor-and-fixtures.md) | 中文

## 问题

v1.6a BOOT 验收（docs/mini/v1.6a §29/§32/§34）在 W12 之后发现两个具体缺口：F05 的 `planDoctor`——BOOT-01 写明 "golden plan import + doctor = 0 errors"——只以被提及的接缝存在；§2 钉住的工件 `fixtures/project-ledger/v1.6a-empty.db`/`v1.6a-populated.db` 缺席。其余 BOOT 与 DoD 条目在 W01–W12 已各有 verifier；本趟还欠 §34 的结构化最终报告。

## 决策

`doctor.ts`（packages/experimental/project-ledger）把 F05 实现为对已导入版本的一趟 fail-closed 只读巡检：逐项验收存在性、逐标准 verifier 存在性、经共享 `detectWorkGraphCycles` 的层级与排序环、关系的项目内约束、可解码的事件时间线（任何解码失败归为一条 `event-timeline-unreadable` issue——doctor 只报告、不诊断），以及工作项/标准/租约状态的投影对等（BOOT-04 作为检查）。报告携带版本身份、baseline 钉、`PRAGMA user_version` 与行数作为事实；环类 issue 携带整个环而非单个 refId，因为一个环命名多行。未知版本在接缝处抛错。

`scripts/gen-project-ledger-fixtures.ts` 以固定时间戳再生两个钉住数据库（`journalMode: 'delete'`，无 WAL 旁文件）：空库是 open/迁移/拒绝降级探针；填充库只用真实写入者驱动黄金计划——激活是有据可查的 owner 接缝，两个 BLOCKS 来源与主打项经 claim → VERIFYING → 评估 → DONE 完成——终止于 28 个事件、每张表都有行、doctor 通过零 issue（生成器在 doctor 有异议时失败，因此漂移的 fixture 永远出不了厂）。

`docs/mini/v1.6a/fork-mini-DSH-v1.6a-BOOT-acceptance.zh.md` 即 §34 报告：版本、表与索引、迁移 fixtures、BOOT-01..08 及其 verifier、4K 运行（峰值估算请求 2,308/4,096 tokens、overflow 0）、WorkPacket token 拆分、plan-mode/todo 边界结果、入口门、聚焦回归，以及 §33 的 v1.6b/c/d 进入状态（至今一次钉住的真实使用切片；N 项与 Owner 确认的决策归 Owner）。

验证：`tests/doctor.spec.ts`（5 个测试）——黄金导入在激活前后及完整真实工作环后 doctor 均干净、未知版本大声失败、每个 issue 分支经 raw 行接缝演练（无验收项、无 verifier 标准、两类环、跨项目关系、工作项/标准/租约漂移、孤儿租约、不可读时间线）；包内 186 个测试；per-file 100% 覆盖率保持；两个 fixture 由脚本再生、字节稳定。

## 备选方案

**以复合证据宣布 BOOT-01 达成（导入诊断 + 环检查 + 对等测试）。** 否决——§29 命名了 doctor，且规划中的 `/project doctor` 命令需要可投影的接缝；报告里的复合论证不是可运行的 verifier。

**让 doctor 从 plan 文档重新推导期望。** 否决——账本是事实源；doctor 检查的是行与导入承诺的不变量、以及这些行产出的事件。重读文档会制造第二权威，且恰在越权写入最要紧时失效。

**用裸 SQL 生成 fixtures。** 否决——手工插入写出的填充库无法证明重放对等；用真实写入者驱动，让生成器收尾的 doctor 通过成为对 fixture 本身的真实验收。

**提交 fixture 的 SQL 转储而非 `.db` 文件。** 否决——§2 把工件路径钉为数据库，且二进制探针（open、`user_version`、拒绝降级）演练的是真实文件格式。

## 后果

`/project doctor` 在命令面落地时只需投影 `planDoctor` 的报告；fixtures 为未来每个 schema 版本提供了相邻、可再生的基线（升版、再生、与变更同批提交）；验收报告是 v1.6a DoD 达成的持久记录，把 §33 的门显式留给 Owner。
