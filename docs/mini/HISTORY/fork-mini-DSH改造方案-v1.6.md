# fork mini-DSH 改造方案 v1.6
## Plan-as-Data / Dynamic Project Execution Ledger / Multi-Agent Collaboration 执行协议

- **版本：v1.6**
- **日期：2026-09-16**
- **目标项目：official `deepseek-ai/deepseek-harness` fork → `mini-DSH`**
- **前序：v1.5 Repository Intelligence / Progressive Reading / SQLite Memory**
**配套附件：**

- `fork-mini-DSH-v1.6-SQLite数据库架构附件.md`
- `fork-mini-DSH-v1.6.plan.yaml`
- `mini-dsh-plan-v1.schema.json`

---

# 0. v1.6 的自举原则

v1.6 的第一条验收不是“Markdown 写得完整”，而是：

> **v1.6 自己必须能够被机器结构化导入 mini-DSH 的 SQLite 项目数据库。**

如果一个计划只能靠 Agent 每次重新阅读几千行自然语言才能执行，那么它还不是 mini-DSH 的计划系统。

v1.6 因此同时交付两种表达：

```text
v1.6.md
= 人类可读的设计解释 / rationale / 实施协议

v1.6.plan.yaml
= 机器可校验、可导入、可版本化的项目计划事实
```

数据库成为执行期 source of truth：

```text
plan.yaml --import--> SQLite
                       │
                       ├─ objectives
                       ├─ target state
                       ├─ phases / milestones
                       ├─ work items
                       ├─ dependencies
                       ├─ owner requests
                       ├─ resources
                       ├─ decisions
                       ├─ design changes
                       ├─ function contracts
                       ├─ acceptance criteria
                       └─ multi-agent assignments/workflows
```

普通 Worker 不需要重新读取完整 v1.6 Markdown。

---

# 1. 对 v1.5 的批判性结论

v1.5 已经能够回答：

```text
仓库当前是什么？
哪些 package/module/symbol 存在？
哪些函数调用哪些函数？
哪些文档/规则说明了什么？
哪些 memory 有源码 evidence？
```

但它仍无法完整回答：

```text
mini-DSH 计划变成什么？
当前执行的是哪一版计划？
Phase 4 做到哪里？
哪个任务被哪个 Owner decision 阻塞？
Agent1/2/3 谁负责什么？
某函数当前 contract 是什么？
计划中的目标 contract 是什么？
实现结果与目标 contract 是否一致？
某 acceptance criterion 第几次才通过？
为什么计划 v6 替代了 v5？
```

因此 v1.5 的 `analysis_units` 只能表达“需要研究什么”，不能代替正式项目工作项；它也没有 `target state / design intent / function target contract / owner resource / multi-agent assignment`。

---

# 2. 参考成熟项目管理系统后的模型选择

v1.6 借鉴以下成熟模式，但不复制其业务模型。

## 2.1 GitLab Work Items

借鉴：

- 一个统一 Work Item 底座承载不同工作类型；
- hierarchy 与 linked/blocking relation 分离；
- strategy/objective 与日常 task 可处于同一统一模型；
- blocks / blocked_by 是显式关系，而不是 description 文本。

mini-DSH 决策：

> Agent Todo、Owner Todo、Research、Implementation、Review、Benchmark 共用 `work_items`，通过 `work_type`、`executor_kind`、assignment/view 区分。

---

## 2.2 Redmine

借鉴：

- Issue 保存当前 projection；
- Journal 保存历史变化；
- typed relation 保存 blocks / precedes / duplicates 等方向语义；
- parent-child 与普通 relation 不混淆。

mini-DSH 决策：

> `project_events` 保存 append-only 项目历史，`work_items/plans/...` 是 current projection。

---

## 2.3 OpenProject

借鉴：

- work package 可以表示 task/feature/bug/phase/milestone；
- hierarchy 和 relation 同时存在；
- project phase 是一等对象；
- assignee/responsibility/自定义 schema 可以分层；
- baseline comparison 对动态项目非常重要。

mini-DSH 决策：

> `accountable_actor`、`primary executor`、`reviewer` 分离；计划版本、repo snapshot、target contract 都可做 baseline comparison。

---

# 3. v1.6 六层 Project Model

