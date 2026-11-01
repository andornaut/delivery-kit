# Shared departure functions for resident and native one-shot scheduling.
until_next() {
  local now=$1 m s pos d first='' next=''
  read -r m s < <(date -d "@$now" '+%-M %-S')
  pos=$((m * 60 + s))
  for d in $(printf '%s\n' $DEPARTURES | sort -n); do
    d=$((10#$d * 60))
    [ -z "$first" ] && first=$d
    if ((d > pos)); then next=$d; break; fi
  done
  if [ -n "$next" ]; then echo $((next - pos)); else echo $((3600 - pos + first)); fi
}
blocked() {
  if (( ${#branches[@]} )); then
    local current truth
    current=$(cat "$BUS_DIR/last-push.sha" 2>/dev/null || true)
    truth='no successful new push recorded; no candidate deployment started'
    if [ "$current" != "$push_before" ]; then truth="pushed $current; deployment state tracked separately"; fi
    bus_event "blocked-$1" "$BUS_ATTEMPT" "$stamp blocked at $1: $2; $truth; operator fix or next scheduled retry required."
  fi
}
depart() {
  local branches=() stamp status push_before BUS_ATTEMPT BUS_REQUEST_RECORD=
  export BUS_REQUEST_RECORD
  local attempt_time
  attempt_time=${BUS_SCHEDULED_AT:-$(date +%s)}
  export BUS_ATTEMPT=${BUS_REQUEST_ID:+request-$BUS_REQUEST_ID}
  BUS_ATTEMPT=${BUS_ATTEMPT:-$attempt_time}
  if [ -z "${BUS_REQUEST_ID:-}" ]; then bus_unblock_tick "$BUS_ATTEMPT"; fi
  push_before=$(cat "$BUS_DIR/last-push.sha" 2>/dev/null || true)
  stamp=$(date -d "@$attempt_time" '+%Y-%m-%d %H:%M %Z')
  {
    flock 8
    if [ -n "${BUS_REQUEST_ID:-}" ]; then
      python3 "$S/request.py" "$BUS_DIR" "$REPO" validate "$BUS_REQUEST_ID" || return 1
    fi
    mapfile -t branches < <(grep -v '^\s*$' "$Q" | awk '!seen[$0]++')
    if [ -n "${BUS_REQUEST_ID:-}" ]; then
      bus_event attempt "$BUS_ATTEMPT" "$stamp user-authorized one-off request $BUS_REQUEST_ID: ${branches[*]}; push not started; deployment not started."
    else
      if (( ${#branches[@]} )); then
        bus_report_scheduled_tick "$(bus_latest_scheduled_slot "$BUS_ATTEMPT")" 'queued work is being checked; attempt and outcome reports follow separately.'
        bus_event attempt "$BUS_ATTEMPT" "$stamp scheduled attempt: ${branches[*]}; push not started; deployment not started."
      elif [ -s "$BUS_DIR/deploy-pending" ]; then
        bus_report_scheduled_tick "$(bus_latest_scheduled_slot "$BUS_ATTEMPT")" 'deployment retry is being checked; its outcome is reported separately.'
      else
        bus_report_scheduled_tick "$(bus_latest_scheduled_slot "$BUS_ATTEMPT")" 'queue empty; no new batch is queued.'
      fi
    fi
    fetch_base || { blocked fetch 'remote fetch failed'; return 1; }
    if ! ci_not_red "${branches[@]}"; then blocked CI 'previous CI red or repair approval invalid'; return 1; fi
  } 8>"$Q.lock"
  if [ -s "$BUS_DIR/deploy-pending" ]; then
    if ! ci_not_red >/dev/null; then
      echo 'bus: repair approval cannot retry a previous pending deployment'; blocked deployment 'repair cannot retry previous deployment'; return 1
    fi
    if ! bash "$S/post-push.sh" --retry; then blocked deployment 'previous deployment retry failed; retained assets'; return 1; fi
  fi
  if ! load_ok; then echo "$stamp bus: load at or above $LOAD_LIMIT; queue retained"; blocked load "load at or above $LOAD_LIMIT; queue retained"; return 1; fi
  {
    flock 8
    if [ -n "${BUS_REQUEST_ID:-}" ]; then
      python3 "$S/request.py" "$BUS_DIR" "$REPO" validate "$BUS_REQUEST_ID" || return 1
    fi
    mapfile -t branches < <(grep -v '^\s*$' "$Q" | awk '!seen[$0]++')
    fetch_base || { blocked fetch 'remote fetch failed'; return 1; }
    if ! ci_not_red "${branches[@]}"; then blocked CI 'previous CI red or repair approval invalid'; return 1; fi
    if [ -n "${BUS_REQUEST_ID:-}" ]; then
      python3 "$S/request.py" "$BUS_DIR" "$REPO" validate "$BUS_REQUEST_ID" || return 1
      # Pin integration inputs while validation and queue consumption share this lock.
      export BUS_REQUEST_RECORD="$BUS_DIR/requests/$BUS_REQUEST_ID.json"
    fi
    : >"$Q"
  } 8>"$Q.lock"
  if (( ${#branches[@]} == 0 )); then echo "$stamp bus: nothing waiting"; return 0; fi
  echo "$stamp bus departs with: ${branches[*]}"
  bash "$S/batch.sh" "${branches[@]}" 2>&1 | sed -u "s/^/$stamp  /"
  status=${PIPESTATUS[0]}
  if (( status )); then blocked batch 'integration or full gate failed; inspect retained batch and requeue a fix'; fi
  return "$status"
}
