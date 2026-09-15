# fork mini-DSH 改造方案 v1.6a
## Plan-as-Data 最小可交付垂直切片 / Project Ledger 执行协议

- **版本：v1.6a**
- **日期：2026-09-16**
- **定位：对 v1.6 的收敛修订，不废弃 v1.6b/c/d 的后续方向**
**Golden repository：pinned `deepseek-ai/deepseek-harness` fork**

---

# 0. 修订结论

v1.6 的中心主张保留：

> **计划本身也是项目数据；Fresh Agent 不应反复阅读整份 Master Plan，而应从项目账本领取一个有界 WorkPacket。**

但 v1.6 一次性把 Project Ledger、Owner 域、Function Contract、多 Agent Workflow 全部纳入第一交付面，范围过大，而且与当前 DSH 仓库的应用启动、plan-mode/todo、SQLite 版本规则存在未定义集成点。

因此 v1.6a 只交付第一个可独立产生价值的闭环：

```text
strict plan.yaml
  -> validate
  -> compile
  -> import immutable plan version
  -> query ready work
  -> claim with lease
  -> build bounded WorkPacket
  -> execute through existing DSH profile/session/tool stack
  -> record acceptance/evaluation/project event
  -> complete or block work item
```

如果 v1.6a 在真实 mini-DSH 开发中证明没有价值，后续 v1.6b/c/d 不实施。

---

# 1. v1.6 分级路线

## v1.6a — Ledger Core（本协议）

目标：

```text
计划可导入
任务可查询
任务可领取
Owner/Agent 类工作可区分
验收可结构化
历史可回放
Fresh Agent 只取当前 WorkPacket
```

核心表约 13 张：

```text
plans
plan_versions
phases
work_items
work_item_relations
work_external_blockers
acceptance_criteria
verification_specs
acceptance_evaluations
project_events
plan_imports
plan_compile_diagnostics
work_leases
```

## v1.6b — Owner / Decision / Resource Domain

只有 v1.6a 真实运行后再做：

```text
decision_requests / decisions
approvals
resource_requirements / instances / verifications
actors / roles basic expansion
```

Android 11+ 真机、开发者模式、USB debugging 等示例放到 v1.6b fixture，不作为 v1.6a bootstrap plan 的永久 blocker。

## v1.6c — Function Contract（Research-gated）

只在以下研究门通过后实施：

1. pinned DSH 上证明稳定的 TypeScript signature extraction；
2. 若要把 required call edge 作为 hard gate，先证明 call-site extractor；
3. `effects` / `PROHIBIT` 默认只是 declared intent，不声称 TypeScript 可机械证明；
4. 只有显式 verifier 能证明的 effect 才能升级为 blocking acceptance。

硬门第一版只保证：

```text
函数存在性
名称/可见性/async/static
参数结构
返回类型结构
类型检查
明确可验证的 required call edges（extractor 存在后）
```

## v1.6d — Multi-Agent Project Collaboration

后续再做：

```text
actors / roles / assignments
handoff
scope reservation
collaboration conflicts
multi-agent scheduling projection
```

DSH workflow/subagent 继续是执行引擎；Project DB 只保存 project-level definition/projection，不复制第二套 workflow runtime authority。

---

# 2. P0 前置物：没有这些，不允许写生产代码

v1.6a 开工前必须在 fork 仓库中存在并可被评审：

```text
docs/mini/HISTORY/fork-mini-DSH改造方案-v1.4.md
docs/mini/HISTORY/fork-mini-DSH改造方案-v1.5.md
docs/mini/HISTORY/fork-mini-DSH-v1.5-SQLite数据库架构附件.md

docs/mini/v1.6a/fork-mini-DSH改造方案-v1.6a.md
docs/mini/v1.6a/fork-mini-DSH-v1.6a-SQLite核心账本附件.md
docs/mini/v1.6a/fork-mini-DSH-v1.6a.plan.yaml
docs/mini/v1.6a/mini-dsh-plan-v1.1.schema.json
```

同时必须补：

```text
fixtures/project-ledger/v1.6a-empty.db
fixtures/project-ledger/v1.6a-populated.db
benchmarks/context-light/README.md
benchmarks/context-light/run-4k.*
```

如果 v1.4/v1.5 生产代码尚不存在，v1.6a 不假设其 schema 已落地；Ledger Core 作为独立最小 capability 落地。

---

# 3. 4K lane 明确定义

v1.6a 的 4K 不是“方案文字里的标签”。