```text
┌─────────────────────────────────────────────┐
│ 1 SOURCE REALITY                            │
│ repo snapshots/files/symbols/imports/calls  │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│ 2 PROJECT KNOWLEDGE                         │
│ docs/rules/memory/evidence/lessons          │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│ 3 DESIRED STATE / DESIGN INTENT             │
│ objectives/targets/change specs/contracts   │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│ 4 EXECUTION STATE                           │
│ plans/phases/milestones/work/gates          │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│ 5 COLLABORATION                             │
│ actors/roles/owner/agents/resources/handoff │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│ 6 OBSERVABILITY / HISTORY                   │
│ project events/runs/LLM/tools/tests/audit   │
└─────────────────────────────────────────────┘
```

六层必须互相链接，但不能混成一张万能 JSON 表。

---

# 4. Project != Repository

v1.5 主要以 repository 为根。

v1.6 必须新增：

```text
project
```

因为未来一个开发项目可能涉及：

```text
mini-DSH repo
Android fixture repo
benchmark corpus repo
external test device
CI service
```

一个 Project 可关联多个 Repository；一个 Repository 也可在不同 Project 中承担不同目的。

mini-DSH 当前：

```text
Project: mini-DSH
Primary repository: fork deepseek-harness
Upstream repository: deepseek-ai/deepseek-harness
```

---

# 5. Plan 必须 immutable-versioned

禁止：

```text
UPDATE plan SET ...
然后旧计划消失
```

正确：

```text
Plan mini-DSH
  v1 superseded
  v2 superseded
  ...
  v1.6 active
```

数据库对象：

```text
plans
plan_versions
plan_version_changes
```

一个 `plan_version` 一旦 active，不原地修改 normative 内容。

修订：

```text
v1.6.1 / next plan version
```

并显式记录 delta/rationale。

---

# 6. Plan-as-Data Schema 的最低能力

`v1.6.plan.yaml` 必须能够表达：

1. project identity；
2. baseline repository selector/pinned snapshot；
3. objectives；
4. target-state assertions；
5. phases；
6. milestones；
7. work items；
8. work hierarchy；
9. blocking dependencies；
10. Owner work；
11. Agent work；
12. environment/resource requirements；
13. owner decisions；
14. actor roles；
15. multi-agent assignments；
16. design changes；
17. baseline code object bindings；
18. target function contracts；
19. target call relations；
20. acceptance criteria；
21. verification specs；
22. phase gates；
23. workflow fan-out/join；
24. activation prerequisites。

`plan doctor` 缺任何硬必需项都必须 fail closed。

---

# 7. Work Item 是统一工作底座

不要建：

```text
agent_todos
owner_todos
research_tasks
implementation_tasks
```

统一：

```text
work_items
```

第一版 `work_type`：

```text
RESEARCH
DESIGN
IMPLEMENTATION
TEST
BENCHMARK
DOCUMENTATION
MIGRATION
REVIEW
OWNER_ACTION
ENVIRONMENT_SETUP
DECISION_FOLLOWUP
RELEASE
BUG
```

第一版 `executor_kind`：

```text
AGENT
OWNER
HUMAN
SYSTEM
EXTERNAL
```

Owner 和 Agent 的 Todo 用 view/query 分开，不用孤立数据模型。

---

# 8. Hierarchy 与 Dependency 必须分开

例如：

```text
P06 Project Execution Ledger
 └─ M06.1 Planning Schema
     ├─ W061 schema
     ├─ W062 importer
     └─ W063 tests
```

这是 hierarchy。

而：

```text
W063 BLOCKED_BY W061
W081 BLOCKED_BY RESOURCE AndroidDevice
```

是 dependency/blocker。

不能把二者都叫 parent_id。

---

# 9. Actor / Role / Assignment 三层

## Actor

```text
Owner
Agent-Coordinator
Agent-1
Agent-2
Agent-3
CI
External Reviewer
```

## Role

```text
OWNER
PLANNER
IMPLEMENTER
REVIEWER
TESTER
RESEARCHER
COORDINATOR
```

## Assignment

一个 Work Item 可以：

```text
Agent1 primary implementer
Agent2 reviewer
Agent3 tester
Owner accountable
```

Actor 不是 Role；Assignment 不是 Actor 本身属性。

---

# 10. Owner Todo 与 Agent Todo

Owner 查询：

```bash
mini-dsh project todo --owner
```

