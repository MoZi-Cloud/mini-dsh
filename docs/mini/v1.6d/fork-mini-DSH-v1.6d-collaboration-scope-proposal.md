# mini-DSH v1.6d Scope Proposal: Multi-Agent Collaboration

English | [中文](fork-mini-DSH-v1.6d-collaboration-scope-proposal.zh.md)

Date 2026-09-19. This document is the v1.6d prework named in the v1.6b closing gate: a scope breakdown and a minimal collaboration-slice proposal for owner review. No implementation ships with it; the entry decision stays with the owner through the §33 gate. Basis: the graded route §1 family "v1.6d — Multi-Agent Project Collaboration" of `fork-mini-DSH改造方案-v1.6a.md`, and the v1.6 blueprint attachment (`docs/mini/HISTORY/fork-mini-DSH-v1.6-SQLite数据库架构附件.md`) §18 assignments, §21 scope_reservations, §28 handoffs, §29 collaboration_conflicts, §46–48 projections. v1.6c (Function Contract) stays research-gated and is not touched here.

## What already stands

- **Actors, roles, role assignments** (v1.6b, schema 5): `actors` (`HUMAN`/`AGENT`/`SERVICE`/`SYSTEM`), `roles` (`GOVERNANCE`/`EXECUTION`), and `actor_roles` with one live assignment per actor-role pair as a database fact. The ledger's own cast is registered: `actor:mini-dsh:owner` (HUMAN) and `actor:mini-dsh:agent:mini-real-use-lane` (AGENT).
- **Leases name their holder** (v1.6a): `work_leases.worker_identity` carries the actor string, one `ACTIVE` lease per work item; every real-use claim to date names the one lane.
- **The decisions domain** (v1.6b) is a resolution record a conflict can point to — blueprint §29's `resolution_decision_id` already has a live referent.
- **Projections** (v1.6a): `computeWorkReadiness` with typed blockers, `listOwnerTodo`/`listAgentTodo` partitioned by `executor_kind` — a scheduling projection with a single-agent reality: one agent claims everything.

## Two tables share the word "assignments"

The §1 family line "actors / roles / assignments" reads as half delivered, and the half matters: v1.6b shipped the project-scoped `actor_roles` (who holds which role in the project), not the blueprint §18 `assignments` (who holds which duty on which work item, `assignment_kind` primary/collaborator/reviewer/tester/observer/accountable). This proposal uses "assignments" for §18 only and keeps the two tables distinct; the zh mirror separates them as 角色指派 (actor_roles) and 工作指派 (§18).

## Scope breakdown

- **Work assignments (§18)**: the missing piece of the family bullet — an actor's duty on one item. Adaptations follow the standing pattern: project-scoped keys, actor strings over actor ids, uppercased kind/status values; `assignment_kind` needs a closed vocabulary, and the open question is all six blueprint values or a smaller start.
- **Handoffs (§28)**: a recorded pass of one item between actors — `from_actor`, `to_actor` or `to_role`, inline summary text over `summary_content_id`, artifact and memory refs as JSON objects at the parser seam. Acceptance is the natural second event; with no consumer shipping alongside, the unaccepted state can stay CHECK-legal and writer-less (the `REVOKED`-lease precedent).
- **Scope reservations (§21)**: ownership of a scope (`scope_kind`/`scope_value`) across items — the piece leases do not cover, since a lease owns one item's execution while a reservation keeps other items' agents out of a scope. The blueprint's own `idx_scope_active` ships unchanged.
- **Collaboration conflicts (§29)**: what slips through reservations — a `conflict_kind`, two items, and resolution recorded as a decision in the v1.6b decisions domain.
- **Scheduling projection**: no new authority — readiness stays computed, the todo views stay; the change is per-actor claim visibility, so a second agent sees the queue without another agent's live claims.

## What v1.6d deliberately excludes

- **Blueprint §30/§31 workflow tables**: the §1 ruling stands — DSH workflow/subagent remains the execution engine, and recording workflow definitions and runs in the project DB would copy a second workflow authority into it. The workflow packages stay untouched (the v1.6a §32 DoD item holds).
- **`work_attempts` (§19)**: attempt history is already carried by the event timeline and the lease lifecycle; a second record would add parity obligations with no consumer.
- **v1.6c tables** (function contracts, parameters, planned call edges, bindings): research-gated per the proposal, out of scope here.

## The minimal collaboration slice — two stages

- **Stage A, sequential collaboration**: work assignments + handoffs + per-actor claim visibility. A second `AGENT` actor registers; one work item passes between the two agents through a recorded handoff. Claims never overlap, so no conflict surface is needed yet. One appended migration (schema 5→6) and one event-format bump (5→6) carry the stage's events.
- **Stage B, parallel collaboration**: scope reservations + collaboration conflicts. The two agents claim overlapping scopes; reservations prevent the overlap, conflicts record what slips through, and resolution lands in the decisions domain. One more appended migration (6→7) and format bump (6→7).
- The staging rationale: each stage is one real-use lane run with its own §33-style evidence; stage A's handoff rows are exactly the raw material stage B's conflicts would otherwise lack; a single four-table batch would couple two different risk profiles. A one-batch alternative is viable if the owner prefers one entry decision over two.

## Structural constraints inherited

- Schema 5 with five frozen adjacent steps: each stage appends exactly one step, one `BEGIN IMMEDIATE` each; the committed v1 fixtures stay the standing upgrade probes; the persistent timeline (145 events, stamps 1–5) keeps decoding.
- Format 5 with 24 required event types: each stage's events arrive with payload validation, replay appliers, and parity in both sweeps (`readProjectReplay` and the doctor); the decoder keeps rejecting only rows stamped newer than the build.
- Reserved states stay CHECK-legal and writer-less where no consumer ships (unaccepted handoffs, ended work assignments).
- The owner surface stays read-only: `/project` views extend; writes are library seams the owner's scripts call.
- The 4K deterministic gate holds per agent: two agents are two contexts, each within the 4,096-token budget — not one doubled budget.

## Entry gate

§33 applies unchanged: the entry basis must come from real-use records in the ledger, not from a design that looks complete. Today's record: 30 completed work items in the ledger (15 golden-plan, 15 real-use), no BOOT/4K regression in any lane run to date, the v1.6b completion report accepted. The entry decision itself can be the decisions domain's second gate use — a `decision/requested` the owner resolves the way `dr:mini-dsh:v1.6b-entry` opened v1.6b. Open questions for the owner: stage ordering (A then B, or one batch), the `assignment_kind` vocabulary size, second-agent actor naming (the `actor:mini-dsh:agent:<lane>` pattern exists), and whether stage B's `conflict_kind` closes at entry or at stage B's plan.
