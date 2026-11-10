#!/usr/bin/env bash
# Thin wrapper: native contracts are scripts/contract.ts ([--lock] [vitest args]).
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/../../scripts/contract.ts" "$@"
