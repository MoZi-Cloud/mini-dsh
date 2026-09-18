# mini-DSH v1.6a BOOT Acceptance Report

English | [中文](fork-mini-DSH-v1.6a-BOOT-acceptance.zh.md)

Date 2026-09-18; the acceptance baseline is the commit batch that introduces this report (its first version is the first entry of `git log --follow` on this file; no hash is pinned here, so rebase history cannot rot the document). Basis: `fork-mini-DSH改造方案-v1.6a.md` §29 BOOT checklist, §32 DoD, §34 final report; all 15 work items of the golden plan `fork-mini-DSH-v1.6a.plan.yaml` are complete.

## Versions and artifacts

- Pinned SHA: the commit that first lands this report (`git log --reverse -- docs/mini/v1.6a/fork-mini-DSH-v1.6a-BOOT-acceptance.zh.md`, first entry); each W01–W12 delivery commit is named by its Agent Note.
- Schema version: `PROJECT_LEDGER_SCHEMA_VERSION = 1` (SQLite `user_version`, monotonic, mismatch fails closed; see `dsh-experimental-project-ledger-sqlite`).
- Event format version: `PROJECT_EVENT_FORMAT_VERSION = 1`; all 14 required v1 events have read/replay semantics (`plan/version-superseded` and `baseline/drift-detected` through validation-only appliers).
- Packet format version: `WORK_PACKET_FORMAT_VERSION = 1`, builder version `1`.
- Tables (13): plans, plan_versions, phases, work_items, work_item_relations, work_external_blockers, acceptance_criteria, verification_specs, acceptance_evaluations, project_events, plan_imports, plan_compile_diagnostics, work_leases.
- Indexes: plan_versions(plan,status), three work_items indexes (ready/phase/parent), both relation directions, external blockers, evaluations, project_events(project,type,seq), compile diagnostics, the `uq_one_active_lease_per_work` partial unique index, and lease expiry.
- Migration fixtures: the adjacent-migration and downgrade-reject tests in `schema.spec.ts`, plus `fixtures/project-ledger/v1.6a-empty.db` (empty probe) and `v1.6a-populated.db` (golden import plus three real completions, 28 events, doctor reports 0 issues); both regenerate with fixed stamps from `scripts/gen-project-ledger-fixtures.ts`.

## BOOT-01..08

- BOOT-01, golden import plus doctor equals 0 errors: `tests/doctor.spec.ts` (F05 `planDoctor`, implemented in this batch; 0 issues before and after activation and across a full real work loop); the populated fixture's generator run also doctors clean.
- BOOT-02, fresh agent reads no Master Plan: the `benchmarks/context-light` deterministic lane — every scripted action (work item id, verifier command) is extracted from the WorkPacket already in the conversation, and the plan document never enters model context; `work-packet.spec.ts` additionally rebuilds the packet from a reopened database via its recipe alone.
- BOOT-03, owner/agent query separation: `tests/todo-views.spec.ts` (listOwnerTodo/listAgentTodo disjoint by executor kind, ordered, carrying readiness and the live lease).
- BOOT-04, replay equals materialized projection: the materializedProjection parity assertions across the events/readiness/acceptance/lease/work-packet/versioning specs, plus the doctor's projection-drift checks (which also catch out-of-band writes).
- BOOT-05, unknown schema fields/enums/verifier shapes fail closed: `tests/plan-schema.spec.ts` (constitution-mirror parity, unknown field/enum/verifier rejection) and `tests/import.spec.ts`.
- BOOT-06, two concurrent claimers yield one lease, expired leases reap safely: `tests/lease.spec.ts` (the two-connection BEGIN IMMEDIATE lock-boundary test, the partial-unique-index backstop, and the bounded reaper that never declares FAILED).
- BOOT-07, WorkPacket hash rebuilds equal: `tests/work-packet.spec.ts` (file-backed reopen, rebuild from database plus packet id only, hash equality with the record, per-reference drift naming).
- BOOT-08, supersede keeps history: `tests/versioning.spec.ts` (superseded versions stay queryable, new claims stop, active attempts land BLOCKED for review, evaluations stay byte-identical, the baseline pin never moves).

