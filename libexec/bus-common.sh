# Shared delivery mechanisms use caller-owned configuration and state.
CONF=${BUS_CONF:?BUS_CONF must name the project configuration}
if [ ! -r "$CONF" ]; then
  echo "bus: no config at $CONF" >&2
  exit 2
fi
. "$CONF"
for key in MAIN REMOTE GH_SLUG DEPARTURES DEPLOY_SKIP_RE NODE_IMAGE CONTAINER_PREFIX CPUS \
  MAX_WORKERS LOAD_LIMIT GATE_INSTALL GATE_STEPS DEPLOY_MODE; do
  if ! declare -p "$key" >/dev/null 2>&1; then
    echo "bus: $CONF does not set $key" >&2
    exit 2
  fi
done
REPO=${REPO:?configuration must set REPO}
BUS_DIR=${BUS_STATE_DIR:?BUS_STATE_DIR must name the project state directory}
export BUS_CONF BUS_STATE_DIR
CI_POLL_SECONDS=${CI_POLL_SECONDS:-60}
CI_TIMEOUT_SECONDS=${CI_TIMEOUT_SECONDS:-1800}
CI_REQUIRED_NAMES=${CI_REQUIRED_NAMES:-'AI attributions|Lint|Test'}
CODEX_PYTHON=${CODEX_PYTHON-/usr/bin/python3}
WORKER_PARENT_THREADS=${WORKER_PARENT_THREADS-}
worker_parents_ready() {
  local parent
  local parents=()
  local -A seen=()
  IFS=$' \t\n' read -r -d '' -a parents <<<"$WORKER_PARENT_THREADS" || :
  for parent in "${parents[@]}"; do
    if [[ ! $parent =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
      echo 'bus: WORKER_PARENT_THREADS must contain canonical UUIDs' >&2
      return 1
    fi
    if [[ -n ${seen[$parent]:-} ]]; then
      echo 'bus: WORKER_PARENT_THREADS must not contain duplicate UUIDs' >&2
      return 1
    fi
    seen[$parent]=1
  done
}
worker_parents_ready || exit 2
if declare -p MONITOR_ROUTE_FILE >/dev/null 2>&1; then
  MONITOR_MINUTES=${MONITOR_MINUTES-'20 50'}
fi
case "$DEPLOY_MODE" in wrangler|none) ;; *) echo "bus: invalid DEPLOY_MODE" >&2; exit 2 ;; esac
if [[ ! $CPUS =~ ^[1-4]$ || ! $MAX_WORKERS =~ ^[1-4]$ ]]; then
  echo "bus: CPUS and MAX_WORKERS must be integers from 1 through 4" >&2
  exit 2
fi
if [ -n "$REMOTE" ]; then BASE=$REMOTE/$MAIN; else BASE=refs/heads/$MAIN; fi
fetch_base() {
  if [ -n "$REMOTE" ]; then git -C "$REPO" fetch -q "$REMOTE"; fi
}
load_ok() {
  local load
  read -r load _ </proc/loadavg
  awk -v load_value="$load" -v limit_value="$LOAD_LIMIT" 'BEGIN { exit !(load_value < limit_value) }'
}
# These fingerprints cover tracked and untracked files reported by Git, never ignored stores.
fingerprint() {
  python3 - "$1" <<'PY'
import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1])
raw=subprocess.check_output(['git','-C',str(root),'status','--porcelain=v1','-z','--untracked-files=all'])
rows=raw.split(b'\0')
paths=[]; i=0
while i<len(rows):
 row=rows[i]; i+=1
 if not row: continue
 paths.append(row[3:].decode())
 if row[:1] in (b'R',b'C') or row[1:2] in (b'R',b'C'):
  paths.append(rows[i].decode()); i+=1
out=[]
for name in paths:
 p=root/name
 value=('link',str(p.readlink())) if p.is_symlink() else ('file',hashlib.sha256(p.read_bytes()).hexdigest()) if p.is_file() else ('missing',None)
 out.append((name,value))
