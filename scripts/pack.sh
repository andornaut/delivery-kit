#!/usr/bin/env bash
# Thin wrapper: the offline release build is scripts/pack.ts.
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/pack.ts" "$@"
