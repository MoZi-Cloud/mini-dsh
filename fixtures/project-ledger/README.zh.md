# Project Ledger fixtures

[English](README.md) | 中文

## 概述

两个钉住的 v1.6a 账本数据库（docs/mini/v1.6a §2）：`v1.6a-empty.db` 是当前 schema 版本、无数据的数据库，用于 open/迁移/拒绝降级探针；`v1.6a-populated.db` 是以固定时间戳导入的黄金计划，并经真实写入者把三个工作项驱动到 `DONE`，每张账本表都留有行，doctor 通过（0 issues、28 事件）。schema 或事件格式变更后，从仓库根目录用 `pnpm exec tsx scripts/gen-project-ledger-fixtures.ts` 重新生成，并把重写后的文件与该变更一并提交。
