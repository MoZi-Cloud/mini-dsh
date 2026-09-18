# Agent Note：project_work_update 报告的逐标准判定

Status: implemented

[English](2026-09-18-per-criterion-report-verdicts.md) | 中文

## 问题

`project_work_update` 的 report 动作把调用者的一个判定摊到被领取工作项的全部可观察验收标准上：当一项工作通过了某个存储 verifier 而未通过另一个时，agent 只能给两者报同一个 PASS 或 FAIL。计划条目 `PW-REPORT-VERDICTS-001`（`docs/mini/v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml`）记录了这个缺口；经 §33 真实使用 lane 落地它，还意味着同步更新该 lane 与 4K 切片的 fixture 克隆——报告语法的另外两个消费方。

## 决策

报告语法为每个可观察标准携带一个判定：`criteria: [{criterionId, result PASS|FAIL, 可选 exitCode}]` 取代顶层的 `result`/`exitCode` 二元组。工具在任何写入之前先校验整个列表——外来 id、不可观察（owner 门控）的 id、重复条目或漏掉某个可观察标准都会当场失败，认领保持持有、账本零写入——然后证明租约存活，再经 `evaluateAcceptanceCriterion` 以各自的判定与观察到的退出码逐标准评估。任一判定为 FAIL 即把工作项移入 `FAILED`；否则 `VERIFYING`，且没有必备标准待定时 `DONE`。`evaluatedCriteria` 逐条回显各标准自己的 result。消费方随语法同步迁移：真实使用 lane 读取 `packet.verifierSpecs`，逐标准执行其存储命令（仅查询的 verifier 当场失败——可观察，但该 lane 无法执行），逐项报告判定，其 JSON 行新增逐标准的 `verifierResults`；4K 切片的 fixture 克隆与脚本化报告调用采用同一形态。双可观察标准 fixture（`DUAL_PLAN_TEXT`，两个 TEST 标准加一个 owner 确认）覆盖混合判定、未被触碰的 owner 门控，以及全部拒绝路径——拒绝之后一次正常报告成功，证明拒绝路径零写入。

## 备选方案

**保留摊到全部标准的判定，把逐标准作为第二形态加入。** 否决——同一动作两种语法会掩盖判定覆盖了哪些标准，而 report 即终结认领（租约被释放），歧义无法由后续调用纠正。

**允许部分覆盖——只命名部分可观察标准。** 否决——未提及的标准会在同一认领下悄悄保持旧状态，且再无后续报告可更新它们。恰好一次的全覆盖才是响亮契约。

**在评估循环内边写边校验。** 否决——每条评估是独立事务，循环中途拒绝会让先前的评估已落账；完整列表必须在首次写入前校验完毕。

## 后果

agent 可以如实报告"部分 verifier 通过、部分失败"的套件而不扭曲通过标准的历史；失败标准保持 FAILING 投影，工作项记为 FAILED（不在 agent todo 视图内，该视图的状态集不含它）。这是一次 pre-stable 表面变更，所有消费方同改：mini-profile spec（30 测试，逐文件 100% 覆盖）、真实使用 lane、4K fixture。§33 记录由此 +1——`PW-REPORT-VERDICTS-001` 经 shipped 工具在持久 profile 账本上完成（经账本累计 17 项），语法变更后 4K 切片保持绿色（6 请求、最大 2,427/4,096 估算 token）。`PW-OBSERVED-TAIL-001`——observed 载荷中有界的 verifier 输出尾部——保持可领取，留给后续增量。
