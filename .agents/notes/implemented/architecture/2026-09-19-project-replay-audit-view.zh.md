# Agent Note：项目重放对账与 /project replay

Status: implemented

[English](2026-09-19-project-replay-audit-view.md) | 中文

## 问题

v1.6a 账本已能把项目事件折叠成投影，但唯一的 parity 检查藏在按版本的 doctor 扫描里，且只比一个方向——时间线未能重建的物化行会被发现，而重放指向却无行承载的实体（被删除的行、手写的事件）不会被察觉。§33 门槛要求 owner 确认账本价值，但 owner 没有任何只读手段审计整个项目的完整性；真实使用 lane 的通过判据也停在 doctor 加单个条目的重放状态，持久账本一旦出现双向断裂，任何门都不会报。

## 决策

新增 `readProjectReplay` 账本读接缝（`project-replay.ts`）独占该对账：经 fail-closed 重放编解码折叠项目时间线，把重建投影与物化表逐族比对——plan 版本按身份事实（plan id、版本号、源文档哈希），工作项、标准与租约按状态——且双向比对，物化侧多出的行与重放侧多出的实体同样算 drift。WorkPacket 只计入重放侧：记录在案的 recipe 即 packet 的全部持久记录，没有可比对的表。本构建无法解码时间线时，对账返回携带原因的 `undecodable` 结果，事件数与物化计数照报——用判别联合而非成对可空字段，消费端不可能持有被配对不变量杀死的分支。`/project replay [<project-id>]` 经共享的项目解析只读渲染该对账；doctor 自身的按版本扫描原样不动。真实使用 lane 的通过判据加入该对账：`assertReplayClean` 在完成与已完结两条路径上运行，报告行新增 `replayDrift`。

顺带修复两处邻接问题，因为它们挡门：`todo-views.spec.ts` 用两次真实时钟调用比对、负载下跨毫秒即翻车（改用 fake timers 冻结，断言值也随之精确）；`readWorkItemReview` 在解构检查旁保留了不可达的 `length === 0` 早退（合并为一个检查，同时覆盖空匹配与类型层的 undefined）。

验证：`project-replay.spec.ts` 覆盖写入者全家跑完后的干净对账、仅物化侧行（含 `plan/imported` 事件被删除的版本）、经事件编解码追加的仅重放侧实体、不一致的状态与版本事实、不可解码时间线；命令套件覆盖精确渲染、drift 行与解码失败文本——两包 per-file 100%（235 测试）。lane 在临时账本、持久账本（`PW-REPLAY-VIEW-001` 由 `agent:mini-real-use-lane` 完成、doctor 0、`replayDrift` 0、43 条事件）绿色通过，重跑幂等；4K 切片保持绿色，最大 2,444/4,096 估算 token。

## 考虑过的替代方案

**把 doctor 拓宽到项目级并复用。** 拒绝——doctor 是带自有 issue codes 与身份事实的按版本扫描；对账是带计数的项目级双向比对。拓宽等于改变一个已发布检查的含义，去凑它从未打算承载的表面。

**照抄 doctor 的单向比对。** 拒绝——doctor 跳过的方向恰是对账欠下的方向：已提交行被从时间线下删走，或事件指向无物化承载的实体，正是扫描看不见的完整性损失。

**以 `replayed: Counts | null` 配 `timelineError: string | null` 上报。** 拒绝——两个字段编码同一事实，会迫使每个消费端持有被配对不变量判死的收窄分支；判别联合把两种状态本身变成类型。

## 后果

持久账本从此背上一项长期零 drift 义务：后续每个增量的 lane 运行都会在真实账本上断言双向 parity，让投影与表分道的写入者在 lane 处失败，而不是在某位用户的 SQL 里。Owner 手术按设计保持可见——手工激活的版本不算 drift（折叠不投影版本状态），但手改源哈希或带外 `REVOKED` 租约会，这正是对账的职责。§33 计数达到 20；版本 2 全部完成，下一批真实使用条目需要起草版本 3。
