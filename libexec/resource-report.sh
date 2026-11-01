#!/usr/bin/env bash
# Reporting only. Worktrees, branches and containers are never removed here.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
date '+%Y-%m-%d %H:%M:%S %Z'
uptime
docker ps --filter "label=game-bus=$GH_SLUG" --format '{{.Names}} {{.Status}}' 2>/dev/null || true
