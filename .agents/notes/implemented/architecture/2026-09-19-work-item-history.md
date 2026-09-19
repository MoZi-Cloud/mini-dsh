# Agent Note: The Work-Item Evaluation History and /project history

Status: implemented

English | [中文](2026-09-19-work-item-history.zh.md)

## Problem

The review seam answers one item's state through its criteria's *latest* evaluations — by design, since a review explains the current verdict. But the §33 record also needs the attempts behind it: an item that failed twice before passing tells a different story than one that passed first try, and nothing read-only exposed that timeline. Reading it meant SQL against `acceptance_evaluations`, and a second per-item read would have re-derived the review's item resolution and identity assembly from scratch.

## Decision

A new `readWorkItemHistory` read seam (`work-item-history.ts`) lists one item's every recorded evaluation newest-first (the established `evaluated_at_ms DESC, rowid DESC` order), each attempt carrying its ledger evaluation id, criterion id and kind, verdict, evaluator, time, and parsed observed payload. The per-item plumbing the review owned inline was extracted into shared helpers the two seams both consume: `resolveWorkItemRow` (the id-or-stable-key match with its throwing ambiguity contract) and `workItemIdentityOf` (the branded identity fields, now the `WorkItemIdentity` interface both results extend), so resolution, ambiguity, and id-branding have one home each and the duplication gate stays at its standing baseline. `/project history <stable-key-or-id> [<project-id>]` renders the timeline with the observed exit code inline and the collapsed output-tail excerpt per attempt — the same evidence formatting the review and export use. The history only reads; no verdict it lists is a gate.

Verification: `work-item-history.spec.ts` covers the three-attempt timeline across two criteria with an overwritten FAIL (exact ids, kinds, observed payloads), the empty timeline, the unknown ref, and the ambiguous ref throw; the command suite covers the exact render (newest-first order, exit-code presence and absence, excerpt line, empty timeline, backlog item with `version none`) and the resolution failures — 246 tests across both packages, per-file 100% in one combined coverage run. The lane ran green on a temp ledger, on the persistent ledger (`PW-ITEM-HISTORY-001` DONE by `agent:mini-real-use-lane`, stored verifier `pnpm exec vitest run mini-profile` exit 0, doctor 0, `replayDrift` 0, 79 events), and idempotently on rerun; version 4 is fully complete. Doc-sync stayed green; the 4K slice stayed at max 2,444/4,096 estimated tokens.

## Alternatives considered

**Add an `attempts` array to `ReviewedCriterion`.** Rejected — every review consumer would then carry every past attempt on every read, though the review's contract is the latest verdict; history is a different question and gets its own seam.

**Render history from the digest's criteria rows.** Rejected — the digest deliberately keeps only the latest evaluation per criterion; the attempts live in `acceptance_evaluations` alone, and loading the whole project to answer one item inverts the read.

**Let the command query `acceptance_evaluations` directly.** Rejected — commands consume seams, never table SQL; a read the ledger owns belongs behind the ledger's read surface with the shared resolution contract.

## Consequences

The owner can now read why an item failed before it passed, attempt by attempt, without SQL — the last gap in the per-item evidence story (state via `/project item`, timeline via `/project history`, whole record via `/project digest`/`export`). Two seams sharing `resolveWorkItemRow` means a future per-item read inherits the resolution contract for free, and any change to ref semantics lands once. The §33 count reaches 24; version 4 is fully complete and the next real-use items require a version 5 batch.
