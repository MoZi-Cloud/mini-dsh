# Agent Note: Per-Criterion Verdicts in project_work_update Reports

Status: implemented

English | [中文](2026-09-18-per-criterion-report-verdicts.zh.md)

## Problem

`project_work_update`'s report action applied one caller verdict to every agent-observable acceptance criterion of the claimed item: an agent whose work passed one stored verifier and failed another had to report a single PASS or FAIL for both. The plan item `PW-REPORT-VERDICTS-001` (`docs/mini/v1.6a/fork-mini-DSH-post-v1.6a.plan.yaml`) recorded the gap; landing it through the §33 real-use lane also meant updating that lane and the 4K slice's fixture clone, the other two consumers of the report grammar.

## Decision

The report grammar carries one verdict per observable criterion: `criteria: [{criterionId, result PASS|FAIL, optional exitCode}]` replaces the top-level `result`/`exitCode` pair. The tool validates the whole list before any write — a foreign id, a non-observable (owner-gated) id, a duplicate, or a missing observable criterion fails loud, leaving the claim held and nothing recorded — then proves the lease live and evaluates each named criterion through `evaluateAcceptanceCriterion` with its own verdict and observed exit code. Any failing verdict moves the item to `FAILED`; otherwise `VERIFYING`, and `DONE` when no required criterion is pending. `evaluatedCriteria` echoes each criterion's own result. Consumers move with the grammar: the real-use lane reads `packet.verifierSpecs`, runs each observable criterion's stored command (a query-only verifier fails loud — observable, but not executable in that lane), reports one verdict per criterion, and its JSON line gained per-criterion `verifierResults`; the 4K slice's fixture clone and its scripted report call follow the same shape. A dual-observable-criterion fixture (`DUAL_PLAN_TEXT`, two TEST criteria beside an owner confirmation) covers mixed verdicts, the untouched owner gate, and every rejection path with a subsequent clean report proving the rejections wrote nothing.

## Alternatives considered

**Keep the blanket verdict and add per-criterion as a second shape.** Rejected — two grammars for one action hide which criteria a verdict covers, and the report concludes the claim (the lease is released), so ambiguity cannot be corrected by a later call.

**Allow partial coverage — name only some observable criteria.** Rejected — unmentioned criteria would silently keep their old statuses with no later report to update them under the same claim. Exactly-once coverage is the loud contract.

**Validate inside the evaluation loop.** Rejected — each evaluation is its own transaction, so a mid-loop rejection would leave earlier evaluations recorded; the full list validates before the first write.

## Consequences

An agent can report a suite where some verifiers pass and others fail without distorting the passing criteria's histories; the failing criteria keep FAILING projections and the item records FAILED (out of the agent todo view, whose statuses exclude it). The change is pre-stable-surface churn and every consumer moved in the same change: the mini-profile spec (30 tests, per-file 100% coverage), the real-use lane, and the 4K fixture. The §33 record gains the increment — `PW-REPORT-VERDICTS-001` completed through the shipped tools against the persistent profile ledger (17 items through the ledger), with the 4K slice green after the grammar change (6 requests, max 2,427/4,096 estimated tokens). `PW-OBSERVED-TAIL-001` — bounded verifier output tails in the observed payload — remains claimable for a later increment.
