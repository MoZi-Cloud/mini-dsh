# Agent Note: The Owner Evidence Digest and /project digest

Status: implemented

English | [中文](2026-09-19-owner-evidence-digest.zh.md)

## Problem

The §33 gate asks the owner to confirm the ledger's value from the recorded evidence, but that evidence was scattered across read seams that answer one slice at a time: `listPlans` for versions, `readWorkItemReview` for one item's criteria and latest evaluations, `readProjectReplay` for parity. Reading the whole record meant several per-item commands or SQL against the ledger — exactly the burden an owner-facing view should remove at the moment the v1.6b decision needs the full picture.

## Decision

A new `readProjectDigest` ledger read seam (`project-digest.ts`) aggregates the whole project in one read-only pass: every plan with each version's lifecycle status, pinned baseline head, and supersede stamp; every work item (stable-key order) with its criteria counts by projection status, its latest-evaluation counts by result, and its newest evaluation stamp; and the replay audit verdict embedded as the `ProjectReplayReport` itself rather than paraphrased, so the owner reads the same parity facts `/project replay` reports. Verdict counts derive from the per-criterion latest evaluation — the dedup the review seam owned inline was extracted into one shared `latestEvaluationPerCriterion` helper, so both seams keep the same newest-first, rowid-tie-broken selection and the duplication gate stays at its standing baseline. `/project digest [<project-id>]` renders it over the shared project resolution; the digest never mutates, never executes a verifier command, and never decides acceptance — tallies are facts, not gates.

Verification: `project-digest.spec.ts` covers the two-version project through the real writers (import, evaluate, supersede with pointer repoint), rows no writer produces (a versionless plan row, a backlog item) with the drift they cause carried honestly, latest-only verdict counting across two criteria with an overwritten FAIL, and the embedded undecodable timeline; the command suite covers the exact digest text, the versionless/drift/undecodable renderings, and resolution failures — both packages at per-file 100% (241 tests combined). The lane ran green on a temp ledger, on the persistent ledger (`PW-EVIDENCE-DIGEST-001` DONE by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run mini-profile` exit 0, doctor 0, `replayDrift` 0, 61 events), and idempotently on rerun; doc-sync stayed green (41/41) and the 4K slice stayed at max 2,444/4,096 estimated tokens.

## Alternatives considered

**Compose the digest in the command from the existing seams.** Rejected — the aggregation (criteria tallies, latest-verdict counts, plan grouping) is ledger reading, not rendering; burying it in the profile command leaves every other consumer to re-assemble the same facts and drift from the review seam's latest-selection semantics.

**Call `readWorkItemReview` per item inside the digest.** Rejected — one review per item re-runs the item, criteria, and evaluation queries N times and re-deduplicates per call; the digest reads each family once and shares the dedup helper instead.

**Paraphrase the replay verdict to a boolean.** Rejected — a `replayOk` flag drops the counts and the undecodable reason the owner needs; embedding the report keeps one home for parity facts.

**Widen `readWorkItemReview` to whole-project mode.** Rejected — the review answers one item by ref with a throwing ambiguity contract; the digest is a different query shape (project-scoped, tallied) that would bend the review's contract to serve it.

## Consequences

The owner reads the whole §33 record with one command, which the v1.6b value confirmation can cite directly; the digest is read-only, so the Owner domain (§11 executor identity, confirmations) stays untouched for v1.6b. The shared helper moves the latest-evaluation tie-break rule to one home: future read seams reuse it rather than re-derive selection order. Rows no writer produces (versionless plans, backlog items) render as facts and surface through the embedded audit, so the digest doubles as a first-pass integrity read for ledgers assembled by hand. The §33 count reaches 22; version 3 is fully complete and the next real-use items require a version 4 batch.