必须同时满足：

```text
provider/server context window = 4096
adapter declared context window = 4096
不允许自动扩大到 8192
```

WorkPacket 是输入的一部分，但不是全部输入。

执行前必须满足：

```text
estimated/final request tokens + reserved output <= 4096
```

验收以真实 provider request usage / llama.cpp 侧输入为最终标准；启发式 token meter 只做预检。

---

# 4. 应用入口：禁止独立 `mini-dsh` Node bin

官方 DSH 仓库硬规则：只有 `dsh` profile 是受支持 Node 应用启动入口。

因此 v1.6a 明确：

```text
禁止：packages/.../bin mini-dsh
禁止：新增独立 Node app launcher
```

产品入口：

```bash
dsh --profile mini
```

Project Ledger 通过 profile 挂载 capability / commands / tools。

人类交互面优先为 slash command，例如：

```text
/project import <plan-path>
/project doctor
/project status
/project next
/project todo
```

模型面使用短工具，例如：

```text
project_work_next
project_work_claim
project_work_update
```

如果 pinned DSH 的 command registry API 与上述名字不同，实施时只改表层命名，不新增独立 bin。

必须通过：

```bash
pnpm run verify-application-entrypoints
```

---

# 5. 与现有 plan-mode / todo 的关系

v1.6a 引入的是**项目级长期计划账本**，不是第三套会话 todo。

## 5.1 Project Ledger

权威范围：

```text
跨 session
跨 Fresh Round
跨 Agent
跨 plan version
```

持有：

```text
plan version
phase
work item
blocker
acceptance
project event
lease
```

## 5.2 `dsh-plan-mode`

继续负责：

```text
单 agent session 内的“先探索/设计、再给用户审阅”协作模式
```

它不是 Project Ledger 的当前状态事实源。

未来 bridge 可做：

```text
plan-mode draft
  -> explicit owner approval
  -> strict plan document
  -> Project Ledger draft plan version
```

v1.6a 不自动把 plan-mode 状态同步成项目计划。

## 5.3 `dsh-tool-todo`

继续负责：

```text
单 agent session 的短期、whole-list-replace 工作记事板
```

它没有稳定 item ID，不承担 project work identity。

可选 bridge：Agent claim 一个 work item 后，可把 WorkPacket 的局部执行步骤投影到 session todo；但：

```text
todo completed != project work item done
```

只有 Project Ledger acceptance 通过后才能完成 project work item。

## 5.4 Capability seam

v1.6a 新能力必须按 DSH seam 分成：

```text
Service Definition: ProjectLedger service contract
Provider: SQLite ProjectLedger provider
Consumers:
  profile commands
  model-facing project-work tool
  WorkPacket builder
  optional plan-mode bridge
  optional todo bridge
```

不得让 agent loop 直接依赖 Project Ledger。

---

# 6. package 放置策略

第一版优先放现有 `experimental/` group 做私有 capability proof，而不是立即制造新的 package group。

概念包：

```text
packages/experimental/project-ledger/
packages/experimental/project-ledger-sqlite/
packages/experimental/tool-project-work/
```

是否最终使用这些精确名字，由 pinned SHA 的 package governance/README 决定。

新增 package 必须遵守官方 adding-a-package 流程和 package-group authority。

---

# 7. Strict Plan Schema：v1.1

`mini-dsh-plan-v1.1.schema.json` 是 v1.6a 的机器宪法。

硬规则：

1. 所有定义对象默认 `additionalProperties: false`；
2. 所有状态/kind 使用受控 enum；
3. verifier 使用 discriminated union；
4. 未知字段拒绝；
5. duplicate YAML keys 拒绝；
6. schemaVersion 不支持时 fail closed；
7. YAML aliases/anchors 按 parser policy 明确测试，不允许悄悄产生共享可变对象；
8. plan import 不执行任何 verifier command。

---

# 8. Plan 导入不是激活

导入分两步：

```text
IMPORT
  parse + schema validate + semantic compile
  -> immutable DRAFT plan version

ACTIVATE
  OWNER explicit action
  -> ACTIVE plan version
```

任何 plan.yaml 中的 verifier command 都不能在 import 阶段执行。

Activation 必须由 Owner authority 完成。

Verifier 执行时必须走 DSH 已有 shell/sandbox/approval seam，不能绕过工具权限。

---

# 9. Ledger 数据模型语义

## 9.1 `plans`

只保存 identity：

