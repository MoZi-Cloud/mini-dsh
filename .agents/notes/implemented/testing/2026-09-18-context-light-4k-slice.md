# Agent Note: Context-Light 4K Slice

Status: implemented

English | [中文](2026-09-18-context-light-4k-slice.zh.md)

## Problem

The v1.6a Ledger Core work packages (docs/mini/v1.6a) reach W12 (REAL-4K-001, preceded by PRE-002 whose only criterion is this benchmark's definition existing in-repo): the pinned 4K benchmark must exit successfully without context widening (§3, AC-4K-001), and the slice must genuinely use the Project Ledger to advance one task — a fresh agent that reads no plan document, only the database and its WorkPacket (BOOT-02). Nothing existed under `benchmarks/context-light/`, and no composition had ever driven the ledger's full work loop — todo, claim, packet, verifier execution, evaluation, completion — through a real agent runtime under a hard 4096-token window.

## Decision

`benchmarks/context-light/` owns the slice: `task-plan.yaml` (a strict-schema plan pinning one IMPLEMENTATION item whose COMMAND verifier is `node --test test/math.test.mjs`), a fixture `workspace/` (a stub module plus the pinned test that proves the stub was implemented), `run-4k.worker.ts` (the harness), its own tsdown config, and the `run-4k.sh` entry (AC-4K-001's verifier command). The worker boots the real production `AgentLoop` through the agent-loop testkit, registers five harness-private tools (`project_work_next`, `project_work_claim`, `write_file`, `run_command`, `project_work_update`) wired directly to the ledger seam functions, and drives one fresh agent to `whenIdle`. The verifier command runs as a real subprocess in a copied temp workspace; the evaluation, `VERIFYING`, and `DONE` moves go through the ledger's own writers; the worker asserts the final rows, the recorded evaluation, and the replayed projection before printing its report.

- **Two lanes, one loop (§3).** The deterministic lane (default, keyless) drives a scripted `LlmAdapter` whose declared context window is 4096; its every action — the work item id, the verifier command — is extracted from the packet text already in the conversation, so the packet is provably the only task carrier. Every request is measured as serialized bytes (four characters per token) plus a 512-token reserved output and must fit 4096 or the run fails; a seventh request fails the run instead of looping. The live lane (`DSH_4K_LIVE=1` with `DEEPSEEK_API_KEY`) sends the same loop to the real provider behind the same pinned window and takes the final verdict from provider-reported usage — the standard §3 names — with the heuristic kept as its pre-check. Keyless self-skip of the live lane follows the repository's real-API key policy; the deterministic lane always runs, so the verifier command itself exits 0 in keyless CI.
- **The persona is part of the budget.** The system prompt mounts with harness identity and runtime context disabled and a five-line persona, because a production persona alone would consume the window; what §3 bounds is the whole request.
- **The tools are benchmark-private.** The `/project` command and tool surface stays with the mini profile (W08's isolation design); the benchmarks tree explicitly allows a private integration adapter where no public export exposes the measured user path, and the ledger's public functions are exactly that path.
- **Activation is the owner seam.** The harness raw-activates the imported version, because v1.6a ships no activation writer; the README and this note record it.

Verification: `./benchmarks/context-light/run-4k.sh` exits 0 — six requests, maximum estimated request 2,308 tokens against the 4,096 budget (packet 2,301 bytes), all five tools once, verifier exit 0, item `DONE`, criterion `PASSING`, replayed projection `DONE`. Full typecheck (the worker lives in the host program), oxlint, `verify-application-entrypoints`, and the documentation gates stay green.

## Alternatives considered

**Wait for the `/project` tool surface and run the slice through `dsh --profile mini`.** Rejected for W12 — the command surface is the next version's seam, and §3's lane contract is provable now against the real loop; the benchmark's private tools call the same public ledger functions the profile will.

**Make the deterministic lane a unit test instead of a model-lane run.** Rejected — the lane's subject is the request assembly: system prompt, tool schemas, packet, and history under one budget. Driving the real AgentLoop is what makes the measurement the request the provider would see.

**Token-exact pre-check via a tokenizer.** Rejected — §3 itself demotes the heuristic to a pre-check and names provider usage as the final standard; four characters per token is conservative for this persona-plus-packet shape and avoids vendoring a tokenizer into the benchmarks tree.

**Pin the provider window by model choice.** Deferred — the hosted provider's server-side window is not a request parameter; the live lane pins the adapter-declared window, enforces the usage ceiling from the response, and the README records that a local llama.cpp endpoint (`DSH_4K_BASE_URL`) is the way to pin the server side exactly, as §3 mentions.

## Consequences

The 4K lane now has a pinned, reproducible gate that fails loudly on any payload growth: a WorkPacket format change, a persona edit, or a tool-schema expansion that breaks the budget fails the verifier before it reaches a provider. The live lane is the template for W13's acceptance — the same driver, one real development task — and the deterministic lane's packet-derived script doubles as the standing proof that BOOT-02's fresh agent needs nothing but the ledger.
