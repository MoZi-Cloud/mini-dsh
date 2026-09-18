# Agent Note：mini profile 的 `/project` 命令面

Status: implemented

[English](2026-09-18-mini-project-commands.md) | 中文

## Problem

v1.6a 收官时账本已挂载，但操作 `mini` 会话的人类够不着它：W08 bundle 只暴露 `ctx.projectLedger`，任何读取都要对着句柄调用接缝函数。BOOT 验收报告自身写明的下一步就是 `/project` 命令面，而 §33 的真实使用门槛也需要一个可行的工作观察方式，v1.6b 才能启动。

## Decision

`src/commands.ts`（packages/experimental/mini-profile）新增第二个 bundle 入口 `mini-project-commands`，通过 `ctx.effect` 在 `ctx.commands` 上注册一个全局 `/project` 命令（dsh-base 已挂载注册表）。语法封闭——`todo [--agent|--owner] [<project-id>]` 与 `doctor [<plan-version-id>]`——解析为判别联合，渲染为纯文本，以 `CommandResult` success/error 结算；未知输入回以用法说明。解析目标经由新的只读接缝 `listPlans`（packages/experimental/project-ledger 的 `plan-directory.ts`，列出 `plans` 行及其 `current_version_id` 指针）：未指明的项目或版本从单 plan 账本推导，空账本与多 plan 账本以可行动的文本大声失败。处理器注入 `commands` 与 `projectLedger`，只读、不向模型发送任何内容，非领域失败原样上抛而不是掩盖；激活仍是 owner 接缝，因此无 id 的 `doctor` 要求已指名 current 版本。

接线：patch 增加 `project-commands` 行，指向 `@deepseek-ai/dsh-experimental-mini-profile/commands`；包新增 `./commands` 导出与包本地 tsdown 配置（两个入口各自打包——放宽工作区级入口清单会把 api 控制器内部的 `commands.js` 也新打进包里）；`dsh-commands`/`dsh-brand` 成为运行时依赖。W08 的生命周期插件逐字节不变。

验证：`tests/commands.spec.ts`（8 个测试）驱动真实的 `ctx.commands.execute`——帮助文本、golden 导入的两种视图、显式与缺失的项目 id、doctor 在 named-current/显式/未知版本上的行为、经命令浮出的 drift、被封堵的 readiness、真实认领后的活跃租约、空视图、无 phase 工作项、多 plan 消歧、全部解析拒绝、`command/run`+`command/done` 生命周期对，以及句柄关闭后的原样上抛；`tests/plan-directory.spec.ts`（3 个测试）覆盖接缝；bundle/service 套件更新为两行组合；触及包共 202 个测试，保持逐文件 100% 覆盖。

## Alternatives considered

**在 W08 的 `MiniProjectLedger` 服务插件内注册命令。** 弃用——那会把一个经过验收测试的插件身份从“仅生命周期”改写成“生命周期加命令面”，并让其构造依赖注册表；第二个入口让 W08 逐字节不变，并沿用 `command-goal` 的插件模式。

**从命令模块直接查询 `plans` 表。** 弃用——bundle 已记录的身份声明不拥有账本语义；项目/版本解析是可复用的读取，应当以 `listPlans` 的形态留在账本里。

**处处要求显式 id（`/project todo <project-id>`、`/project doctor <pv:…>`）。** 弃用——mini 账本只有一个项目；在常见路径上强制 id 会让观察面不可用，而歧义场景仍然会带着所需 id 大声失败。

**通过导出激活写入者来覆盖无 id 的 doctor。** 弃用——v1.6a（§5）刻意把激活留为 owner 接缝；命令把“未指名 current 版本”的状态作为可行动的错误文本浮出，而不是悄悄放宽权限。

## Consequences

`dsh --profile mini` 会话现在可以观察账本——带阻塞原因与租约持有者的未完成 owner/agent 工作，以及 doctor 结论——这是 §33 真实使用证据的观察半边；变更类 Owner 流程仍是 v1.6b 范围，面向模型的 project-work 工具仍是同一句柄的后续消费者。`listPlans` 从此成为任何未来界面（Web 卡片、导出）回答“哪个项目/版本”的解析接缝。
