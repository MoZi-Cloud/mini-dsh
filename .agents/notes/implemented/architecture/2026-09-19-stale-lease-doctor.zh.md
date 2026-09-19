# Agent Note：doctor 的租约过期检查

Status: implemented

[English](2026-09-19-stale-lease-doctor.md) | 中文

## 问题

`reapExpiredLeases` 由调用方驱动且有界分批，没有任何读取方替它挂载：冷打开的账本——或在 reaper 两批之间读取的账本——可能持有这样的 `work_leases` 行：`status` 仍写着 ACTIVE，而它自己的 `expires_at_ms` 已经过去。行在自我矛盾，却没有任何读表面说出来：重放对账折叠同样的事件、投影出同样的 ACTIVE，对等因此通过；todo 视图只列出活跃租约而不评判；doctor 巡检则根本没有时钟。读这种账本的操作者无从知道有恢复欠着。

## 决策

`planDoctor` 增加了租约过期检查，并随之带上第三个参数：`PlanDoctorOptions { nowMs }`，默认 `Date.now()`——这是 doctor 结论中唯一读墙钟的一项。判定谓词与 `reapExpiredLeases` 完全一致——`status = 'ACTIVE' AND expires_at_ms <= nowMs`——reaper 会收的行就是 doctor 会报的行，不多不少。检查与关系检查同样按项目划定（租约属于项目，不属于某个 plan 版本），封闭的 issue 集合新增 `stale-active-lease`，消息点名行、它的过期时刻、以及恢复归 reaper 所有。`/project doctor` 无需改动：它对 issue 列表逐条通用渲染。doctor 的完整工作回路测试现在为每次领取补上释放——与 shipped 工具在交付前后的做法一致——因为它钉在 1970 年的领取在真实时钟下会读作过期；被撤销租约的场景则钉住自己的读时钟，保持只关于被撤销的那一行。

验证：`doctor.spec.ts` 覆盖过期时刻的两侧（`expiresAtMs - 1` 保持干净，到 `expiresAtMs` 该行被点名），并证明已释放的行过了旧有效期也不会触发检查；两个包共 247 个测试，一次组合覆盖率运行逐文件 100%。lane 在临时账本与持久账本上均绿（版本 5 导入、版本 4 supersede、`PW-LEASE-DOCTOR-001` 由 `agent:mini-real-use-lane` 完成、存储 verifier `pnpm exec vitest run project-ledger mini-profile` 退出码 0、doctor 0、`replayDrift` 0、90 事件），重跑幂等；4K 切片保持最大 2,444/4,096 估算 token。

## 考虑过的替代方案

**在 doctor 巡检内顺带收割。** 否决——doctor 绝不变更（F05）；为了让 reaper 滞后不可见而把读巡检变成写入者，既破坏巡检契约，又与真正的 reaper 竞争。

**专门的 `/project leases` 视图。** 否决——为 doctor 巡检已经拥有的一项事实新增命令表面；通用 issue 渲染零改动即可携带它。

**给每个读取方挂 reaper 循环作为解法。** 否决——缺口在于观测"有恢复欠着"，而不是 reaper 缺席；写入节奏属于工作表面与部署方，lane 自己在 verifier 中途过期的那次教训（报告落在 reaper 接管的租约上）已经说明过这一点。

## 后果

doctor 结论里恰好有一项检查依赖墙钟，`nowMs` 让测试保持确定性，其余每项检查仍然无时钟。读取冷账本的调用方现在能在依据租约事实行动之前，知道是否有恢复欠着。lane 的 `doctorIssues: 0` 通过线不受影响，因为 shipped 工具在交付前后会释放租约。§33 计数到达 25；`PW-4K-GATE-001` 在版本 5 中保持可领取。
