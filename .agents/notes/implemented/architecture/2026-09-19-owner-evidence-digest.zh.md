# Agent Note：Owner 证据摘要与 /project digest

Status: implemented

[English](2026-09-19-owner-evidence-digest.md) | 中文

## 问题

§33 门要求 owner 依据账本记录的证据确认账本价值，但这些证据散落在一次只答一个切片的读取接缝里：`listPlans` 答版本、`readWorkItemReview` 答单个条目的标准与最新评估、`readProjectReplay` 答对账。读完整个记录意味着多条逐条目命令或直接对账本写 SQL——在 v1.6b 决策正需要全貌的时刻，这恰是 owner 侧视图本应消除的负担。

## 决策

新的 `readProjectDigest` 账本读取接缝（`project-digest.ts`）以一次只读遍历聚合整个项目：每个 plan 及其全部版本的生命周期状态、钉定的 baseline head 与 supersede 戳；每个工作项（按 stable key 排序）的标准投影状态计数、最新判定计数与最新评估时间戳；以及按 `ProjectReplayReport` 原样内嵌（而非转述）的重放对账结论，owner 因此读到与 `/project replay` 完全相同的 parity 事实。判定计数来自每条标准的最新评估——review 接缝原先内联拥有的去重被抽成共享的 `latestEvaluationPerCriterion` 辅助函数，两个接缝保持同一套 newest-first、以 rowid 决胜的选取规则，duplication 门也停在其既有基线。`/project digest [<project-id>]` 经共享的项目解析渲染该摘要；digest 绝不变更、绝不执行 verifier 命令、也绝不裁决验收——计数是事实，不是闸门。

验证：`project-digest.spec.ts` 覆盖经真实写入者（import、评估、supersede 连指针重指）驱动的双版本项目、无写入者会产生的行（无版本的 plan 行、backlog 条目）及其如实携带的 drift、跨两条标准且含一次被覆盖 FAIL 的 latest-only 判定计数、以及内嵌的不可解码时间线；命令套件覆盖精确的摘要文本、无版本/drift/不可解码三种渲染与解析失败——两个包合计 241 测试、逐文件 100%。lane 在临时账本、持久账本（`PW-EVIDENCE-DIGEST-001` 由 `agent:mini-real-use-lane` 置 DONE，存储 verifier `pnpm exec vitest run mini-profile` 退出码 0、doctor 0、`replayDrift` 0、61 事件）与重跑幂等三处全绿；doc-sync 保持绿色（41/41），4K 切片保持最大 2,444/4,096 估算 token。

## 考虑过的替代方案

**在命令层用既有接缝拼装摘要。** 否决——聚合（标准计数、最新判定计数、plan 分组）是账本读取而非渲染；埋进 profile 命令会让其他消费方各自重组同样的事实，并偏离 review 接缝的最新选取语义。

**在 digest 里逐条目调用 `readWorkItemReview`。** 否决——逐条目 review 把条目、标准、评估查询重复跑 N 遍并各自去重；digest 对每族只读一次并共享去重辅助函数。

**把重放结论转述成一个布尔值。** 否决——`replayOk` 标志丢掉 owner 需要的计数与不可解码原因；内嵌报告让 parity 事实只有一个家。

**把 `readWorkItemReview` 扩成全项目模式。** 否决——review 按 ref 回答单条目，带抛错的重载歧义契约；digest 是另一种查询形态（项目范围、计数汇总），扩展 review 的契约为它服务只会扭曲契约。

## 后果

owner 一条命令即可读完整个 §33 记录，v1.6b 价值确认可以直接引用；digest 只读，Owner 域（§11 executor 身份、确认）原封不动留给 v1.6b。共享辅助函数把最新评估的决胜规则收进唯一一处：后续读取接缝复用它，而不是重新推导选取顺序。无写入者会产生的行（无版本 plan、backlog 条目）如实渲染并经内嵌对账浮出，digest 因此也为手工拼装的账本充当一遍初筛完整性读取。§33 计数到 22；版本 3 全部完成，后续真实使用条目需要版本 4 批次。
