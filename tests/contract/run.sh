#!/usr/bin/env bash
# Thin wrapper: the contract harness runner is scripts/contract.ts ([--lock] [vitest args]).
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/../../scripts/contract.ts" "$@"
