#!/usr/bin/env bash
# Thin wrapper: the isolated verification is scripts/check.ts.
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/check.ts" "$@"
