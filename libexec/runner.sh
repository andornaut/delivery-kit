#!/usr/bin/env bash
# One scheduled loop and its reporting-only resource sampler per game.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
exec 5>"$BUS_DIR/runner.lock"
flock -n 5 || { echo 'bus: a runner is already active'; exit 1; }
(
  exec 5>&-
  while true; do
    bash "$S/resource-report.sh" >>"$BUS_DIR/resources.log" 2>&1
    sleep 1800
  done
) &
reporter=$!
(
  exec 5>&- 6>&- 7>&- 8>&- 9>&-
  previous=$(date +%s)
  while true; do
    now=$(date +%s)
    bus_report_due_ticks "$previous" "$now"
    previous=$now
    bus_dispatch
    sleep 60
  done
) &
notifier=$!
bus_pid=
cleanup() {
  kill "$notifier" 2>/dev/null || true
  kill "$reporter" 2>/dev/null || true
  if [ -n "$bus_pid" ]; then kill "$bus_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash "$S/bus.sh" &
bus_pid=$!
wait "$bus_pid"
