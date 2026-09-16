# Agent 注记：项目账本计划解析器

Status: implemented

[English](2026-09-16-project-ledger-plan-parser.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）从 W01"严格 plan schema 与解析器"（SCHEMA-001）开始：plan 文档必须在任何持久化存在之前，对照已发布的宪法 `mini-dsh-plan-v1.1.schema.json` fail closed。解析器必须具体决定"严格"对 YAML 意味着什么——重复键、锚点/别名、不支持的版本——以及第一个工作包的语义检查走多远，而背后还没有数据库或编译器。

## 决策

一个包 `packages/experimental/project-ledger` 以三趟纯函数拥有 plan 文档接缝——`parsePlanDocument`、`validatePlanSchema`、`validatePlanSemantics`——每趟把全部独立问题收进一个 `PlanDocumentError`，带点分路径（解析趟已知处还有源位置），owner 一轮即可修完畸形计划。

- **宪法是镜像，不是重读。** `plan-schema.ts` 中的 zod schema 镜像 `docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json`；奇偶测试加载已发布文件，双向断言对象键、required 语义（以 `safeParse(undefined)` 探测）、每个受控枚举以及 verifier 联合的五个 kind。运行时绝不依赖 `docs/`；已发布文件保持唯一的人类可读归宿。
- **锚点与别名一律拒绝。** 它们是唯一能让两个路径共享同一可变对象的 YAML 特性；plan 文档是惰性数据，解析顺序绝不可被观测。merge key 随别名一起消亡。重复键通过 YAML 解析器自身的 `DUPLICATE_KEY` 错误拒绝，不手写遍历。
- **不支持的 `schemaVersion` 以一条专属问题失败**，在 schema 校验对不同时代的文档级联报错之前。
- **W01 包含引用与环检查**（v1.6a §26 把它们列在 plan parser tests 之下）：未知 `phaseId`/`parentId`/relation 端点、重复 id/序号/关系、层级环，以及排序关系 `BLOCKS`/`PRECEDES`/`SUPERSEDES` 的环。`RELATES_TO` 与 `DUPLICATES` 不携带排序，不参与环检测；自环是一条 `self-relation` 问题，不再另报长度为一的环。
- **acceptance 的 `kind` 必须等于 verifier 的 `kind`。** 两个字段在宪法中冗余；不一致会让验收日后被错误的接缝执行，所以编译期即拒绝。
- **文档可选成员声明为 `?: T | undefined`。** 仓库以 `exactOptionalPropertyTypes` 编译，而 zod 的输出模型是"可能 undefined"；交换接口携带诚实类型，而不是转换镜像。

验证：26 个包测试，覆盖 v1.6a §26 解析矩阵、字节/字符串/BOM 输入等价、folded scalar 确定性，以及仓库自己的 golden plan（`fork-mini-DSH-v1.6a.plan.yaml`，13 个 phase / 15 个工作项 / 14 条关系）贯通三趟的端到端运行。

## 已考虑的替代方案

**运行时对照 JSON Schema 文件校验（ajv）。** 暂不采纳——仓库没有任何 ajv 依赖，schema 小而封闭，镜像 zod 加奇偶测试少一个依赖，两侧漂移时仍会失败。若宪法增长或版本倍增，再评估 ajv。

**允许锚点/别名并对解析值克隆。** 拒绝——克隆隐藏共享而不消除共享，且文档等价性取决于一个策略选择；直接拒绝是确定性的，诊断也更好解释。

**把语义检查推迟到 W03 的 `compilePlan`。** 拒绝——§26 把它们划给解析器工作包，它们不需要数据库，W03 的编译器因此可以假设文档引用干净而不必重新校验。

## 后果

计划编译器（W03 `compilePlan`/`importPlanVersion`）从已校验文档出发，可以绑定 stable key、品牌化 id 并写入账本，无需重查引用或环。两个接缝有意保持开放：规范 IR 生成，以及任何命令执行——解析器绝不触碰 verifier 命令，这条对整个账本持续成立（import ≠ activate ≠ execute）。