```text
id
project_id
name
current_version_id
```

不保存第二套 `status`。

计划状态归 `plan_versions.status`。

## 9.2 `plan_versions`

状态：

```text
DRAFT
APPROVED
ACTIVE
SUPERSEDED
REJECTED
```

旧版本 immutable。

## 9.3 `work_items.plan_version_id`

允许 NULL，表示：

```text
unplanned backlog / discovered work
```

当其被正式纳入计划时，通过事件记录 adoption，而不是覆盖历史来源。

---

# 10. Work Item hierarchy 与 dependency 必须分开

层级：

```text
parent_work_item_id
```

表示“组成关系”。

`work_item_relations` 表示：

```text
BLOCKS
PRECEDES
RELATES_TO
DUPLICATES
SUPERSEDES
```

`BLOCKS` 必须有明确反向语义；cycle detection 是 semantic compile / doctor 的硬门。

不能把 parent-child 当 dependency。

---

# 11. Owner Todo / Agent Todo

v1.6a 暂不引入完整 actor/role domain，但 work item 必须有：

```text
executor_kind:
  AGENT
  OWNER
  SYSTEM
  EXTERNAL
```

因此两个 view/查询天然分离：

```text
/project todo --owner
/project todo --agent
```

v1.6b 再把 executor identity 扩展为 actor/role/assignment。

---

# 12. Work readiness

实现：

```ts
computeWorkReadiness(workItemId): WorkReadiness
```

检查：

```text
plan version active?
parent phase active?
blocking relations satisfied?
external blockers resolved?
required acceptance preconditions ready?
active lease exists?
work item superseded/cancelled?
```

返回：

```ts
interface WorkReadiness {
  ready: boolean
  reasons: ReadonlyArray<{
    kind: ReadinessBlockerKind
    refId?: string
    message: string
  }>
}
```

Agent 不得 claim `ready=false` 的任务。

---

# 13. Lease 语义必须闭环

`work_leases` 从 v1.6d 提前到 v1.6a。

配置：

```ts
interface LeaseConfig {
  ttlMs: number
  heartbeatIntervalMs: number
  reaperIntervalMs: number
}
```

约束：

```text
heartbeatIntervalMs < ttlMs / 2
```

claim：

```text
BEGIN IMMEDIATE
  recompute readiness
  reap expired lease for this item if policy allows
  create exactly one active primary lease
COMMIT
```

过期：

```text
lease -> EXPIRED
associated open attempt -> ABANDONED（若已有 attempt）
work item -> READY/BLOCKED 由 projection 重新计算
```

reaper 不直接宣布任务 failed。

必须有并发测试：两个连接同时 claim，只能一个成功。

---

# 14. Project Event Format 必须版本化

采用与 SessionEvent 相同的设计精神。

常量：

```ts
PROJECT_EVENT_FORMAT_VERSION = 1
```

事件 envelope：

```ts
interface ProjectEventEnvelope {
  readonly version: number
  readonly type: string
  readonly ignorable?: true
  readonly payload: JsonValue
}
```

规则：

```text
known required event -> decode
unknown event + ignorable=true -> preserve/skip projection
unknown required event -> fail on read
```

`project_events` 是 append-only。

current plan/work state 是 projection。

---

# 15. SQLite Runtime Contract

Project Ledger 是事实源，不是可随时重建的 cache。

因此：

```text
PRAGMA foreign_keys=ON
PRAGMA journal_mode=WAL       # default, configurable supported durable modes only
PRAGMA busy_timeout=<config>  # default 5000ms candidate
PRAGMA user_version=SCHEMA_VERSION
```

数据库文件：owner-only permissions；parent dir owner-only，沿用 DSH SQLite backend 风格。

## 15.1 版本策略

```text
user_version == current -> open
user_version == supported previous -> explicit adjacent migration
unknown/newer/incompatible -> reject
```

禁止：

```text
version mismatch -> delete/rebuild
```

因为 Project Ledger 不是派生索引。

## 15.2 event sequence

同项目事件序号必须在 `BEGIN IMMEDIATE` 内分配。

不允许无事务：

```sql
SELECT MAX(sequence_no)+1
```

再晚些 insert。

## 15.3 Writer model

第一版：

```text
per-project short write transactions
no long transaction across LLM/tool execution
BUSY -> bounded retry / explicit failure
```

---

# 16. WorkPacket 的 model-visible / logged 契约

这是 v1.6a 的硬不变量。

