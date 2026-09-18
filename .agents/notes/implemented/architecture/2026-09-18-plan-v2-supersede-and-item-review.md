# Agent Note: Plan Version 2, the Lane's Supersede Flow, and the /project Item Review

Status: implemented

English | [中文](2026-09-18-plan-v2-supersede-and-item-review.zh.md)

## Problem

The post-v1.6a increment plan's version 1 was fully completed through the ledger, so the §33 record could only grow from a new plan version — yet nothing had ever exercised version succession on a real ledger: `supersedePlanVersion` (§22) had unit coverage only, the real-use lane resolved "the" plan version with a single-row lookup that a second version would make ambiguous, and a version bump in the plan document would hit `version-conflict` against the imported version 1 unless the items themselves changed. Separately, the evidence the ledger now stores (per-criterion verdicts with exit codes and output tails) was readable only through SQL: the owner §33 asks to confirm the ledger's value could not read why any item passed or failed.

## Decision

Three pieces land together. First, the plan document bumps to version 2 with fresh item keys (`PW-ITEM-REVIEW-001`, `PW-REPLAY-VIEW-001`) — import treats stable keys as project-scoped, so re-declaring version-1 items would fail; a version is a new snapshot of new work, and the completed version-1 items stay as history. Second, the lane resolves versions by `(plan_id, version_no)`: it imports the document's current version, supersedes any other ACTIVE version of the plan through the §22 seam naming the successor, and activates — both owner moves as raw updates, exactly the activation precedent the pinned fixtures set; a temp ledger imports v2 alone, a persistent ledger with v1 ACTIVE records the supersede event and keeps every version-1 row byte-identical. Third, the owner-facing answer: a new `readWorkItemReview` ledger read seam resolves one work item by full id or stable key and joins each acceptance criterion with its latest evaluation (verdict, evaluator, timestamp, parsed observed payload; latest picked by evaluation time with append-only write order breaking same-millisecond ties, because the evaluation id's sequence number does not sort numerically across digit boundaries), and `/project item <stable-key-or-id> [<project-id>]` renders it — criterion statuses, latest evaluations with observed exit codes, and a whitespace-collapsed 160-character output-tail excerpt per criterion.

Verification: the ledger suite grows `work-item-review.spec.ts` (resolution by key and id, latest-wins within one millisecond, the ambiguous-ref rejection, backlog rows without a version) and mini-profile's command suite covers the review rendering, optional criteria, payloads without tails or exit codes, excerpt truncation, and the backlog `version none` line — both packages at per-file 100%; the lane ran green on a temporary ledger (v2 imported fresh) and on the persistent profile ledger (v1 superseded at event sequence 29, `PW-ITEM-REVIEW-001` DONE by `agent:mini-real-use-lane`, doctor 0, replay DONE), then idempotently on rerun; the 4K slice stayed green at max 2,444/4,096 estimated tokens.

## Alternatives considered

**Keep one version and append items to it.** Rejected — import pins a version to its source hash; editing the item list is a different document that must not silently rewrite a version the ledger already verified. The version is the unit of plan change, and §22 exists for exactly this succession.

**Let the lane pick "the ACTIVE version" instead of the document's version.** Rejected — the lane drives the plan document in the tree; resolving by `(plan_id, version_no)` keeps the run reproducible from the checkout and makes a stale document fail loud instead of driving a version the tree no longer names.

**Read evaluations directly in the command with SQL.** Rejected — the command surfaces consume read seams only (the `listPlans` precedent); re-owning `acceptance_evaluations` semantics in a consumer would duplicate the latest-per-criterion rule the seam exists to own.

**Show the whole evaluation history per criterion.** Rejected — the owner's question is "why is this item in its state"; the latest evaluation answers it, and history remains queryable through the ledger's own tables for the rarer audit that needs it.

## Consequences

Plan evolution now has a real-use record end to end: a later increment bumps the version, the lane supersedes and drives the first item, and the log's count keeps growing without manual ledger surgery. The §33 owner-confirmation conversation gains a readable surface — `/project item` shows the recorded evidence, not just statuses. Backlog rows (no plan version) remain without a writer; the review and the readiness seam both model them so whichever writer arrives first has a consistent read. `PW-REPLAY-VIEW-001` stays claimable in version 2 as the next increment.
