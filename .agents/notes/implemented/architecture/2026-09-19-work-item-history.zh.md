# Agent Note：工作项评估历史与 /project history

Status: implemented

[English](2026-09-19-work-item-history.md) | 中文

## 问题

review 接缝通过各条标准的*最新*评估回答单个条目的状态——这是设计使然，评审解释的是当前判定。但 §33 记录同样需要判定背后的尝试：失败两次后通过的条目与一次通过的条目讲的是不同的故事，而没有任何只读表面暴露这条时间线。要读它就得直接对 `acceptance_evaluations` 写 SQL，而第二个逐条目读取又会从零重新推导 review 的条目解析与身份组装。

## 决策

新的 `readWorkItemHistory` 读取接缝（`work-item-history.ts`）按最新在前列出单个条目的全部已记录评估（沿用 `evaluated_at_ms DESC, rowid DESC` 顺序），每次尝试携带其账本评估 id、标准 id 与 kind、判定、评估者、时间及解析后的 observed 载荷。review 原先内联拥有的逐条目管道抽成两个接缝共同消费的共享辅助函数：`resolveWorkItemRow`（按 id 或 stable key 匹配，带抛错的重载歧义契约）与 `workItemIdentityOf`（品牌化的身份字段，现为两个结果共同扩展的 `WorkItemIdentity` 接口），解析、歧义与 id 品牌化各只有一个家，duplication 门维持在既有基线。`/project history <stable-key-or-id> [<project-id>]` 渲染时间线，每次尝试内联观察到的 exitCode 并附折叠的输出尾部摘录——与 review、export 同一证据格式。history 只读；它列出的任何判定都不是闸门。

验证：`work-item-history.spec.ts` 覆盖跨两条标准、含一次被覆盖 FAIL 的三次尝试时间线（精确 id、kind、observed 载荷）、空时间线、未知 ref 与歧义 ref 抛错；命令套件覆盖精确渲染（最新在前顺序、exitCode 在场与缺席、摘例行、空时间线、`version none` 的 backlog 条目）与解析失败——两包 246 测试、单次合并覆盖率运行逐文件 100%。lane 在临时账本、持久账本（`PW-ITEM-HISTORY-001` 由 `agent:mini-real-use-lane` 置 DONE、存储 verifier `pnpm exec vitest run mini-profile` 退出码 0、doctor 0、`replayDrift` 0、79 事件）与重跑幂等三处全绿；版本 4 全部完成。doc-sync 保持绿色；4K 切片保持最大 2,444/4,096 估算 token。

## 考虑过的替代方案

**给 `ReviewedCriterion` 加 `attempts` 数组。** 否决——此后每个 review 消费方都在每次读取时携带全部历史尝试，而 review 的契约是最新判定；历史是另一个问题，拥有自己的接缝。

**用 digest 的标准行渲染历史。** 否决——digest 刻意只保留每条标准的最新评估；尝试只存在于 `acceptance_evaluations`，为回答单个条目而加载整个项目是把读取读反了。

**让命令直接查询 `acceptance_evaluations`。** 否决——命令消费接缝，绝不写表 SQL；账本拥有的读取就该在账本读取表面之后，共享同一解析契约。

## 后果

owner 无需 SQL 即可逐次尝试地读懂条目为何先败后成——逐条目证据故事的最后一块缺口补齐（状态用 `/project item`、时间线用 `/project history`、全量记录用 `/project digest`/`export`）。两个接缝共享 `resolveWorkItemRow` 意味着未来的逐条目读取免费继承解析契约，ref 语义的任何变更只需落一处。§33 计数到 24；版本 4 全部完成，后续真实使用条目需要版本 5 批次。