Agent 查询：

```bash
mini-dsh project todo --agent agent-2
```

底层都来自 `work_items + assignments + blockers`。

---

# 11. Resource Requirement 是一等实体

Owner Action 不应承担环境真实性。

例如：

```text
Need Android physical device
API >= 30
Developer mode enabled
USB debugging enabled
ADB host authorized
```

分为：

```text
resource_requirement
  ↓
owner work item: provide it
  ↓
resource_instance
  ↓
resource_verification
```

Owner 说“已经接上”不等于 verified。

Agent/System 必须通过：

```bash
adb devices
adb shell getprop ro.build.version.sdk
```

等检查后才满足 gate。

---

# 12. Decision 与 Approval 分离

## Decision

```text
项目应该选 A 还是 B？
```

例如：

```text
memory.sqlite3 默认 repo-local 还是 ~/.cache？
```

## Approval

```text
是否允许执行一个已决定的敏感操作？
```

例如：

```text
是否允许 Agent 写 external device？
```

二者不能共用同一状态机。

---

# 13. Project Event Log

v1.6 把项目开发历史也设计成 append-only event ledger。

事件例：

```text
project/created
plan/version-created
plan/activated
phase/started
work/created
work/assigned
work/claimed
work/blocked
work/completed
decision/requested
decision/resolved
resource/requested
resource/provided
resource/verified
agent/handoff
workflow/node-started
workflow/node-completed
target/implemented
target/verified
```

Current tables 是 projection。

这与 DSH SessionEvent 的工程思想保持一致。

---

# 14. v1.6 最关键新增：Design Intent Domain

如果计划说：

> “修改函数 X”

数据库不能只存 `work_item.description`。

必须有：

```text
ChangeSpec
  ├─ baseline object
  ├─ baseline function contract
  ├─ target design object
  ├─ target function contract
  ├─ planned call edges
  ├─ allowed/prohibited effects
  └─ acceptance criteria
```

这样计划才真的可执行和可审计。

---

# 15. Function Contract 四种状态

```text
OBSERVED_BASELINE
TARGET
IMPLEMENTED
VERIFIED
```

例如：

```text
ReactLoopAgent.preStep
```

Baseline 来自 pinned source + TypeChecker。

Target 来自 plan。

Implemented 来自 Agent 改完后的新 repo snapshot + TypeChecker。

Verified 来自 acceptance/conformance gate。

---

# 16. Function Contract 必须结构化什么

不能只存 signature string。

至少：

```text
visibility
async/static/generator
parameters ordered list
return type
throws/errors contract
side effects
invariants
preconditions
postconditions
source binding
```

参数必须独立行：

```text
ordinal
name
type
optional
rest
default
semantic role
```

---

# 17. 当前调用关系 vs 目标调用关系

当前真实调用：

```text
call_sites
```

由 TypeChecker/static extractor 提取。

计划中的未来调用：

```text
planned_call_edges
```

例如：

```text
RETAIN SystemPrompt.assemble
ADD    ContextAudit.capture
REMOVE legacyFoo
PROHIBIT direct SQLite write
```

目标边永远不能写进 `call_sites`，直到代码真的实现。

---

# 18. ChangeSpec 示例（表达能力验收，不代表 v1.6 必改此函数）

假设计划要调整现有：

```text
ReactLoopAgent.preStep
```

Plan Importer 必须首先绑定 pinned baseline symbol。

## Baseline contract

机械捕获：

```text
parameters:
  target: InboxTarget
  position: {turn:number, step:number}

return:
  Promise<PreparedStep>

current calls:
  inbox.claim
  systemPrompt.assemble
  renderContextSections
  joinContextSections
  runtimeContext.project
  dispatch.waterfall
```

## Target contract（假设）

```text
signature: UNCHANGED
return: UNCHANGED

RETAIN:
  inbox.claim
  systemPrompt.assemble
  dispatch.waterfall

ADD:
  ContextAudit.capture

PROHIBIT:
  direct database write from core agent-loop
```

## Acceptance

```text
AC1 TypeScript signature unchanged
AC2 required existing calls retained
AC3 audit event once per step
AC4 no new model-visible schema
AC5 4K benchmark no regression
AC6 existing agent-loop tests green
```

全部都必须能映射数据库，而不是留在 prose。

---

