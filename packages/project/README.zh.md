---
description: "project 组的包映射：SQLite 项目记忆库与填充它的仓库索引器，供用户和维护者浏览该组。"
kind: "package-group"
---

# project/：项目记忆与仓库分析

[English](README.md) | 中文

## 概述

`project/` 组拥有仓库智能基础设施：SQLite 项目记忆库（`project-memory`）与填充它的索引器（`project-analysis`）。一次索引运行以 append-only 快照记录一个工作树——TypeScript 符号与调用图、Markdown 文档及其标题大纲、观测到的 `project_objects` 树——以及带源码证据的持久记忆、分析单元与运行事件。构建在快照之上的有界上下文包是检索单元；4K 上下文车道据此定义并强制执行。后续项目账本能力（计划导入、工作项、租约）都构建在这个存储之上。

## 目录

- [包](#packages)
- [4K 上下文车道](#the-4k-context-lane)
- [相关文档](#related-documentation)
- [开发注记](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`project-memory`](project-memory/README.zh.md) | SQLite 事实源存储：schema、内容库、快照、符号、调用图、项目对象、记忆、分析单元、上下文包 |
| [`project-analysis`](project-analysis/README.zh.md) | 工作树索引器：git HEAD 解析、文件/文档采集、句法与 TypeChecker 提取、快照编排 |

<a id="the-4k-context-lane"></a>
## 4K 上下文车道

车道是经评审的契约：任何喂给 worker 上下文的单次有界检索都 fits `CONTEXT_LANE_TOKEN_BUDGET`（4,096）估算 token；放不下的部分以省略章节显式报告，而不是悄悄塞入。估算确定性（UTF-8 字节 ÷ 4 向上取整——对源码文本偏保守），预算是源常量，环境变量无法放宽；门是包内 `context-lane-4k` 规范在合成仓库上的断言——仓库基准树不承载它，因为其规则禁止把语义断言混入 `test:bench`。把车道扩到 8K 是评审决策，不是配置变更。

<a id="related-documentation"></a>
## 相关文档

- `docs/mini/评审建议.md`——为本基础设施与构建其上的账本分层定范围的设计评审

<a id="dev-note"></a>
## 开发注记

本组不发布运行时不变量：存储与索引器是单进程库角色，其观测不会在独立视点间分歧；schema 版本控制、快照事务边界与车道规范由各包自身测试强制执行。分层引入的理由见[项目记忆基础设施 Agent Note](../../.agents/notes/implemented/architecture/2026-09-16-project-memory-foundation.zh.md)。