## 4K benchmark (AC-4K-001)

`./benchmarks/context-light/run-4k.sh` exits 0: the deterministic lane makes 6 model requests with a maximum estimated 2,308 tokens (budget 4,096 including the 512-token reserved output; 4 characters per token), a WorkPacket serialization of 2,301 bytes, all five tools once, verifier subprocess exit 0, item DONE, criterion PASSING, replayed projection consistent; context overflow equals 0 (over-budget requests throw, and none occurred). The live lane (DSH_4K_LIVE=1 with DEEPSEEK_API_KEY) takes its final verdict from provider usage; no key exists in this environment, so it self-skips per the repository's real-API key policy.

## WorkPacket token/context breakdown

The peak request is 7,184 bytes ≈ 1,796 estimated tokens plus the 512 reserved output = 2,308: the five-line persona, five tool schemas, the WorkPacket (2,301 bytes ≈ 575 tokens), and the accumulating tool results; the first request is 949 tokens and the growth is mostly tool results and history. Roughly 1,788 tokens of headroom remain inside the 4K budget.

## plan-mode / todo boundary and bridge result

Plan-mode state is never synced into project plans automatically, and a session todo is never project identity (§5). `tests/bridges.spec.ts` pins the structural decoupling: agent-loop, agent, plan-mode, and tool-todo declare no ledger dependency, and the ledger declares no harness runtime. §5.3's `todo completed != project work item done` is enforced by the ledger itself: the `acceptance-not-passed` gate makes DONE reachable only through VERIFYING with every required criterion PASSING or WAIVED. The optional bridge projecting packet-local steps onto a session todo is not implemented; it belongs to a future integration.

## Application entrypoint gate

`pnpm run verify-application-entrypoints` is green: dsh is the only supported Node application launcher; the product form is `dsh --profile mini` (mounted via `dsh plugin --profile mini add @deepseek-ai/dsh-experimental-mini-profile`, the W08 isolation-conformant design), with no package bin anywhere.

## Focused regressions and repository gates

The three experimental packages total 215 passing tests (ledger 186, sqlite 24, mini-profile 5); per-file 100% coverage; the full typecheck is green; hygiene 16/16; `test:docs` 20/20; duplication carries only the two pre-existing clones. Upstream core packages are untouched: W05–W12 modified no `packages/core/` implementation (pinned structurally by bridges.spec).

## §32 DoD checklist

Met, each with a verifier or evidence: prerequisites in-repo (PRE-001 verifier PASS; the v1.6 design history lives in `docs/mini/HISTORY/`; no v1.4/v1.5 code exists and v1.6a assumes none), no standalone bin, the profile as the only product form, strict-schema fail-closed, the verifier discriminated union, import separated from activation (activation is the owner seam, no writer yet), boundary tests, monotonic fail-closed `user_version`, adjacent migration fixtures, the event format version with ignorable semantics, replay parity, hierarchy/dependency separation, cycle detection, append-only evaluations, verifier execution never bypassing the shell/sandbox seam (the ledger stores commands only; the 4K slice executes through a real subprocess), the complete lease lifecycle, the WorkPacket invariant, the 4K gate present and passing, BOOT-01..08 all green, context overflow 0, no core agent-loop modification, no disguised Function Contract mechanical facts (v1.6c deferred; no effects/call-prohibit decidability claimed), and no second workflow authority state machine (the workflow packages are untouched).

## v1.6b/c/d entry gate (§33)

The protocol requires continuous real mini-DSH use over at least N work items, no BOOT/4K regression, and owner confirmation of value. The real-use record so far is one pinned 4K slice (deterministic lane, plus the optional live lane) and the golden plan's own execution history; N is the owner's decision, so the entry decision stays with the owner on the basis of real usage recorded in the ledger.