# 19. Design Object 可以表示“尚不存在的未来对象”

当前 `project_objects` 只能可靠描述 observed source reality。

新增：

```text
design_objects
```

例如目标中计划新增：

```text
ProjectExecutionStore
PlanCompiler
computeWorkReadiness()
claimWorkItem()
compareFunctionContracts()
```

这些在源码不存在时也可成为 plan target。

实现完成后再通过：

```text
implementation_bindings
```

绑定到真正 `project_object/symbol_version`。

---

# 20. Target State Assertion

不是所有目标都等于一个函数变化。

例如：

```text
TARGET-CTX-001
4K successful runs context overflow = 0

TARGET-PLAN-001
Active project plan is queryable without loading Markdown

TARGET-AUDIT-001
Every promoted semantic memory can trace to source evidence
```

使用：

```text
target_state_assertions
```

并绑定 verification。

---

# 21. Acceptance Criteria / Verification Spec / Evaluation 分离

```text
Acceptance Criterion
= 什么算成功

Verification Spec
= 怎样测

Acceptance Evaluation
= 某次执行的实际结果
```

不能把三者混在一个 `passed` 字段。

---

# 22. Plan Compiler

v1.6 新增一个核心组件：

```text
Plan Compiler
```

输入：

```text
v1.6.plan.yaml
+
JSON Schema
+
当前 SQLite repository model
```

输出：

```text
ValidatedPlanIR
```

再事务性写 SQLite。

---

# 23. `parsePlanDocument()`

```ts
function parsePlanDocument(
  yamlText: string,
): RawPlanDocument
```

## 输入

YAML bytes。

## 输出

只做 parser-level object。

## 不做

不绑定源码、不访问 DB、不决定 readiness。

## 测试

- valid YAML；
- duplicate keys fail；
- aliases/anchors policy 明确；
- unknown field 保留或拒绝按 schemaVersion policy；
- 1 MiB 输入 hard limit（可配置）。

---

# 24. `validatePlanSchema()`

```ts
function validatePlanSchema(
  raw: RawPlanDocument,
  schema: JsonSchema,
): SchemaValidationResult
```

## 验收

`v1.6.plan.yaml` 必须零 schema errors。

---

# 25. `resolvePlanBaseline()`

```ts
async function resolvePlanBaseline(
  repo: RepositoryIndex,
  selector: BaselineSelector,
): Promise<ResolvedBaseline>
```

## 支持

```text
PINNED_SHA
CURRENT_HEAD
CURRENT_WORKTREE
RESOLVE_AT_ACTIVATION
```

## 规则

Draft 可以 unresolved。

Active plan 必须 pinned 到明确 repo snapshot。

---

# 26. `bindObservedDesignTargets()`

```ts
function bindObservedDesignTargets(
  db: ProjectMemory,
  plan: ValidatedPlanIR,
  baseline: ResolvedBaseline,
): DesignBindingResult
```

## 对 MODIFY/REMOVE/RENAME

必须找到 baseline object。

## 对 ADD

不得错误绑定现有 symbol。

## 验收

ambiguous match = hard error。

---

# 27. `captureBaselineFunctionContract()`

```ts
function captureBaselineFunctionContract(
  db: ProjectMemory,
  symbolVersionId: string,
): ObservedFunctionContract
```

## 数据来源

```text
symbols/symbol_versions
TypeChecker
call_sites
symbol_references
source anchors
```

## 输出

```ts
interface ObservedFunctionContract {
  symbolVersionId: string
  signature: string
  visibility?: string
  async: boolean
  static: boolean
  parameters: ParameterContract[]
  returnType: string
  effects: EffectContract[]
  outgoingCalls: ObservedCallEdge[]
}
```

## 验收

结果必须可由 pinned source 重建。

---

# 28. `compileTargetFunctionContract()`

```ts
function compileTargetFunctionContract(
  planContract: PlanFunctionContract,
  baseline?: ObservedFunctionContract,
): TargetFunctionContract
```

支持：

```text
EXPLICIT
SAME_AS_BASELINE
ADD
REMOVE
PROHIBIT
```

例如：

```yaml
return:
  policy: same-as-baseline
```

必须在 activation 时 resolve 成具体 target value，避免实施时 baseline 漂移。

---

# 29. `compilePlannedCallEdges()`

