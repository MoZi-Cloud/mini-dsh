# Agent Note: The Owner Evidence Export and /project export

Status: implemented

English | [中文](2026-09-19-owner-evidence-export.zh.md)

## Problem

The digest gave the owner a terminal summary of the §33 record, but the record itself still lived in hand-written prose: quoting one item's verdict evidence meant `/project item` per item, and nothing produced a shareable artifact. The digest also carried only tallies — per-item counts by criterion status and latest result — so any consumer wanting the per-criterion facts behind the counts had to fall back to the per-item review seam, re-running its queries once per item.

## Decision

The digest read seam now carries per-criterion rows instead of tallies: `DigestItem.criteria` is a list of `ReviewedCriterion` (status, kind, description, required, latest evaluation with evaluator, time, and observed payload), assembled through a new shared `reviewedCriterionOf` mapper in the review seam so both reads keep one row-assembly path and one latest-evaluation tie-break; the tally records and their zero-initializers were deleted, and the terminal digest derives its `P/T passing` and `verdicts N R` counts from the rows with filters (no control-flow branches). `/project export [<project-id>]` renders the whole record as one archival markdown block over the digest alone — plans with versions, baselines, and supersede stamps; per-item sections with per-criterion verdict lines quoting the observed exit code and output-tail excerpt (reusing the review renderer's excerpt helpers); and the replay audit verdict, whose line assembly (`replayVerdictLines`) is shared with the digest renderer with the label stripped for the export's own section heading. The export only reads; nothing new mutates.

Verification: `project-digest.spec.ts` re-asserts the two-version, orphan-row, latest-only, and undecodable cases against the row shape; the command suite asserts the exact export text (required and optional criteria, exit-code and tail presence and absence, backlog item with `version none`), the drift and plural-drift export sections, and the decode-failure section — 242 tests across both packages, per-file 100% in one combined coverage run. The lane ran green on a temp ledger, on the persistent ledger (version 4 imported, version 3 superseded, `PW-EXPORT-VIEW-001` DONE by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run mini-profile` exit 0, doctor 0, `replayDrift` 0), and idempotently on rerun; `/project export` run against the persistent ledger renders 4 plan versions and 9 work items, the whole §33 record. Doc-sync stayed green (41/41); the 4K slice stayed at max 2,444/4,096 estimated tokens.

## Alternatives considered

**Compose the export in the command from per-item review calls.** Rejected — one `readWorkItemReview` per item re-runs the item, criteria, and evaluation queries N times and leaves a `review === undefined` branch that the same-database digest makes unreachable; carrying rows in the digest reads each family once and keeps the export a pure renderer.

**Keep the tallies and add rows beside them.** Rejected — two representations of the same criterion state on one item is an unexplained asymmetry; the counts derive from the rows, so the tallies were deleted rather than kept in parallel.

**Extend the event vocabulary so discovered (backlog) work gains a writer.** Out of scope — `work/created` payloads require a plan version that the replay validates, so a backlog writer needs a vocabulary change and a `PROJECT_EVENT_FORMAT_VERSION` bump that every fail-closed reader would refuse; that is its own decision, not a rider on an export view.

**Write the export to a file.** Rejected — the command surface is read-only reporting; where the block lands (§33 log, PR, review) is the owner's choice, and a paste is simpler than a path argument plus file-write semantics.

## Consequences

The §33 record is now mechanically reproducible: the export renders everything the hand-written log summarizes, from the same durable events, so the owner can diff prose against ledger at any time. The digest's public shape changed one increment after its introduction (tallies → rows) — pre-stable API evolution with every in-repo consumer updated in the same change, which is the cost of landing the aggregate before its second consumer existed. Future read seams that need criterion rows reuse `reviewedCriterionOf` rather than re-deriving assembly. The §33 count reaches 23; `PW-ITEM-HISTORY-001` (per-item evaluation history) stays claimable in version 4.
