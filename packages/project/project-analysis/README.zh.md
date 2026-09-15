---
description: "仓库索引器：git HEAD 解析、源码与文档采集、句法符号/调用提取、TypeChecker 解析调用图与快照编排，供用户和维护者选择、配置或调试索引。"
kind: "package-reference"
---

# @deepseek-ai/dsh-project-analysis

[English](README.md) | 中文

## 概述

`dsh-project-analysis` 把一次工作树捕获变成项目记忆快照。`indexRepository` 不启动 git 子进程而是直接读 `.git`（包括 linked worktree 与 packed refs）来解析基线，采集 TypeScript 源码与 Markdown 文档，运行句法 AST 提取，并默认运行 TypeChecker 提取——跨文件解析调用边（穿透 import 别名）并记录类型引用。所有写入在单个事务内提交；失败不会留下半个快照。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```ts
import { ProjectMemory } from '@deepseek-ai/dsh-project-memory'
import { indexRepository } from '@deepseek-ai/dsh-project-analysis'

const memory = await ProjectMemory.open('.mini-dsh/project-memory.sqlite')
const report = indexRepository(memory, {
  root: '.',
  slug: 'mini-dsh',
  snapshotKind: 'worktree',            // or 'head' (requires resolvable HEAD) / 'pinned' (requires commitSha)
  excludeDirNames: ['vendor'],         // merged over the built-in exclusions
  level: 'typechecker',               // or 'syntactic' for name-level edges only
})
```

`snapshotKind` 决定基线规则：`pinned` 要求显式 `commitSha`；`head` 要求可解析的 HEAD（分支、detached、packed 或 worktree），否则明确失败；`worktree` 记录 `dirty: true` 并尽力取 sha。文档默认入库（`includeDocuments: false` 关闭）——文件内容、标题大纲与一个 `project_objects` 文件节点。

<a id="understand-the-implementation"></a>
## 理解实现

- **两个提取级别**——句法提取（`syntactic.ts`）从 AST 恢复声明、导入与调用表达式，不依赖类型；语义提取（`semantic.ts`）用 checker 遍历程序自己的 SourceFile，并解包 import 别名使跨文件 callee 落到其声明文件。只有边同时链接到已存符号版本时才写 `resolved`。
- **重载消歧**——共享限定名的声明（重载、声明合并）在 stable key 上加次序号（`#2`、`#3`），每个声明保留自己的符号版本；checker 对重载集的解析链接其第一个声明。
- **确定性遍历**——文件与文档按路径序采集；同一棵树产出同一份报告。
- **事实来源**——签名、标志与位置事实来自 AST 提取（`extraction_level = 'syntactic'`）；TypeChecker 提取只解析边与类型引用。

<a id="model-experience"></a>
## Model Experience

无：索引在任何 agent 运行时之外离线执行，不触达模型请求。构建在已索引快照之上的上下文包才是面向模型的面，由 `dsh-project-memory` 拥有。

#### KV Cache effect

无——本包不发起模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延迟工作

以下是当前包约束，不是任务清单。

- **不展开 vendored/依赖图**——默认排除 `node_modules` 与 `vendor`；依赖调用记为 `external`，不展开。
- **无增量索引**——每次运行捕获完整快照；快照间 diff 待有消费者需要时再做。
- **全仓 checker 成本**——`typechecker` 级别对所有采集文件编译一个程序（本 harness 仓库本身需要数分钟与提高的堆上限）；调用方可以用 `level: 'syntactic'` 或更窄的根控制成本。

<a id="dev-note"></a>
## 开发注记

不发布运行时不变量伴随包：索引器是单进程库，其输出在测试中由存储自身的查询交叉验证；提取器的保真度由包的 fixture 强制执行，包括合成仓库上的 4K 上下文车道规范。
