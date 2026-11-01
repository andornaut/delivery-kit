#!/usr/bin/env bash
# Execute one due native-scheduled slot; no resident scheduler is started here.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
export TZ=${BUS_TIMEZONE:-America/Toronto}
now=$(date +%s)
if (( $# == 0 )); then
  read -r minute second < <(date -d "@$now" '+%-M %-S')
  hour=$((now - 10#$minute * 60 - 10#$second))
  slot=0
  for departure in $DEPARTURES; do
    candidate=$((hour + 10#$departure * 60))
    if (( candidate > now )); then candidate=$((candidate - 3600)); fi
    if (( candidate > slot )); then slot=$candidate; fi
  done
elif (( $# == 2 )) && [ "$1" = --scheduled-at ] && [[ $2 =~ ^[0-9]{10}$ ]]; then
  slot=$2
else
  echo 'usage: scheduled-once.sh [--scheduled-at Unix-epoch]' >&2; exit 2
fi
read -r minute second < <(date -d "@$slot" '+%-M %-S')
allowed=0
for departure in $DEPARTURES; do
  if (( 10#$departure == 10#$minute )); then allowed=1; fi
done
if (( allowed == 0 || 10#$second != 0 || now < slot || now - slot > 300 )); then
  echo 'bus: no configured departure is due within the five-minute scheduling window' >&2; exit 2
fi
Q=$BUS_DIR/bus-queue
touch "$Q"
blocked_lock() {
  {
    flock 8
    if grep -q '[^[:space:]]' "$Q"; then
      bus_event blocked-lock "$slot" "Scheduled slot $slot blocked by $1; no new push/deployment from this invocation; retain queue for next scheduled slot after resolving overlapping scheduler."
    fi
  } 8>"$Q.lock"
}
exec 5>"$BUS_DIR/runner.lock"
flock -n 5 || { blocked_lock 'active resident/native runner'; exit 1; }
exec 7>"$BUS_DIR/loop.lock"
flock -n 7 || { blocked_lock 'active departure loop'; exit 1; }
mkdir -p "$BUS_DIR/native-slots"
receipt=$BUS_DIR/native-slots/$slot.status
# A claimed failed/interrupted slot is never retried automatically. The next slot is independent.
if [ -e "$receipt" ]; then exit 0; fi
printf 'started\n' >"$receipt.tmp"
mv "$receipt.tmp" "$receipt"
export BUS_SCHEDULED_AT=$slot
. "$S/departure.sh"
bus_dispatch
finish_slot() {
  local result=$?
  printf 'finished exit=%s\n' "$result" >"$receipt.tmp"
  mv "$receipt.tmp" "$receipt"
  bus_dispatch
}
trap finish_slot EXIT
# Empty native ticks do not fetch, report or run a batch.
{
  flock 8
  if ! grep -q '[^[:space:]]' "$Q" && [ ! -s "$BUS_DIR/deploy-pending" ]; then exit 0; fi
} 8>"$Q.lock"
depart
