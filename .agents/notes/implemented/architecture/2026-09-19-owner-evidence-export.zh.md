# Agent Note：Owner 证据导出与 /project export

Status: implemented

[English](2026-09-19-owner-evidence-export.md) | 中文

## 问题

digest 已让 owner 在终端读到 §33 记录摘要，但记录本身仍是手写散文：引用某条目的判定证据要逐条 `/project item`，也没有任何东西产出可分享的制品。digest 还只携带计数——按标准状态与最新判定结果的逐条目计数——任何想要计数背后逐标准事实的消费方，都得退回逐条目 review 接缝、按条目重跑其查询。

## 决策

digest 读取接缝现在携带逐标准行而非计数：`DigestItem.criteria` 是 `ReviewedCriterion` 列表（状态、kind、描述、required、最新评估含评估者、时间与 observed 载荷），经 review 接缝新增的共享映射器 `reviewedCriterionOf` 组装，两个读取保持同一条行组装路径与同一套最新评估决胜规则；计数记录及其零初始化器已删除，终端 digest 的 `P/T passing` 与 `verdicts N R` 计数改由行经 filter 派生（无控制流分支）。`/project export [<project-id>]` 仅凭 digest 把整个记录渲染成单个可归档 markdown 块——带版本、baseline 与 supersede 戳的 plan；逐条目小节含逐标准判定行，引用观察到的 exitCode 与输出尾部摘录（复用 review 渲染器的摘录辅助函数）；以及重放对账结论，其行组装（`replayVerdictLines`）与 digest 渲染器共享，导出处仅剥去标签、留下自己的小节标题。export 只读，没有新增任何变更路径。

验证：`project-digest.spec.ts` 对行形状重断言双版本、孤儿行、latest-only 与不可解码四例；命令套件断言精确的导出文本（required 与 optional 标准、exitCode 与尾部各自的在场/缺席、`version none` 的 backlog 条目）、drift 与复数 drift 的导出小节、以及解码失败小节——两包 242 测试、单次合并覆盖率运行逐文件 100%。lane 在临时账本、持久账本（版本 4 导入、版本 3 supersede、`PW-EXPORT-VIEW-001` 由 `agent:mini-real-use-lane` 置 DONE、存储 verifier `pnpm exec vitest run mini-profile` 退出码 0、doctor 0、`replayDrift` 0）与重跑幂等三处全绿；对持久账本运行的 `/project export` 渲染出 4 个 plan 版本与 9 个工作项，即完整 §33 记录。doc-sync 保持绿色（41/41）；4K 切片保持最大 2,444/4,096 估算 token。

## 考虑过的替代方案

**在命令层逐条目调用 review 拼装导出。** 否决——逐条目 `readWorkItemReview` 把条目、标准、评估查询重复跑 N 遍，还留下一个"同库 digest 使其不可达"的 `review === undefined` 分支；digest 携带行则每族只读一次，export 保持纯渲染。

**保留计数并在旁边加行。** 否决——同一条目上同一标准状态的两种表示是无法解释的不对称；计数可由行派生，故删除计数而非并行保留。

**扩展事件词汇，让发现型（backlog）工作获得写入者。** 超出范围——`work/created` 载荷要求一个重放会校验的 plan 版本，backlog 写入者需要词汇变更与 `PROJECT_EVENT_FORMAT_VERSION` 升版，而每个 fail-closed 读取者都会拒绝；那是独立的决策，不该搭在导出视图上。

**把导出写成文件。** 否决——命令面是只读报告；markdown 块落在哪里（§33 日志、PR、评审）由 owner 选择，粘贴比路径参数加文件写入语义更简单。

## 后果

§33 记录从此可机械复现：export 从同样的持久事件渲染出手写日志所概括的一切，owner 随时可以把散文与账本对照。digest 的公开形状在其引入一个增量后即发生变化（计数→行）——这是预稳定 API 的演进，同一变更内更新了仓内全部消费方，代价是在第二个消费方出现之前就落下了聚合体。后续需要标准行的读取接缝复用 `reviewedCriterionOf`，而不是重新推导组装。§33 计数到 23；`PW-ITEM-HISTORY-001`（逐条目评估历史）在版本 4 中保持可领取。
