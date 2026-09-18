# Agent Note：doc-sync 在 fork 转绿，与一条活得比 verifier 长的租约

Status: implemented

[English](2026-09-19-docsync-green-on-fork.md) | 中文

## 问题

仓库的完整文档门（`pnpm run doc-sync`，41 项检查）从未在本 fork 上通过：fork 自己的包里积着 40 处导出 API JSDoc 违规，`ctx.projectLedger` 服务缺席 cordis catalog 的 `SERVICE_PAGE` 分区与 capability-seams 角色表，`project` 包组没有 subsystem 页链接，生成类 catalog（config catalog、capability seams）过期且双语言侧失同步，docs/mini/ 下的归档方案文档带着被文档类型检查拒绝的伪代码 `ts` 围栏和早于分组布局的包路径引用。每个增量都在用更轻的 `test:docs` 聚合替代，把这一切藏了起来。此外，修复后的首次 lane 运行暴露出一个潜伏的 lane 缺陷：一旦存储 verifier 是六分钟的 doc-sync 套件，默认租约 TTL 在 verifier 中途过期，报告落在 reaper 接管的租约上。

## 决策

修门本身，而不是扩大豁免。四十处 JSDoc 补在门要求的地方（错误类 `code` 属性、宪法镜像 schema 常量、`formatZodPath`/`languageOf` 的 `@param`/`@returns`、project-memory 的十二个 id 工厂——解析器读不了单行内嵌标签，标签必须自成一行）。`ctx.projectLedger` 作为一个子系统进入三张登记表：`SERVICE_PAGE` 条目、`SERVICE_ROLES` 条目（提供方 `project-ledger-sqlite`、消费方 `mini-profile`）、以及新的双语 `docs/subsystems/project-ledger.md` 页并被两个组 README 索引；`project` 组带理由地进入 `GROUPS_WITHOUT_SUBSYSTEM_PAGE` 豁免（存储与分析原语；挂载服务归 experimental 包所有）。生成类 catalog 重新生成，且因为其双语言侧受 pairing 校验，zh 镜像按生成器自身的行序携带相同插入——mermaid 节点与边序、表格行序必须与 EN 生成器完全一致，反引号纯文本单元格保持无链接。归档伪代码围栏改为 `text`（原文不动；只有围栏语言声称了一个它从来不是的类型），两处路径引用补上 `project/` 组段。lane 以两倍 verifier 超时的 `leaseTtlMs` 挂载工作插件：存储 verifier 合理地可以长到分钟级，中途死掉的领取会浪费整次运行。

验证：`pnpm run doc-sync` 41/41 通过（约 6 分钟，这也界定了 lane verifier 的超时上限）；lane 在临时账本与持久账本上完成了 `PW-DOCSYNC-GREEN-001`（版本 2 在事件序号 47 处 supersede、条目 DONE、doctor 0、`replayDrift` 0），重跑幂等；4K 切片保持绿色，最大 2,444/4,096 估算 token；各包套件与 typecheck 通过（多包合并的 coverage 运行会让 project-analysis 的重索引测试在 5 秒超时——该包套件单独跑）。

## 考虑过的替代方案

**继续用 `test:docs` 替代。** 拒绝——该聚合恰好藏住本条目发现的那一类漂移（过期的生成 catalog、未登记的服务、未文档化的导出）；一个从不运行的门，就是一个已经失败的门。

**给 fork 的 README 示例用 `ts ignore-check` 围栏。** 对这里修的四个 README 拒绝——示例离可编译只差一个 `declare` 或一个 import，而能编译的示例不会随它演示的 API 一起腐烂。豁免围栏留给真正的草稿。

**lane 里起心跳循环而非加长 TTL。** 拒绝——lane 是确定性的单租户驱动器，不是竞争条目的 worker；挂载时把视界翻倍就把真实契约（任何 verifier 不得活过其领取）说清楚了，不需要定时线程及其收尾竞态。

## 后果

fork 从此与上游持有同一根文档准绳：此后任何新增导出、移动服务、或改动生成 catalog 源的变更，都要等登记与双语言侧一起移动才能通过 doc-sync——而 lane 的存储 verifier 就是这门，§33 记录会持续证明它。租约规则就此显式化：任何长于默认 TTL 的 lane 驱动 verifier 都需要配置的视界，未来的分钟级 verifier（完整 typecheck、hygiene）可以放心存储。`PW-EVIDENCE-DIGEST-001`（`/project` 的 owner 证据摘要视图）在版本 3 中保持可领取，作为下一增量。