WorkPacket 构建后进入模型请求，因此必须可从 durable state 重建。

事件记录：

```text
project/work-packet-prepared
```

保存：

```text
packetFormatVersion
builderVersion
workItemId
planVersionId
repoSnapshotId
ordered immutable reference IDs
ordered content hashes
packetHash
```

要求：

1. 引用内容是 immutable/versioned；
2. builder 对相同 input deterministic；
3. request audit 记录最终 model-visible packet content/hash；
4. invariant test：重建 packet hash == request 中 packet hash。

这样 session log 不必复制整个 Master Plan，同时仍满足 model-visible 内容可审计。

---

# 17. `buildWorkPacket()` v1.6a

```ts
function buildWorkPacket(
  ledger: ProjectLedger,
  workItemId: WorkItemId,
  options: WorkPacketOptions,
): WorkPacket
```

只读取：

```text
active plan/version identity
work item objective
parent phase summary
blocking relation receipts
acceptance criteria
verification specs（不执行）
repo snapshot reference
明确关联的 project memory refs（若该 capability 已存在）
```

不读取：

```text
整个 Master Plan Markdown
整个 plan.yaml
其它 phase 全部 work items
历史 project event 全文
其它 agent transcript
```

4K lane 需要 bounded serialization。

---

# 18. verifier 信任边界

`verification_specs` 第一版使用判别联合：

```text
COMMAND
TEST
SQL_ASSERTION
GRAPH_ASSERTION
OWNER_CONFIRMATION
```

COMMAND/TEST：

- import 只存储；
- 激活不执行；
- 执行时必须经现有 DSH shell/tool execution + sandbox + approval；
- 不允许 Project Ledger 直接 `child_process.exec` 绕开 policy。

---

# 19. Function Contract：从 v1.6a 移出 P0

评审指出的风险成立。

v1.6c 研究前，不再声称：

```text
TypeScript 可以机械重建 effects
PROHIBIT call edge 可以靠静态分析完全证明
semantic role 可以自动得到稳定真值
```

v1.6c 分层：

## Hard-verifiable

```text
symbol existence
parameter structure
return type structure
visibility/async/static
typecheck
required direct call edge（仅在 extractor 证明可靠后）
```

## Declared intent

```text
effects
PROHIBIT call
architectural invariant
semantic role
```

Declared intent 只有挂了实际 verifier 后才可成为 blocking acceptance。

---

# 20. Workflow Authority

v1.6a 不新增 workflow_definition/nodes/runs 表。

v1.6d 原则先写死：

```text
DSH workflow/subagent engine = execution authority
Project Ledger = project-plan definition / projection / audit reference
```

如果 plan 将来定义 multi-agent workflow：

```text
ledger plan node
  -> compile to engine invocation
  -> engine runtime events
  -> project projection
```

不维护第二套独立 runtime 状态机。

---

# 21. Baseline drift

plan version 记录：

```text
baselineRepoSnapshotId
baselineHead
```

每次 claim 前：

```text
current repo snapshot vs plan baseline
```

若变化影响当前 work item 的 bound source set：

```text
BASELINE_DRIFT
```

策略：

```text
active attempt -> NEEDS_REBASE_REVIEW
new claim denied
existing historical evaluations preserved
owner/planner creates superseding plan version or explicit rebind event
```

禁止静默把 baseline 指针改到新 HEAD。

---

# 22. Plan supersede 与在途工作

当 `PlanVersion A -> SUPERSEDED`：

- 已完成 work/evaluation：历史保留；
- 未 claim work：不可再新 claim；
- active lease：允许配置两种显式 policy，但默认 `freeze-new-claims-and-review-active`；
- active attempt 不自动迁移到 B；
- 若 B 继承任务，产生 explicit carry-forward event/new work binding；
- old acceptance evaluations 永不改写。

---

# 23. v1.6a Plan Schema 最低能力

必须表达：

```text
schemaVersion
project
plan identity
plan version
baseline snapshot hint
phases
work items
hierarchy
typed relations
executorKind
acceptance criteria
discriminated verifiers
```

v1.6a 不要求表达：

```text
full actor roster
multi-agent assignments
function contracts
workflow graph
hardware resources
owner decisions
```

这些分别进入 b/c/d。

这不是“删能力”，而是把 schemaVersion 的第一版范围限定清楚。

---

# 24. Bootstrap Plan 不使用 Android 真机

v1.6a golden plan 必须在普通 CI/local 环境可达到 clean terminal state。

