# Agent Note: Bounded Verifier Output Tails in Project-Work Reports

Status: implemented

English | [中文](2026-09-18-bounded-verifier-output-tails.zh.md)

## Problem

The per-criterion report grammar records each verdict with the observed exit code, but a replayed ledger still cannot say why a criterion passed or failed: the exit code alone loses the verifier's summary and failure lines, so explaining a historical verdict means re-running the stored command against a tree that may have moved on. The plan item `PW-OBSERVED-TAIL-001` names the gap. The ledger's observed payload (`acceptance_evaluations.observed_json`) already stores JSON beside the result with no limit of its own, so whatever bound exists has to live at the tool a model writes through — otherwise a caller-supplied string could grow the durable ledger without limit.

## Decision

Each report verdict entry gained an optional `outputTail` string, and the tool bounds it before any write: at most the final `REPORT_OUTPUT_TAIL_MAX_CHARS` (2048) characters are stored, keeping the end, where a verifier's summary and failure lines live. The bound is a fixed storage invariant of the durable ledger — the peer of the work packet's serialized ceiling — not a deployment-varying choice, so it is an exported constant rather than a Config field. The stored observed payload becomes `{exitCode?, outputTail?}`, written whenever either field is present. The real-use lane passes each executed verifier's captured output as the tail and asserts the bounded tail landed in `acceptance_evaluations.observed_json`; the 4K fixture clone mirrors the same grammar and bound, so the pinned slice measures a report that carries a tail.

Verification: mini-profile reaches 31 tests at per-file 100% coverage (the new one stores a short tail verbatim and truncates a 5,000-character tail to its final 2048); the real-use lane ran green on a temporary ledger and on the persistent profile ledger (item DONE by `agent:mini-real-use-lane`, doctor 0, replay DONE, observed payload `{exitCode: 0, outputTail: 1785 chars}`), then idempotently on rerun; the 4K lane stayed green at max 2,444/4,096 estimated tokens (+17 for the tail).

## Alternatives considered

**Store the full verifier output.** Rejected — unbounded model-supplied text in a durable row; the ledger exists to stay replayable and compact, and one report can carry several criteria.

**Bound in the lane, leave the tool unbounded.** Rejected — the tool is the write boundary every caller (a real session included) goes through; a lane-side bound would not protect the ledger from any other reporter.

**Make the bound a Config field.** Rejected — it is a storage invariant of the durable format, like `WORK_PACKET_MAX_SERIALIZED_BYTES`; the no-hardcoded-tunables rule covers deployment-varying choices, and no deployment benefits from a shorter or longer durable tail.

**Truncate from the head, keeping the first characters.** Rejected — verifiers write their summaries and failure counts at the end; the head is the least informative part of the output.

## Consequences

A replayed ledger explains each verdict without re-running the command, up to the bound; a verdict needing more context still names the criterion, whose verifier spec keeps the runnable command. Every future reporter — real sessions and later lanes — inherits the same bound for free. This closes the post-v1.6a increment backlog (`PW-PRESENTERS-001`, `PW-REPORT-VERDICTS-001`, `PW-OBSERVED-TAIL-001`, all completed through the ledger); the §33 record stands at 18 items, still pending the owner's value confirmation.
