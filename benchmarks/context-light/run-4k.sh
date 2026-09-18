#!/bin/sh
# AC-4K-001 (docs/mini/v1.6a): the pinned 4K context-light real-use slice.
# Builds the worker, then runs one fresh agent through the Project Ledger
# under a hard 4096-token window. Keyless runs take the deterministic lane;
# DSH_4K_LIVE=1 with DEEPSEEK_API_KEY takes the live provider lane.
set -e
cd "$(dirname "$0")/../.."
pnpm exec tsdown --config benchmarks/context-light/tsdown.config.ts >/dev/null
exec node benchmarks/.dsh-build/context-light/run-4k.worker.js