print(hashlib.sha256(json.dumps([raw.decode(),out],sort_keys=True).encode()).hexdigest())
PY
}
# Build scope is the complete batch diff, not only its final commit.
deploy_needed() {
  local from=$1 to=$2
  [ -z "$DEPLOY_SKIP_RE" ] || git -C "$REPO" diff --name-only "$from" "$to" | grep -vE "$DEPLOY_SKIP_RE" >/dev/null
}
# CLEANUP (added 2026-10-30): remove the repair protocol after its consumed approval is archived.
# Approval is data, never shell input. A consumed marker rejects later copies of the file.
repair_approved() {
  local failed=$1 branch tip approved=()
  shift
  [ -s "$BUS_DIR/last-push.sha" ] && [ "$(cat "$BUS_DIR/last-push.sha")" = "$failed" ] || return 1
  [ -f "$BUS_DIR/ci/$failed.status" ] && [ "$(cat "$BUS_DIR/ci/$failed.status")" = failure ] || return 1
  [ "$#" = 1 ] || return 1
  [ ! -e "$BUS_DIR/ci-repair-approval.consumed" ] || return 1
  [ -f "$BUS_DIR/ci-repair-approval" ] && [ ! -L "$BUS_DIR/ci-repair-approval" ] || return 1
  mapfile -t approved <"$BUS_DIR/ci-repair-approval"
  [ "${#approved[@]}" = 3 ] || return 1
  [[ ${approved[0]} =~ ^[0-9a-f]{40}$ && ${approved[2]} =~ ^[0-9a-f]{40}$ ]] || return 1
  branch=${approved[1]}; tip=${approved[2]}
  [[ $branch == bus/* ]] && [ "$1" = "$branch" ] && [ "$failed" = "${approved[0]}" ] || return 1
  [ -n "$REMOTE" ] || return 1
  [ "$(git -C "$REPO" rev-parse "$BASE")" = "$failed" ] || return 1
  [ "$(git -C "$REPO" rev-parse "refs/heads/$branch")" = "$tip" ] || return 1
  [ "$(git -C "$REPO" merge-base "$BASE" "$tip")" = "$failed" ] || return 1
}
ci_not_red() {
  local sha state
  [ -s "$BUS_DIR/last-push.sha" ] || return 0
  sha=$(cat "$BUS_DIR/last-push.sha")
  state=$BUS_DIR/ci/$sha.status
  if [ -f "$state" ] && [ "$(cat "$state")" = failure ]; then
    if repair_approved "$sha" "$@"; then
      echo "bus: using one-shot repair approval for $sha"
      return 0
    fi
    echo "bus: previous push $sha has failing CI; queue retained"
    return 1
  fi
}
# An approved repair must contain the exact approved tree, with no additional batch work.
repair_tree_matches() {
  local work=$1 tip
  tip=$(sed -n '3p' "$BUS_DIR/ci-repair-approval") || return 1
  [ "$(git -C "$work" rev-parse 'HEAD^{tree}')" = "$(git -C "$REPO" rev-parse "$tip^{tree}")" ]
}
start_ci() {
  local sha=$1
  [ -n "$REMOTE" ] && [ -n "$GH_SLUG" ] || return 0
  mkdir -p "$BUS_DIR/ci"
  # Close inherited queue/merge/loop locks and pipes in the detached monitor.
  (
    exec 5>&- 6>&- 7>&- 8>&- 9>&-
    nohup bash "$S/ci-watch.sh" "$sha" </dev/null >>"$BUS_DIR/ci/$sha.log" 2>&1 &
  )
}
# Event writes are local and small; delivery never inherits bus locks or output pipes.
export REPORT_PROJECT=${REPORT_PROJECT:-${GH_SLUG:-Game}}
export REPORT_THREAD=${REPORT_THREAD:-}
export CODEX_PYTHON
if declare -p MONITOR_ROUTE_FILE >/dev/null 2>&1; then export MONITOR_ROUTE_FILE; fi
if declare -p CODEX_CONTROL_SOCKET >/dev/null 2>&1; then export CODEX_CONTROL_SOCKET; fi
bus_dispatch() {
  [ -n "$REPORT_THREAD" ] || return 0
  (
    exec 5>&- 6>&- 7>&- 8>&- 9>&-
    nohup python3 "$S/event.py" "$BUS_DIR" flush </dev/null >/dev/null 2>&1 &
  )
}
bus_event() {
  [ -n "$REPORT_THREAD" ] || return 0
  python3 "$S/event.py" "$BUS_DIR" emit "$@" || {
    echo 'bus: event persistence failed; operator review required' >&2; return 0;
  }
  bus_dispatch
}

codex_python_ready() {
  if [[ $CODEX_PYTHON != /* || ! -f $CODEX_PYTHON || ! -x $CODEX_PYTHON ]]; then
    echo 'bus: set CODEX_PYTHON to an absolute executable native Python interpreter with websocket-client' >&2
    return 1
  fi
}

bus_native_unblock() {
  local slot=$1 coordinator=$2 result peer parent status=0
  shift 2
  local peer_args=() parent_args=() parents=()
  for peer in "$@"; do peer_args+=(--peer "$peer"); done
  IFS=$' \t\n' read -r -d '' -a parents <<<"$WORKER_PARENT_THREADS" || :
  if (( ${#parents[@]} )); then
    if ! "$CODEX_PYTHON" - "$S" "${MONITOR_ROUTE_FILE:-}" "${parents[@]}" <<'PYPARENTS'
import json
from pathlib import Path
import sys
sys.path.insert(0, sys.argv[1])
from codex_adapter import resolve_route
try:
    route_file = sys.argv[2]
    route = json.loads(Path(route_file).read_text())
    scope = resolve_route(route_file, route['host_project_root'])
    if scope.get('status') != 'active':
        raise ValueError('inactive parent scope')
    allowed = {scope['coordinator'], *scope['peers']}
    if not set(sys.argv[3:]).issubset(allowed):
        raise ValueError('parent outside active route')
except (OSError, ValueError, TypeError, KeyError, AttributeError):
    raise SystemExit(1)
PYPARENTS
    then
      echo 'bus: monitor deferred: WORKER_PARENT_THREADS requires parents in the active monitor route' >&2
      return 0
    fi
  fi
  for parent in "${parents[@]}"; do
    parent_args+=(--parent "$parent")
  done
  result=$("$CODEX_PYTHON" "$S/unblock.py" --coordinator "$coordinator" \
    "${peer_args[@]}" "${parent_args[@]}" --slot "$slot" --control-socket "$CODEX_CONTROL_SOCKET" \
    --state-dir "$BUS_DIR/unblock" 2>/dev/null) || status=$?
  if [ -n "$result" ]; then
    printf 'bus: scheduled monitor %s: %s\n' "$slot" "$result"
  else
    printf 'bus: scheduled monitor %s unavailable (exit %s); no delivery claimed\n' "$slot" "$status" >&2
  fi
  return 0
}

# Compatibility triage remains release-driven only while no route is declared.
bus_unblock_tick() {
  declare -p MONITOR_ROUTE_FILE >/dev/null 2>&1 && return 0
  local slot peers_text
  local peers=()
  slot=$(bus_latest_scheduled_slot "$1")
  if [ -z "$REPORT_THREAD" ] || [ ! -r "$S/unblock.py" ]; then
    echo "bus: hourly unblock $slot unavailable: coordinator or helper missing" >&2
    return 0
  fi
  if [[ ${CODEX_CONTROL_SOCKET:-} != /* ]]; then
    echo "bus: hourly unblock $slot deferred: set CODEX_CONTROL_SOCKET to an absolute Codex control socket path" >&2
    return 0
  fi
  if ! declare -p CODEX_SHARED_ROLES >/dev/null 2>&1; then
    echo "bus: hourly unblock $slot deferred: set CODEX_SHARED_ROLES to allowed shared roles (or explicitly empty for a nonhost)" >&2
    return 0
  fi
  codex_python_ready || return 0
  if ! peers_text=$("$CODEX_PYTHON" "$S/codex_adapter.py" \
    "${SESSION_MAP_FILE:-}" "$REPORT_THREAD" "${SHARED_TARGETS_FILE:-}" \
    "$REPO" "${CODEX_SHARED_ROLES:-}"); then
    echo "bus: hourly unblock $slot unavailable: project session map invalid" >&2
    return 0
  fi
  mapfile -t peers <<<"$peers_text"
  bus_native_unblock "$slot" "$REPORT_THREAD" "${peers[@]}"

}

monitor_minutes_ready() {
  local pattern='^[[:space:]]*([0-9]|[0-5][0-9])([[:space:]]+([0-9]|[0-5][0-9]))*[[:space:]]*$'
  if [[ ! $MONITOR_MINUTES =~ $pattern ]]; then
    echo 'bus: MONITOR_MINUTES must be a nonempty literal list of wall-clock minutes from 0 through 59' >&2
    return 1
  fi
}

# The existing observer dispatches only a current monitor minute, never missed slots.
bus_monitor_due_ticks() {
  declare -p MONITOR_ROUTE_FILE >/dev/null 2>&1 || return 0
  local after=$1 now=$2 slot minute allowed=0 selected route_text coordinator
  local route=()
  monitor_minutes_ready || return 0
  slot=$((now - now % 60))
  (( slot > after && slot <= now )) || return 0
  minute=$(TZ="${BUS_TIMEZONE:-America/Toronto}" date -d "@$slot" '+%-M')
  for selected in $MONITOR_MINUTES; do
    if (( 10#$selected == 10#$minute )); then allowed=1; fi
  done
  (( allowed )) || return 0
  if [[ $MONITOR_ROUTE_FILE != /* ]]; then
    echo 'bus: monitor deferred: MONITOR_ROUTE_FILE must be an absolute route path' >&2
    return 0
  fi
  codex_python_ready || return 0
  if ! route_text=$("$CODEX_PYTHON" "$S/codex_adapter.py" --monitor-route "$MONITOR_ROUTE_FILE" "$REPO"); then
    echo 'bus: monitor deferred: MONITOR_ROUTE_FILE is unavailable or invalid; its owner must verify identities and ownership' >&2
    return 0
  fi
  if [ -z "$route_text" ]; then return 0; fi
  if [[ ${CODEX_CONTROL_SOCKET:-} != /* || ! -r $S/unblock.py ]]; then
    echo 'bus: monitor deferred: provide CODEX_CONTROL_SOCKET and the installed unblock helper' >&2
    return 0
  fi
  mapfile -t route <<<"$route_text"
  coordinator=${route[0]}
  bus_native_unblock "$slot" "$coordinator" "${route[@]:1}"
}

# Optional slot reports share the existing event outbox and its per-kind/key deduplication.
bus_report_scheduled_tick() {
  [ "${REPORT_SCHEDULED_TICKS:-0}" = 1 ] || return 0
  local slot=$1 detail=$2 stamp
  bus_unblock_tick "$slot"
  stamp=$(TZ="${BUS_TIMEZONE:-America/Toronto}" date -d "@$slot" '+%Y-%m-%d %H:%M %Z')
  bus_event scheduled-status "$slot" "$stamp scheduled slot: $detail"
}
bus_latest_scheduled_slot() {
  local now=$1 minute second hour candidate latest=0 departure
  read -r minute second < <(TZ="${BUS_TIMEZONE:-America/Toronto}" date -d "@$now" '+%-M %-S')
  hour=$((now - 10#$minute * 60 - 10#$second))
  for departure in $DEPARTURES; do
    candidate=$((hour + 10#$departure * 60))
    if (( candidate > now )); then candidate=$((candidate - 3600)); fi
    if (( candidate > latest )); then latest=$candidate; fi
  done
  echo "$latest"
}
# Called by the existing notification poll; this observes slots without initiating departures.
bus_report_due_ticks() {
  [ "${REPORT_SCHEDULED_TICKS:-0}" = 1 ] || return 0
  local after=$1 now=$2 cursor minute departure detail
  for ((cursor = after - after % 60 + 60; cursor <= now; cursor += 60)); do
    minute=$(TZ="${BUS_TIMEZONE:-America/Toronto}" date -d "@$cursor" '+%-M')
    for departure in $DEPARTURES; do
      if (( 10#$departure != 10#$minute )); then continue; fi
      if [ -s "$BUS_DIR/active-departure" ]; then
        detail='a departure is still checking or finishing; this observer starts no new push or deployment; attempt outcomes are reported separately.'
      elif grep -q '[^[:space:]]' "$BUS_DIR/bus-queue" 2>/dev/null; then
        detail='queued work is waiting for the scheduled loop; attempt outcomes are reported separately.'
      elif [ -s "$BUS_DIR/deploy-pending" ]; then
        detail='deployment is pending; its retry and outcome are reported separately.'
      else
        detail='queue empty; no departure is currently active.'
      fi
      bus_report_scheduled_tick "$cursor" "$detail"
    done
  done
}