因此 bootstrap fixture只使用：

```text
repo checkout
Node/pnpm
SQLite
本地 temp directory
```

Android 11+ 真机案例移动到：

```text
fixtures/project-ledger/owner-resource-android/
```

并在 v1.6b 实施。

---

# 25. Actor seed 规则（v1.6a 最小）

v1.6a 不做完整 actor domain，但为了 owner/agent work 分类：

- `OWNER` 是 deployment/user authority，不自动伪造具体 human identity；
- model agent claim 使用 session/agent run identity 作为 executor receipt；
- v1.6d 再升级为 actors/roles/assignments 表。

BOOT-06 并发 claim 使用两个测试 worker identity，不依赖 actor 表。

---

# 26. Plan parser tests

至少：

```text
unknown field -> reject
duplicate key -> reject
unknown enum -> reject
unsupported schemaVersion -> reject
missing verifier required field -> reject
wrong verifier field combination -> reject
phase/work reference missing -> reject
relation cycle -> reject
self-block -> reject
invalid hierarchy cycle -> reject
YAML folded scalar -> deterministic
alias/anchor policy -> deterministic/rejected per policy
```

---

# 27. v1.6a 核心函数（8+）

## F01 `parsePlanDocument(bytes)`

只做 YAML parse，带 source location；禁止 silent duplicate-key overwrite。

## F02 `validatePlanSchema(value)`

使用 strict JSON Schema。

## F03 `compilePlan(document)`

解析 refs、层级、relation、acceptance；生成 canonical IR；不写 DB。

## F04 `importPlanVersion(tx, ir)`

单事务；写 plan/version/phase/work/relations/acceptance/import diagnostics/events。

## F05 `planDoctor(planVersionId)`

验证引用、无环、acceptance、schema/event/database version、baseline 信息。

## F06 `computeProjectStatus(projectId)`

结构化输出，不生成虚假百分比。

## F07 `computeWorkReadiness(workItemId)`

见 §12。

## F08 `buildWorkPacket(workItemId, options)`

见 §17。

## F09 `claimWorkItem(workItemId, workerIdentity)`

`BEGIN IMMEDIATE` + readiness + lease。

## F10 `heartbeatWorkLease(leaseId)`

只延长自己的 active lease。

## F11 `reapExpiredLeases()`

bounded batch；project event 记录。

## F12 `recordAcceptanceEvaluation(...)`

append evaluation，不覆盖历史。

## F13 `appendProjectEvent(...)`

负责 event version/envelope/sequence。

---

# 28. v1.6a 工作包

统一只使用一套编号，不再同时存在 Pxx / WPxx 两套。

## W00 — Freeze sources and prerequisites

- pin DSH SHA；
- 把历史文档/fixtures 入仓；
- 定义 4K benchmark；
- focused baseline tests。

## W01 — Strict schema + parser

Red -> Green。

## W02 — Ledger SQLite identity/runtime

- user_version；
- WAL/busy timeout；
- permissions；
- mismatch reject；
- adjacent migration fixture。

## W03 — Plan compiler/import

BOOT-01 基础。

## W04 — Project event format/projection

- versioned envelope；
- ignorable semantics；
- replay equality。

## W05 — Work relations/readiness

- hierarchy/dependency 分离；
- cycle detection。

## W06 — Acceptance/verifier storage

不执行 verifier。

## W07 — Work lease

并发 claim/reaper/heartbeat。

## W08 — DSH profile/command/tool integration

- only `dsh --profile mini`；
- verify-application-entrypoints green；
- plan-mode/todo boundary tests。

## W09 — WorkPacket + model-visible logging

BOOT-02。

## W10 — Owner/Agent todo views

BOOT-03。

## W11 — Immutable version/supersede

BOOT-08 + baseline drift。

## W12 — 4K real-use slice

真实用 Project Ledger 推进 mini-DSH 的下一项开发工作。

---

# 29. BOOT 验收（v1.6a）

## BOOT-01

golden plan import + doctor = 0 errors。

## BOOT-02

Fresh Agent 不读 Master Plan，只通过 DB/WorkPacket 获取一个 ready task，并完成。

## BOOT-03

Owner/Agent work query 分离。

## BOOT-04

Project event replay projection == materialized current projection。

## BOOT-05

未知 schema 字段/enum/verifier shape fail closed。

## BOOT-06

两个并发 worker claim 同一 task，仅一个获得 lease；过期后可安全回收。

## BOOT-07

