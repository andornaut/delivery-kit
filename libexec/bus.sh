#!/usr/bin/env bash
# Serialized scheduled and explicitly requested departures. A nonempty queue is one gated push and deployment.
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
python3 "$S/request.py" "$BUS_DIR" "$REPO" recover || exit 1
now=$(date +%s)
next=$((now + $(until_next "$now")))
while true; do
  now=$(date +%s)
  if (( now < next )); then
    request=$(python3 "$S/request.py" "$BUS_DIR" "$REPO" claim) || exit 1
    if [ -n "$request" ]; then
      date +%s >"$BUS_DIR/active-departure"
      BUS_REQUEST_ID=$request depart
      result=$?
      python3 "$S/request.py" "$BUS_DIR" "$REPO" finish "$request" "$result" || exit 1
      : >"$BUS_DIR/active-departure"
      now=$(date +%s)
      if (( now >= next )); then next=$((now + $(until_next "$now"))); fi
      continue
    fi
    delay=$((next - now))
    (( delay > 5 )) && delay=5
    sleep "$delay"
    continue
  fi
  # An active operation may cross deadlines. Never replay a missed scheduled slot.
  if (( now - next >= 60 )); then
    next=$((now + $(until_next "$now")))
    continue
  fi
  date +%s >"$BUS_DIR/active-departure"
  depart
  : >"$BUS_DIR/active-departure"
  now=$(date +%s)
  next=$((now + $(until_next "$now")))
done