```ts
function compilePlannedCallEdges(
  target: TargetFunctionContract,
  bindings: DesignBindingIndex,
): PlannedCallEdge[]
```

## 输出动作

```text
ADD
RETAIN
REMOVE
PROHIBIT
```

## callee 类型

```text
OBSERVED_OBJECT
DESIGN_OBJECT
EXTERNAL
```

---

# 30. `compileAcceptanceCriteria()`

```ts
function compileAcceptanceCriteria(
  specs: readonly PlanAcceptanceSpec[],
): AcceptanceCriterion[]
```

每条必须有：

```text
what
required?
verifier
expected result
applicable scope
```

Owner/manual criterion 可以没有 command，但必须有 actor role。

---

# 31. `compilePlan()`

```ts
async function compilePlan(
  input: PlanCompileInput,
): Promise<PlanCompileResult>
```

顺序固定：

```text
parse YAML
→ JSON schema
→ semantic validation
→ baseline resolution
→ object binding
→ baseline contract capture
→ target contract compile
→ dependency cycle check
→ owner/resource/decision check
→ acceptance completeness
→ produce immutable PlanIR
```

不得边编译边部分写正式 DB。

---

# 32. `importPlanVersion()`

```ts
function importPlanVersion(
  tx: ProjectTransaction,
  ir: CompiledPlanIR,
): ImportedPlanVersion
```

一个 transaction 写：

```text
plan version
objectives
targets
phases/milestones
work items
relations
actors/roles refs
decisions/resources
design objects/change specs
contracts/planned calls
acceptance
project events
```

失败整体 rollback。

---

# 33. `planDoctor()`

```ts
function planDoctor(
  db: ProjectMemory,
  planVersionId: string,
): PlanDoctorReport
```

至少检查：

```text
active baseline pinned
MODIFY targets bound
no ambiguous baseline
ADD targets not colliding
function TARGET contracts complete
planned callees resolvable
all required acceptance has verifier
work dependency DAG acyclic
hierarchy acyclic
Owner task executor_kind correct
resource blockers typed
decision blockers typed
phase gates exist
all hard references current
```

Activation 前 `errors=0`。

---

# 34. `activatePlanVersion()`

```ts
function activatePlanVersion(
  tx: ProjectTransaction,
  planVersionId: string,
  actorId: string,
): void
```

必须：

```text
planDoctor errors=0
baseline snapshot pinned
no other conflicting active version for same plan
append project event
supersede prior active version
```

---

# 35. `computeWorkReadiness()`

```ts
function computeWorkReadiness(
  db: ProjectMemory,
  workItemId: string,
): WorkReadiness
```

检查：

1. active plan；
2. parent/phase gate；
3. work dependencies；
4. required decisions；
5. required resources；
6. approvals；
7. scope conflicts；
8. actor capability；
9. target not superseded；
10. baseline/target contract still valid。

输出：

```ts
{
  ready: boolean
  blockers: Blocker[]
  requiredRoleIds: string[]
  allowedScopes: ScopeSpec[]
}
```

---

# 36. `claimWorkItem()`

```ts
function claimWorkItem(
  db: ProjectMemory,
  request: ClaimWorkRequest,
): ClaimedWork | ClaimRejected
```

SQLite：

```text
BEGIN IMMEDIATE
compute readiness
create lease
create assignment/attempt as needed
append event
COMMIT
```

两个 Agent 并发只能一个 primary claim 成功。

---

# 37. `buildWorkPacket()`

这是 Project Ledger 与 Context-Light 的连接点。

```ts
function buildWorkPacket(
  db: ProjectMemory,
  claimed: ClaimedWork,
  budget: ContextBudget,
): WorkPacket
```

只带：

```text
work objective
active target assertions
relevant change specs
baseline/target contract delta
relevant rules
verified memory refs
allowed scope
acceptance criteria
resource/decision facts
```

不带整份 v1.6 Markdown。

---

# 38. `startWorkAttempt()` / `finishWorkAttempt()`

```ts
function startWorkAttempt(...): WorkAttempt
function finishWorkAttempt(...): WorkAttemptResult
```

一个 work item 可以跨多个 agent attempts。

历史不覆盖。

---

# 39. `bindImplementation()`

代码修改后：

```ts
function bindImplementation(
  db: ProjectMemory,
  changeSpecId: string,
  newSnapshotId: string,
): ImplementationBindingResult
```

