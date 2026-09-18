# Context-light 4K real-use slice

English | [中文](README.zh.md)

## Summary

The pinned v1.6a 4K verifier (docs/mini/v1.6a §3, AC-4K-001): one fresh agent completes one real Project Ledger task with the provider and adapter context window both pinned to 4096 tokens and no widening. The agent sees the task only through the WorkPacket tool results — never the task plan — runs the packet's verifier command as a real subprocess in a copied fixture workspace, and reports through the ledger's acceptance seam. A keyless run takes the deterministic lane; `DSH_4K_LIVE=1` with `DEEPSEEK_API_KEY` takes the live provider lane.

## Table of Contents

- [Run](#run)
- [Measurements](#measurements)
- [Dev Note](#dev-note)

<a id="run"></a>

## Run

From the repository root:

```sh
./benchmarks/context-light/run-4k.sh
```

The script compiles the worker with the benchmark tsdown config, then runs it under plain Node against the built workspace libraries (`pnpm install && pnpm run build` first on a fresh tree). It exits 0 only when the ledger reaches `DONE` with a passing recorded evaluation, the verifier command exited 0, the replayed projection agrees, and every model request fit the pinned window. This is a functional lane gate, not a timed benchmark; it is not part of `test:bench`.

<a id="measurements"></a>

## Measurements

The lane contract (§3): adapter-declared and provider context window are both 4096, and each request must satisfy estimated request tokens plus a 512-token reserved output at or under 4096 — four characters per token as the conservative pre-check. The deterministic lane enforces the pre-check as its verdict through a scripted adapter whose every action is extracted from the packet already in the conversation, proving the packet alone carries the task; six model requests are the fixed flow, and a seventh fails the run. The live lane (`DSH_4K_LIVE=1`, `DEEPSEEK_API_KEY`, optional `DSH_4K_BASE_URL`/`DSH_4K_MODEL`) sends the same loop to the real provider and takes the final verdict from reported usage, per §3; its provider-message mapping is this lane's own private adapter, exercised only where a key exists. The task plan pins one `IMPLEMENTATION` item whose verifier command is `node --test test/math.test.mjs` inside the fixture workspace; the harness performs the owner's version activation directly, because activation has no ledger writer in v1.6a.

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

[The Agent Note](../../.agents/notes/implemented/testing/2026-09-18-context-light-4k-slice.md) owns the lane definition, the two-lane design and its keyless policy, the token conversion, and the known exclusions.

</details>
