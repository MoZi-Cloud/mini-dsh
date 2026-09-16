# Agent Note：Project Ledger 计划编译器与导入

Status: implemented

[English](2026-09-16-project-ledger-plan-import.md) | 中文

## 问题

v1.6a Ledger Core 工作包（docs/mini/v1.6a）推进到 W03「Plan compiler and immutable import」（IMPORT-001）：已校验的 plan 文档必须成为 SQLite 账本中一个不可变的 plan version——golden plan 导入一次，重导入按 hash 幂等，编译错误不部分写入。编译器必须决定行身份如何推导、两个 hash 列各自哈希什么，以及新 plan 版本重复声明账本已记录的工作项时发生什么。

## 决策

`compilePlan`（纯函数）与 `importPlanVersion`（事务）位于 `packages/experimental/project-ledger`，面向任何携带账本布局的 `DatabaseSync` 运行；物理存储留在 `project-ledger-sqlite`，因此本包对它没有运行时依赖。

- **行身份是确定性推导**（`wi:<project>:<work id>`、`plv:<plan>:v<n>`、`ph:…`、`rel:…`、`ac:…`、`vs:…`），不是随机 id：同样的源字节在每个账本数据库中编译出相同主键，这正是内容寻址账本跨机器可比、利于重放的根基。身份在类型层品牌化；对不含 `:` 的 id 推导是单射，对抗性碰撞会在主键上 fail loud。
- **两个 hash 列哈希不同的东西。** `source_document_hash` 是精确解码源文本的 SHA-256，用作重导入幂等键；`compiled_ir_hash` 是全部产出行的按成员键排序 JSON 的 SHA-256，成员顺序不影响它，行顺序影响。
- **冲突规则表两个方向都 fail loud。** 同 plan 且同源 hash 直接短路不写；版本号复用但内容不同抛 `version-conflict`；新版本重复声明已属于其他版本或 backlog 的工作项抛 `work-item-conflict`。`work_items` 是项目级当前投影表（每个项目工作项一行，`plan_version_id` 指向承载版本），把工作项在版本间迁移是 supersede 流程（W11）的决策，不是导入的副作用。
- **事件在导入事务内追加**（先 `plan/imported`，再每项 `work/created`），遵循附件 §15「投影变更与事件原子提交」的规则。`PROJECT_EVENT_FORMAT_VERSION` 本地复制一份，并由测试钉住 SQLite 包的常量——与宪法 schema 相同的镜像模式——直到 W04 把事件词汇收进一个家。
- **导入绝不激活。** 每个导入版本以 `DRAFT` 落库，`plans.current_version_id` 不被触碰，`plan_imports` 只记录 `IMPORTED` 行：编译是纯函数、在任何写入前拒绝，因此 `REJECTED`/诊断簿记留给真正能在管道中途捕获拒绝的 driver 或 CLI 层。

验证：`packages/experimental/project-ledger/tests/import.spec.ts`——本仓库 golden plan（13 phase / 15 工作项 / 14 关系 / 16 验收条目）以精确行身份一次导入成功；按 hash 重导入不写任何行；事务中途写入失败与不可能的 verifier 变体各自回滚到零行账本；五种 verifier kind 全部绑定到各自的 tagged 行。

## 已考虑的替代方案

**随机（UUID）行 id。** 否——真源账本从确定性身份获得跨库可比性与稳定引用；否则按 hash 的重导入幂等会把新一轮行生成对全部外键隐藏起来。

**重复声明时 UPSERT 工作项。** 否——把投影悄悄改指到一个 `DRAFT` 版本，等于偷走 W11 存在的意义（状态迁移、事件、baseline 检查）。响亮拒绝把决策留给它的所有者。

**事件写入推迟到 W04。** 否——§15 把事件设为投影变更的前置条件；没有事件的导入会造成 W04 的重放永远无法重建的账本状态。

## 后果

W04（项目事件）继承了具体的 `plan/imported`/`work/created` 行来定义信封与重放一致性，并应吸收被复制的格式常量。W05/W06 读取本包现在写入的身份与 tagged verifier 行；supersede 流程（W11）扩展 `importWithinTransaction` 的冲突表，而不是替换它。