重新机械索引，找到 target stable key 对应真实 symbol/object。

如果：

```text
ADD function 没出现
MODIFY function 消失
ambiguous implementation
```

返回 mismatch。

---

# 40. `compareFunctionContracts()`

```ts
function compareFunctionContracts(
  target: TargetFunctionContract,
  implemented: ObservedFunctionContract,
): FunctionContractDiff
```

必须比较：

```text
parameter order/name/type/optional
return type
visibility/async/static
effects
required/prohibited outgoing calls
```

“测试过了”不能覆盖 contract mismatch。

---

# 41. `evaluateAcceptance()`

```ts
async function evaluateAcceptance(
  db: ProjectMemory,
  criterionId: string,
  workAttemptId: string,
): Promise<AcceptanceEvaluation>
```

支持：

```text
command
vitest
SQL assertion
graph query
contract diff
benchmark
resource verification
owner review
manual
```

每次 evaluation append history。

---

# 42. `evaluateTargetState()`

```ts
function evaluateTargetState(
  db: ProjectMemory,
  targetAssertionId: string,
): TargetStateEvaluation
```

状态：

```text
NOT_IMPLEMENTED
IMPLEMENTED_UNVERIFIED
VERIFIED
FAILED
BLOCKED
SUPERSEDED
```

---

# 43. `declareResourceRequirement()` / `verifyResource()`

资源 requirement、实例、验证分层。

Android 例：

```text
Requirement:
ANDROID_PHYSICAL_DEVICE
api >= 30
developerMode=true
usbDebugging=true
adbAuthorized=true
```

Owner 提供 instance 后仍需 verification。

---

# 44. `requestDecision()` / `resolveDecision()`

Decision request 必须允许：

```text
options
pros/cons
recommended option
blocking level
required role
```

Owner answer 写 immutable decision record。

---

# 45. `assignWork()` / `handoffWork()`

多 Agent：

```text
Agent1 primary
Agent2 reviewer
Agent3 tester
```

Handoff 只带：

```text
work id
repo snapshot
DB memory refs
artifacts
short summary
```

不复制 transcript。

---

# 46. `reserveScope()`

防止：

```text
Agent1 和 Agent2 同时写 packages/core/tools/src/index.ts
```

scope kind：

```text
path
package
module
symbol
```

read/write 模式分开。

Scope reservation 是协作冲突机制，不替代 sandbox。

---

# 47. `compileWorkflow()` / `runWorkflowNode()`

将：

```text
parallel
pipeline
phase
gate
join
```

写数据库 workflow graph。

实际执行可继续复用 DSH workflow/subagent 能力。

Project DB 保存跨 session 的正式状态。

---

# 48. v1.6 自身 Plan Fixture

配套 `fork-mini-DSH-v1.6.plan.yaml` 是第一份 golden fixture。

它至少结构化以下阶段：

```text
P00 Pin source / baseline
P01 Schema migration
P02 Plan parser/schema/compiler
P03 Project event/projection
P04 Work/readiness/lease
P05 Decision/resource/owner workflow
P06 Design intent/function contracts
P07 Acceptance/conformance
P08 Multi-agent collaboration
P09 Plan-as-Data Context-Light integration
P10 Self-bootstrap import
P11 Real mini-DSH trial
P12 Regression/release gate
```

---

# 49. v1.6 自举测试 BOOT-01

```text
Given:
  empty v1.6-compatible project DB
  v1.6.plan.yaml

When:
  mini-dsh plan import
  mini-dsh plan doctor

Then:
  schema errors = 0
  semantic errors = 0
  unresolved hard refs = 0 before activation
  project plan is queryable without opening Markdown
```

---

# 50. BOOT-02：Agent 只靠数据库取得任务

启动 Fresh Agent。

禁止给：

```text
v1.6.md
v1.6.plan.yaml全文
```

只允许：

```bash
mini-dsh project next --agent agent-1
```

Agent 必须取得：

```text
work objective
baseline/target delta
relevant rules
acceptance
scope
blockers
```

并能执行 fixture task。

---

# 51. BOOT-03：Owner Todo 分离

数据库中创建：

```text
Owner Android resource task
Agent Android E2E task
```

验收：

```text
project todo --owner
```

只显示 Owner action/decision。

```text
project todo --agent
```

