# mini-DSH v1.7 Code Improvement Plan

English | [中文](fork-mini-DSH-v1.7-improvement-plan.zh.md)

Date 2026-09-21. This plan lands the adopted-and-corrected recommendations of the [v1.1 review](../评审及改进建议.md) as a staged repair series: the two P0 repairs first, then the supported entry path, then evidence and maintenance convergence. Basis: the review's [phased proposal](../评审及改进建议.md#phased-proposal) and [acceptance matrix](../评审及改进建议.md#acceptance-matrix) (A-01–A-14), the [v1.6a proposal](../v1.6a/fork-mini-DSH改造方案-v1.6a.md) §8 and §18, and the [v1.6d completion report](../v1.6d/fork-mini-DSH-v1.6d-completion-report.md). v1.6c stays research-gated; v1.7 is the repair series the review's final assessment requires before any new domain.

## Basis and adopted findings

- **Adopted**: F-01 and F-02 (P0), F-03 and F-04 (P1), F-05, F-07, and F-08 (P2). F-06 stays a decision item: v1.6d delivered collaboration records and claim visibility on its narrowed scope, and scheduling constraints remain case-driven (the review's Phase D, unscheduled here).
- **F-01 category correction**: the v1.6a BOOT acceptance disclosed the deferral ("the ledger stores commands only"), so untrusted acceptance is a disclosed scope deferral rather than a hidden deviation; its P0 priority and its repair are unchanged.
- **Calibrated F-05 adoption**: no experimental package executes a command anywhere; the adopted point is that the new operations — activation, trusted verification, atomic reporting — get one typed service owner, not a rewrite for theoretical provider replacement.
- **Landing-cost clauses the minimum repairs must carry**: the `plan/version-superseded` fold takes over the lifecycle columns the supersede writer owns; the persistent ledger holds zero activation events, so lifecycle parity requires a recorded backfill of the currently-active versions first; the write seams each own a transaction and `BEGIN IMMEDIATE` cannot nest, so an atomic report needs transaction-scoped core variants; owner commands need the session-agent→ledger-actor identity mapping.
- **No schema migration**: `plan_versions` already carries `activated_at_ms` and `superseded_at_ms`; stage A bumps the event format (9→10) and leaves `PROJECT_LEDGER_SCHEMA_VERSION` at 9.

## Goal and exit conditions

- **Stage A — result truth and version authority**: a fabricated PASS cannot make work DONE; every ACTIVE version traces to a valid activation event; replay and the doctor detect direct lifecycle mutation (A-01–A-08).
- **Stage B — supported entry and interruption semantics**: a new user reaches the first READY work item through `dsh --profile mini` alone (A-09); every interrupted report has a deterministic, tested recovery (A-10).
- **Stage C — evidence and maintenance convergence**: a required event cannot register without a decoder and a fold policy (A-13); deterministic 4K mounts shipped tools or reports only payload-budget evidence (A-11, A-12); product-value conclusions stop depending on bootstrap tasks; READMEs and package descriptions state current behavior.
- Stages run in order, one gated work package each; a stage claims its exit conditions from keyed verification, not from the keyless implementation increment alone.

## Stage A — restore result truth and version authority

- **A1, activation lifecycle (F-02; A-06, A-07, A-08)**: `activatePlanVersion` validates DRAFT state, the one-active-version constraint, and clean import diagnostics in one `BEGIN IMMEDIATE`, writes status, `activated_at_ms`, and `plans.current_version_id`, and appends a strict `plan/version-activated` event. The event gains a payload decoder; unknown versions, duplicate activation, and illegal transitions fail closed. The fold takes in version status, both lifecycle timestamps, and the current pointer, and the supersede fold takes over its lifecycle columns. Supersede-plus-activation keeps the two-operation shape with its no-ACTIVE interval documented for callers; the atomicity guarantee attaches to each operation.
- **A2, historical continuity and benchmark migration (A-08 on the persistent ledger)**: the persistent timeline holds 9 `plan/imported` and 6 `plan/version-superseded` events and zero activation events — every version to date was activated by a raw owner update. Lifecycle parity therefore backfills exactly the three currently-ACTIVE versions (format 10, the retroactive recording disclosed in the real-use log): a retroactive activation cannot precede its already-recorded supersede in an append-only timeline, and the six superseded versions fold to the state the timeline already records. After the backfill, replay reads 0 drift and the doctor 0 issues. The context-light and real-use workers activate and supersede through the formal operation — retiring the context-light worker's unconditional `UPDATE plan_versions SET status = 'ACTIVE'` — and their verifier verdicts route through the A3 core.
- **A3, trusted verifier consumer (F-01; A-01–A-05)**: a trusted evaluation core in the ledger computes an executable criterion's verdict from its stored spec plus recorded execution facts, comparing the actual exit code against `expected_exit_code` and failing closed when `sandbox_required` is true and the facts are missing, denied, or the runner failed. The mini profile's report path executes COMMAND/TEST itself through the harness shell inside the owning agent's open turn, calling runtime `ctx.approval` when `approval_required` is true; the caller's `result` no longer decides an executable criterion, and a bare report records the claim as reported-evaluation history without a projection move. SQL_ASSERTION and GRAPH_ASSERTION stay ineligible for automatic completion; OWNER_CONFIRMATION stays owner-only. Execution facts land in the evaluation events, keeping model-visible ⟺ logged, and reported evaluations remain a named, separate write path.

## Stage B — supported entry and interruption semantics

- **Owner import/activate/supersede (F-03; A-09)**: owner-only `/project import <plan-path>`, `/project activate <version>`, and `/project supersede` call the same stage-A operations — import parses, validates, and writes DRAFT only; activate presents diagnostics, baseline, and target version. Every entry names its ledger actor through the session-agent→owner mapping, which this stage defines.
- **Report commit semantics (F-04; A-10)**: executors finish outside the transaction, then one operation commits all evaluations, the work status, and lease completion in a single `BEGIN IMMEDIATE`; where incremental commits remain, an operation id and explicit stages make retries idempotent. Fault injection covers every write point; the transaction-scoped core variants land first because the existing seams each own a transaction.
- **Typed service ownership (F-05)**: the stage-A and stage-B operations become `ProjectLedger` service methods over the SQLite provider; read-only functions without a second consumer or transaction-ownership need stay library APIs.

## Stage C — evidence and maintenance convergence

- **Registry-enforced event organization (F-08; A-13)**: registering a required event type requires a decoder and a fold policy at registration; `readProjectReplay` becomes the sole projection-parity owner, and the doctor converts drift plus adds only the runtime health checks replay cannot express.
- **Evidence discipline (F-07; A-11, A-12)**: deterministic 4K mounts the shipped mini-profile tools or reports only as payload-budget evidence; heuristic estimates and provider-reported usage stay separately labeled; live-model comparisons run on non-ledger repository tasks with success rates, tokens, retries, and human intervention recorded.
- **Current-state documentation**: READMEs and package descriptions state current behavior — the project-ledger limitation bullet, the SQLite migration text, and the package descriptions stop describing v1.6a-era facts.

## What v1.7 deliberately excludes

- **Phase D scheduling constraints (F-06; A-14)**: assignment-authorized claims, handoff authority transfer, PATH-overlap enforcement, and conflict-as-blocker stay case-driven by two independent Agent sessions; the recorded v1.6d domains keep their record-only semantics.
- **v1.6c (Function Contract)**: research-gated, untouched.
- **Versioned plan source documents and content-addressed artifacts**: source hash, path, and Git history remain the evidence set unless an audit must reconstruct old input independently of it.
- **A separate durable-receipt entity**: existing evaluations and events carry the facts; a new entity waits for a demonstrated cross-session audit need.

## Verification modes and entry gate

- **Keyless increments** run focused unit suites, typecheck, documentation gates, and owner-seam bookkeeping (plan import, gate decision, backfill) over the built library. **Keyed runs** own lane claim/report through the shipped tools and the live-4K rerun; a stage claims its exit conditions from those runs.
- **Entry gate**: `dr:mini-dsh:v1.7-entry` opens through the decisions domain's shipped seams, following `dr:mini-dsh:v1.6b-entry` and `dr:mini-dsh:v1.6d-entry`; the options are `enter-v1.7-stage-a` (recommended), `enter-v1.7-stages-a-and-b`, and `hold-until-keyed-run`. The owner's go on this plan resolves the gate to `enter-v1.7-stage-a`; stage B and stage C each wait for their own gate.