WorkPacket hash 可由 logged recipe + immutable refs 重建，并与最终 request 中内容 hash 一致。

## BOOT-08

Plan A supersede by Plan B：旧版本历史不变，旧未开始任务不可再 claim，evaluation 保留。

---

# 30. 性能门

synthetic：

```text
100k work items
1m project events
```

P0 查询：

```text
next ready work
work item detail
owner todo
agent todo
project status
event replay range
```

必须有 `EXPLAIN QUERY PLAN` fixture，禁止关键 join 无索引全扫。

---

# 31. 测试命令纪律

实施 Agent 必须先按当前 pinned `AGENTS.md` 读取本地验证要求，优先 focused tests / typecheck / lint / repository prescribed local gates；全量 CI 命令只在仓库规则允许/要求时运行。

文档不能硬编码一个未来可能变化的全量命令作为唯一真理。

但 `verify-application-entrypoints` 是本方案应用入口的专项硬门。

---

# 32. Definition of Done

v1.6a 完成必须：

- [ ] v1.4/v1.5 history/fixture 前置已入仓或明确标记为未实施，不再虚构已经存在；
- [ ] 无独立 `mini-dsh` Node bin；
- [ ] `dsh --profile mini` 是唯一产品启动形态；
- [ ] strict plan schema unknown fields fail；
- [ ] verifier discriminated union；
- [ ] import 与 activation 分离；
- [ ] Project Ledger 与 plan-mode/todo 边界有测试；
- [ ] SQLite `user_version` 单调且 mismatch fail closed；
- [ ] adjacent migration fixture；
- [ ] project event format version + ignorable semantics；
- [ ] project event replay == current projection；
- [ ] hierarchy/dependency 分离；
- [ ] cycle detection；
- [ ] acceptance/evaluation 历史 append；
- [ ] verifier execution 不绕过 shell sandbox/approval；
- [ ] lease claim/heartbeat/reaper 完整；
- [ ] WorkPacket model-visible/logged invariant；
- [ ] 4K hard lane benchmark 存在并通过；
- [ ] BOOT-01..08 全绿；
- [ ] successful run context overflow = 0；
- [ ] 不修改 core agent loop 实现项目账本；
- [ ] function contract effects/call-prohibit 没有被伪装成机械可判定事实；
- [ ] workflow runtime 未复制第二套权威状态机。

---

# 33. v1.6b/c/d 进入门

只有满足：

```text
v1.6a 被真实 mini-DSH 开发连续使用 >= N 个 work items
且 BOOT/4K 无回归
且用户确认 Ledger 有实际价值
```

才进入下一阶段。

`N` 不在协议硬编码，由项目配置/Owner 决策确定。

进入 b/c/d 的依据必须来自 Ledger 中的真实使用记录，不凭“设计看起来完整”。

---

# 34. 最终 Agent 执行指令

```text
你正在实现 mini-DSH v1.6a，而不是原 v1.6 全量蓝图。

目标：交付最小 Project Ledger 闭环，让计划成为可导入、可查询、可领取、可验收、可回放的数据；Fresh Agent 不再重读 Master Plan。

必须：
1. 先清前置与 P0，禁止假设 v1.4/v1.5 代码已存在。
2. 不新增独立 mini-dsh Node bin，只通过 dsh profile。
3. 不替代 dsh-plan-mode 和 dsh-tool-todo；明确项目级与会话级边界。
4. schema fail closed；unknown field/enum 拒绝。
5. Project DB 是事实源；版本不符拒绝，只走显式相邻迁移。
6. Project event 有独立 format version/ignorable 语义。
7. verifier command 只存储；执行必须走既有 sandbox/approval shell seam。
8. WorkPacket 进入模型必须可由 logged recipe 重建。
9. lease 必须有 heartbeat/reaper/并发测试。
10. 不实施 v1.6c Function Contract effects/PROHIBIT hard gate，除非研究门先通过。
11. 不复制 workflow runtime。
12. 严格按 W00→W12，先 Red 后 Green。
13. 每个 work item 完成后写 project event + acceptance evaluation。
14. 4K lane 不得自动扩容。

最终报告：
- pinned SHA
- schema/event format versions
- tables/indexes
- migration fixtures
- BOOT-01..08
- 4K benchmark
- WorkPacket token/context breakdown
- plan-mode/todo bridge result
- application-entrypoint gate
- focused upstream regressions
- 是否有足够真实证据进入 v1.6b/c/d
```
