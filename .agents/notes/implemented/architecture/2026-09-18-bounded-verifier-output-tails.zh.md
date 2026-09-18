# Agent Note：project-work 报告中的有界 verifier 输出尾部

Status: implemented

[English](2026-09-18-bounded-verifier-output-tails.md) | 中文

## 问题

逐标准报告语法为每条判定记录观察到的 exitCode，但账本重放仍然无法回答某条标准为何通过或失败：exitCode 本身丢掉了 verifier 的摘要与失败行，解释一条历史判定意味着对着可能已经前进的代码树重跑存储的命令。计划项 `PW-OBSERVED-TAIL-001` 点名了这个缺口。账本的 observed 载荷（`acceptance_evaluations.observed_json`）本就无上限地在结果旁存储 JSON，因此任何限界必须放在模型写入所经的工具层——否则调用方提供的字符串可以无限撑大持久账本。

## 决策

每条报告判定条目新增可选 `outputTail` 字符串，工具在任何写入之前对其限界：至多保存末尾 `REPORT_OUTPUT_TAIL_MAX_CHARS`（2048）个字符，保留结尾——verifier 的摘要与失败行所在之处。该上限是持久账本的固定存储不变量，与 work packet 的序列化上限同侪，不是随部署变化的选项，因此以导出常量而非 Config 字段存在。存储的 observed 载荷变为 `{exitCode?, outputTail?}`，任一字段存在即写入。real-use lane 把每个已执行 verifier 捕获的输出作为尾部传入，并断言有界尾部落入了 `acceptance_evaluations.observed_json`；4K fixture 克隆镜像同一语法与上限，固定窗口切片因此度量的是携带尾部的报告。

验证：mini-profile 达到 31 个测试、逐文件 100% 覆盖（新增测试原样存储短尾部、把 5,000 字符尾部截到末尾 2048）；real-use lane 在临时账本与持久 profile 账本上绿色（工作项由 `agent:mini-real-use-lane` 完成 DONE、doctor 0、重放 DONE、observed 载荷 `{exitCode: 0, outputTail: 1785 字符}`），随后重跑幂等；4K lane 保持绿色，峰值 2,444/4,096 估算 token（尾部约 +17）。

## 曾考虑的替代方案

**存储完整 verifier 输出。** 否决——无上限的模型提供文本进入持久行；账本的意义在于可重放且紧凑，一次报告还可能携带多条标准。

**只在 lane 限界，工具保持无界。** 否决——工具是所有调用方（含真实会话）共同经过的写入边界；lane 侧上限保护不了来自其他报告者的账本。

**把上限做成 Config 字段。** 否决——它是持久格式的存储不变量，与 `WORK_PACKET_MAX_SERIALIZED_BYTES` 同类；"禁止硬编码可调项"规则针对随部署变化的选项，不存在需要更长或更短持久尾部的部署。

**从头部截断，保留前若干字符。** 否决——verifier 把摘要与失败计数写在结尾；开头是输出里信息量最小的部分。

## 后果

账本重放无需重跑命令即可解释每条判定，直到上限为止；需要更多上下文的判定仍指向其标准，其 verifier 规格保存着可运行命令。未来的每个报告者——真实会话与后续 lane——自动继承同一上限。至此 post-v1.6a 增量 backlog（`PW-PRESENTERS-001`、`PW-REPORT-VERDICTS-001`、`PW-OBSERVED-TAIL-001`，全部经账本完成）收口；§33 记录为 18 项，价值确认仍待 owner 表态。