Agent task显示 BLOCKED_RESOURCE，不把 Owner todo 伪装成 Agent task。

---

# 52. BOOT-04：函数 ChangeSpec 完整性

fixture baseline：

```text
function foo(a: string): Promise<number>
foo → bar
```

plan：

```text
MODIFY foo
retain parameter
return same
retain bar
add audit
```

验收 DB 可以完整查询：

```text
baseline contract
target contract
planned calls
acceptance
```

无需打开 Markdown/YAML。

---

# 53. BOOT-05：Target vs Implemented conformance

Agent 故意实现错误返回类型。

测试即使 runtime unit test 暂时通过，也必须：

```text
contract conformance = FAIL
work item != DONE
```

修正后才 PASS。

---

# 54. BOOT-06：多 Agent 并发 claim

Agent1/Agent2 同时 claim W100。

期望：

```text
只有一个 lease 成功
另一个得到 CLAIM_CONFLICT
```

---

# 55. BOOT-07：并行不冲突 scope

Agent1：

```text
packages/project-memory/**
```

Agent2：

```text
packages/project-analysis/**
```

允许并行。

两个都申请同一 exclusive path 时必须阻塞。

---

# 56. BOOT-08：计划升级历史

激活 v1.6 后导入 v1.6-test-revision。

不得修改旧 version。

必须：

```text
old=superseded
new=active
plan_version_changes 有 delta
project_events 可重放
```

---

# 57. Project Status 不是虚假百分比

输出：

```text
Objectives
Targets
Phases
Milestones
Agent-ready
Agent-running
Owner-blocked
Environment-blocked
Open decisions
Failed acceptance
```

不要默认输出“73% done”。

---

# 58. `computeProjectStatus()`

```ts
function computeProjectStatus(
  db: ProjectMemory,
  projectId: string,
): ProjectStatus
```

从 projection 计算，不让 LLM猜。

---

# 59. v1.6 实施工作包

严格：

```text
WP00 reference/source pin
WP01 v1.6 schema migration
WP02 Plan JSON Schema + parser
WP03 Plan semantic compiler
WP04 project event ledger/projection
WP05 work item hierarchy/dependencies
WP06 actors/roles/assignments/leases
WP07 decisions/resources/owner tasks
WP08 design objects/change specs
WP09 function contracts/planned calls
WP10 acceptance/conformance
WP11 workflow/handoff/scope reservations
WP12 work packet / Context-Light integration
WP13 self-bootstrap import
WP14 multi-agent fixture
WP15 real mini-DSH plan trial
WP16 regression/release
```

每个 WP：Red → Green。

---

# 60. WP00 — Source pin

记录：

```text
DSH pinned SHA
v1.5 schema version
SQLite version
Node/pnpm/TS
GitLab/OpenProject/Redmine reference date
```

---

# 61. WP01 — Schema Migration

v1.5 DB fixture → v1.6。

必须保留：

```text
repository facts
memory/evidence
runtime history
call graph
analysis history
```

---

# 62. WP02 — Plan Schema

`mini-dsh-plan-v1.schema.json` 是机器规范。

必须验证配套 YAML。

---

# 63. WP03 — Plan Compiler

parse/schema/semantic/bind/contract/acceptance/DAG 全部先在内存 PlanIR 完成。

之后事务导入。

---

# 64. WP04 — Event Ledger

所有 project mutation 写 event。

Current projection 与 event replay fixture 对账。

---

# 65. WP05 — Work Graph

hierarchy 与 relation 分开。

检测：

```text
parent cycles
dependency cycles
self-block
invalid inverse semantics
```

---

# 66. WP06 — Multi Actor

actor/role/assignment/lease。

并发 SQLite claim tests。

---

# 67. WP07 — Owner/Environment

Android physical-device fixture。

证明 Owner provided != verified resource。

---

# 68. WP08 — Design Intent

ChangeSpec / design object / baseline binding。

---

# 69. WP09 — Function Contract

参数/返回/effects/planned call edge。

与 v1.5 TypeChecker graph 对接。

---

# 70. WP10 — Acceptance

criterion / verifier / evaluation history / contract diff。

---

# 71. WP11 — Collaboration

handoff / scope reservation / conflict / workflow graph。

---

# 72. WP12 — Context-Light Work Packet

Agent 不读 Master Plan。

