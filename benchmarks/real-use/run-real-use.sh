#!/bin/sh
# The post-v1.6a real-use lane (docs/mini/real-use-log.md, §33): drives one
# real work item of the post-v1.6a increment plan through the SHIPPED
# mini-profile surface — the same plugins a `dsh --profile mini` session
# mounts — and completes it only when the item's stored verifier command
# passes as a real subprocess and the ledger reaches DONE with a clean
# doctor. A temporary ledger is used unless DSH_REAL_USE_LEDGER names a
# persistent file, so consecutive runs accumulate the real-use record.
set -e
cd "$(dirname "$0")/../.."
pnpm exec tsdown --config benchmarks/real-use/tsdown.config.ts >/dev/null
exec node benchmarks/.dsh-build/real-use/run-real-use.worker.js
