#!/usr/bin/env bash
# Scheduled departures only. A nonempty queue is one gated push and deployment.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
if (( $# != 0 )); then echo 'bus: scheduled runner accepts no arguments; manual departures are disabled' >&2; exit 2; fi
exec 7>"$BUS_DIR/loop.lock"
flock -n 7 || { echo 'bus: another scheduled loop is already running'; exit 1; }
printf '%s\n' "$$" >"$BUS_DIR/codex-bus.pid"
export TZ=${BUS_TIMEZONE:-America/Toronto}
Q=$BUS_DIR/bus-queue
touch "$Q"
. "$S/departure.sh"
echo "bus: scheduled $DEPARTURES ($TZ), deployment route $DEPLOY_MODE"
: >"$BUS_DIR/active-departure"
trap ': >"$BUS_DIR/active-departure"' EXIT
while true; do
  sleep "$(until_next "$(date +%s)")"
  date +%s >"$BUS_DIR/active-departure"
  depart
  : >"$BUS_DIR/active-departure"
done
