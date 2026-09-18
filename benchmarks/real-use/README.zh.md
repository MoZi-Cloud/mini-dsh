# v1.6a 后真实使用 lane

[English](README.md) | 中文

## 摘要

可重复的 §33 真实使用驱动器（docs/mini/real-use-log.md）：post-v1.6a 增量计划中的一个就绪工作项，经由 SHIPPED 的 mini-profile 表面——与 `dsh --profile mini` 会话挂载的同一个 `MiniProjectLedger` 与 `mini-project-work` 插件——完整走完，全程无模型参与。lane 本身即记录在案的执行者：经 `project_work_next` 观察、经 `project_work_claim` 领取（收到 WorkPacket，绝不读计划文档）、把 packet 内每个可观察标准的存储 verifier 命令作为真实子进程在仓库中执行、再经 `project_work_update` 逐标准报告判定，并附带观察到的 exitCode 与输出尾部——尾部与 exitCode 一并落入每条评估的 observed 载荷。唯有 DONE、doctor 无问题、事件重放一致、重放对账零 drift 才算通过；verifier 失败会为对应标准记入 FAIL 并使运行失败。

## 目录

- [运行](#run)
- [账本与幂等](#ledger-and-idempotency)
- [开发注记](#dev-note)

<a id="run"></a>

## 运行

在仓库根目录：

```sh
./benchmarks/real-use/run-real-use.sh
```

脚本先用 benchmark tsdown 配置编译 worker，再以纯 Node 基于已构建的 workspace 库运行（全新树先 `pnpm install && pnpm run build`）。这是功能性 lane 门，不是计时 benchmark；不属于 `test:bench`。lane 以两倍 verifier 超时的 `leaseTtlMs` 挂载工作插件，因此分钟级的存储 verifier（doc-sync 门套件一项就要约 6 分钟）绝不会活得比领取短。`DSH_REAL_USE_ITEM` 指定要领取的工作项（默认 `PW-DOCSYNC-GREEN-001`，即 `fork-mini-DSH-post-v1.6a.plan.yaml` 版本 3 的首个条目）。

<a id="ledger-and-idempotency"></a>

## 账本与幂等

默认驱动一个全新临时账本，以一行 JSON 报告退出 0。`DSH_REAL_USE_LEDGER` 指向持久文件——profile 默认为 `~/.dsh/project-ledger/ledger.sqlite`——连续运行因此累积在真实 `dsh --profile mini` 会话读取的同一账本里。运行是幂等的：plan 文档的当前版本只导入一次，已完成的工作项以 `alreadyComplete: true` 通过且不写入。plan 文档升版本时，经 §22 接缝 supersede 先前的 ACTIVE 版本（`supersedePlanVersion` 指名已导入的继任者）；supersede 与激活都由 lane 直接执行 owner 的动作（裸状态更新），因为二者都没有面向 lane 的 shipped writer——领取、评估与完成全部经由 shipped 工具。

<a id="dev-note"></a>

## 开发注记

<details>
<summary>维护者的工作上下文——点击展开</summary>

[Agent Note](../../.agents/notes/implemented/testing/2026-09-18-post-v16a-real-use-lane.zh.md) 拥有 lane 设计、shipped 表面保真度论证与证据记录策略。真实使用日志（docs/mini/real-use-log.zh.md）记录每次持久账本运行。

</details>
