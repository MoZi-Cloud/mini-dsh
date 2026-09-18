# Context-light 4K 真实使用切片

[English](README.md) | 中文

## 概述

钉住的 v1.6a 4K 验证器（docs/mini/v1.6a §3，AC-4K-001）：一个全新 agent 在 provider 与 adapter 上下文窗口双双钉在 4096 token、绝不扩容的前提下，完成一个真实的 Project Ledger 任务。agent 只通过 WorkPacket 工具结果看到任务——绝不读任务 plan——在复制的 fixture 工作区里以真实子进程执行 packet 的 verifier 命令，并经账本验收接缝报告结果。无 key 运行走确定性车道；`DSH_4K_LIVE=1` 携带 `DEEPSEEK_API_KEY` 走真实 provider 车道。

## 目录

- [运行](#run)
- [度量](#measurements)
- [开发备注](#dev-note)

<a id="run"></a>

## 运行

从仓库根目录：

```sh
./benchmarks/context-light/run-4k.sh
```

脚本先用 benchmark tsdown 配置编译 worker，再在纯 Node 下对已构建的工作区库运行（新树先 `pnpm install && pnpm run build`）。仅当账本到达 `DONE` 且记录了通过的评估、verifier 命令退出码为 0、重放投影一致、且每个模型请求都装得进钉住窗口时，脚本才以 0 退出。这是功能性 lane 门，不是计时基准；不属于 `test:bench`。

<a id="measurements"></a>

## 度量

lane 契约（§3）：adapter 声明与 provider 上下文窗口均为 4096，每个请求必须满足"估算请求 token 加 512 token 预留输出 ≤ 4096"——预检按每 token 四个字符的保守换算。确定性车道把预检当作裁决，经一个脚本化 adapter 驱动，其每一步动作都从会话中已有的 packet 提取，证明 packet 独自承载任务；固定流程是六个模型请求，第七个即失败。live 车道（`DSH_4K_LIVE=1`、`DEEPSEEK_API_KEY`，可选 `DSH_4K_BASE_URL`/`DSH_4K_MODEL`）把同一循环发给真实 provider，并按 §3 以上报 usage 为最终裁决；其 provider 消息映射是该车道自有的私有 adapter，只在有 key 的环境被演练。任务 plan 钉住一个 `IMPLEMENTATION` 工作项，verifier 命令是 fixture 工作区内的 `node --test test/math.test.mjs`；harness 直接执行 owner 的版本激活，因为 v1.6a 的激活尚无账本写入者。

<a id="dev-note"></a>

## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

[Agent Note](../../.agents/notes/implemented/testing/2026-09-18-context-light-4k-slice.zh.md) 拥有 lane 定义、双车道设计与无 key 政策、token 换算与已知排除项。

</details>
