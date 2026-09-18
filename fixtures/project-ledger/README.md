# Project Ledger fixtures

English | [中文](README.zh.md)

## Summary

Two pinned v1.6a ledger databases (docs/mini/v1.6a §2): `v1.6a-empty.db` is a database at the current schema version with no data, for open, migration, and downgrade-reject probes; `v1.6a-populated.db` is the golden plan imported with fixed stamps and three work items driven to `DONE` through the real writers, leaving rows in every ledger table and a clean doctor pass (0 issues, 28 events). Regenerate both with `pnpm exec tsx scripts/gen-project-ledger-fixtures.ts` from the repository root after any schema or event-format change, and commit the rewritten files together with that change.