数据库检索 bounded packet。

4K lane hard test。

---

# 73. WP13 — Self Bootstrap

导入本 v1.6 plan。

所有 BOOT-01..08 通过。

---

# 74. WP14 — Multi-Agent fixture

至少：

```text
Agent1 implementation
Agent2 independent review
Agent3 test/benchmark
Owner one decision/resource
```

含并行 + join。

---

# 75. WP15 — Real mini-DSH Trial

从真实 fork 当前 snapshot：

```text
Plan importer
→ next work
→ Fresh Agent
→ implementation
→ sync/index
→ conformance
→ acceptance
→ handoff/review
```

不把 v1.6 文档作为执行时 prompt。

---

# 76. WP16 — Regression

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run check:ci
```

并运行 DB doctor / event replay / migration fixture。

---

# 77. v1.6 Definition of Done

全部满足才可宣布完成：

- [ ] v1.5 DB 可无损迁移
- [ ] Project 与 Repository 分离
- [ ] Plan immutable versioning
- [ ] v1.6.plan.yaml 可 schema validate
- [ ] Plan semantic compiler 可用
- [ ] Plan import 事务原子
- [ ] Project event append-only ledger
- [ ] Work hierarchy/dependency 分离
- [ ] Owner todo / Agent todo 可独立查询
- [ ] Resource requirement/instance/verification 分离
- [ ] Decision/Approval 分离
- [ ] Actor/Role/Assignment 分离
- [ ] Work lease 防双 claim
- [ ] Scope reservation 可工作
- [ ] Design object 可表示未来对象
- [ ] ChangeSpec 可绑定 baseline object
- [ ] Baseline function contract 可机械捕获
- [ ] Target function contract 可完整存储
- [ ] Planned calls 与 observed call_sites 分离
- [ ] Implementation binding 可建立
- [ ] Contract diff 可阻止错误实现完成
- [ ] Acceptance criterion/spec/evaluation 分离
- [ ] Multi-Agent handoff/workflow 可记录
- [ ] Project Status 可结构化查询
- [ ] Agent work packet 不需读取 Master Plan
- [ ] BOOT-01..08 全绿
- [ ] 4K Context-Light benchmark 不回归
- [ ] upstream regression 全绿

---

# 78. 最终 Coding Agent 执行协议

```text
你正在实现 mini-DSH v1.6。

原则：
计划本身是项目数据，不是每个 Agent 都要重新阅读的大段自然语言。

必须：
1. 先完成 v1.6 schema migration。
2. 实现 Plan JSON Schema + parser + compiler。
3. 计划未通过 planDoctor 不得 activate。
4. MODIFY/REMOVE target 必须绑定 pinned baseline object。
5. 函数变化必须有 baseline contract + target contract。
6. observed call_sites 与 planned_call_edges 分离。
7. 每个 ChangeSpec 必须至少一个 acceptance criterion。
8. Owner work、Agent work 共用 Work Item 底座但查询分离。
9. Environment resource 需要独立 verification。
10. Decision 与 Approval 分离。
11. 多 Agent claim 必须使用 lease。
12. Agent 默认只通过 buildWorkPacket 获取当前任务最小上下文。
13. 不允许把整个 active plan 文档塞入普通 Worker prompt。
14. 完成实现后重新 index source，建立 implementation binding。
15. target-vs-implemented contract mismatch 时任务不得 Done。
16. 所有 project mutation 写 project event。
17. 严格 WP00→WP16，先 Red 后 Green。
18. v1.6.plan.yaml 自举测试必须通过。
19. 4K lane 不允许偷偷扩到 8K。
20. 不因本功能重写 DSH core Agent Loop；优先 seam/plugin/provider。
```

---

# 79. 结论

v1.5 让 mini-DSH 能把代码仓库变成结构化知识。

v1.6 再向前一步：

> **让“未来要怎样改变这个仓库”本身也成为结构化、可执行、可验证、可协作的数据。**

最终 Agent 不再被要求：

```text
“先重新读一遍 3000 行项目计划，再想今天该干什么。”
```

而是：

```text
claim one ready work item
→ retrieve exact baseline/target delta
→ retrieve relevant rules/memory
→ execute
→ bind implementation
→ verify acceptance
→ append events
→ handoff / next item
```

这才是真正的 Context-Light Project Agent。
