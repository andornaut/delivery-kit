#!/usr/bin/env bash
# Thin wrapper: native verification is scripts/check.ts.
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/check.ts" "$@"
