#!/usr/bin/env bash
# Gate one scratch batch, push it, then deploy the same build through its configured route.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
W=$1
B=$2
shift 2
repair=${BUS_REPAIR_APPROVAL:-}
repair_check() {
  [ -n "$repair" ] || return 0
  [ -f "$BUS_DIR/ci-repair-approval" ] || return 1
  [ "$(cat "$BUS_DIR/ci-repair-approval")" = "$repair" ] || return 1
  [ -s "$BUS_DIR/last-push.sha" ] || return 1
  repair_approved "$(cat "$BUS_DIR/last-push.sha")" "$@" && repair_tree_matches "$W"
}
stage=preparation
report_failure() {
  local result=$?
  if (( result )); then
    bus_event "blocked-$stage" "${BUS_ATTEMPT:-$B}" "Batch blocked at $stage; command failed; inspect local bus log and retained batch, then fix/requeue. Push/deployment state is recorded by separate events."
  fi
}
trap report_failure EXIT
STAMP=$BUS_DIR/last-push
run() {
  local sha
  sha=$(git -C "$W" rev-parse HEAD)
  # The cache exists before mounting: Docker creates a missing bind source as root.
  mkdir -p "$BUS_DIR/npm-cache"
  docker run --rm --label "game-bus=$GH_SLUG" --cpus "$CPUS" -u "$(id -u):$(id -g)" -v "$W":/app -w /app --tmpfs /tmp:exec \
    -e HOME=/tmp -e "WORKERS_CI_COMMIT_SHA=$sha" \
    --mount "type=bind,src=$BUS_DIR/npm-cache,dst=/npmcache" -e npm_config_cache=/npmcache "$@"
}
gate_script() {
  local step name log index=0
  printf 'set -e\n'
  for step in "${GATE_STEPS[@]}"; do
    name=${step%%|*}
    index=$((index + 1))
    printf -v log '/gate-logs/%02d-%s.log' "$index" "${name//[^[:alnum:]_.-]/_}"
    printf 'printf "%%s " %q; { %s; } >%q 2>&1 || { echo FAIL; tail -30 %q; exit 1; }; echo ok\n' \
      "$name" "${step#*|}" "$log" "$log"
  done
}
stage=fetch
fetch_base
stage=rebase
if ! git -C "$W" rebase -q "$BASE"; then
  echo 'REBASE CONFLICT'
  git -C "$W" status --porcelain | grep -E '^(UU|AA|DU|UD)' || true
  exit 1
fi
base=$(git -C "$W" merge-base HEAD "$BASE")
sha=$(git -C "$W" rev-parse HEAD)
needed=0
if deploy_needed "$base" "$sha"; then needed=1; fi
if ! load_ok; then
  echo "host load is at or above $LOAD_LIMIT; batch retained for a later departure"
  exit 1
fi
ci_not_red "$@" || exit 1
if [ -z "$repair" ] && ! ci_not_red >/dev/null; then
  echo 'repair must be validated by the batch entry point'; exit 1
fi
repair_check "$@" || { echo 'repair approval does not match the batch'; exit 1; }
before=$(fingerprint "$W")
# A recorded tree without an artifact for this exact SHA cannot skip its build.
if [ -z "$repair" ] && [ "${SKIP_GATE:-0}" = 1 ] && [ -f "$W/.bus-built.sha" ] \
  && [ "$(cat "$W/.bus-built.sha")" = "$sha" ]; then
  echo 'gate skipped: exact commit and artifacts already gated'
else
  gate_batch=${B##*/}
  mkdir -p "$BUS_DIR/gate-logs/$gate_batch"
  gate_logs=$(mktemp -d "$BUS_DIR/gate-logs/$gate_batch/attempt.XXXXXXXX")
  printf '%s\n' "$sha" >"$gate_logs/commit.sha"
  echo "gate logs: $gate_logs"
  if [ -n "$GATE_INSTALL" ]; then
    stage=install
    run "$NODE_IMAGE" sh -c "$GATE_INSTALL" >"$gate_logs/install.log" 2>&1 || {
      echo "install FAIL; see $gate_logs/install.log"; exit 1;
    }
  fi
  stage=full-gate
  run --mount "type=bind,src=$gate_logs,dst=/gate-logs" \
    --network none "$NODE_IMAGE" sh -c "$(gate_script)"
  after=$(fingerprint "$W")
  if [ "$before" != "$after" ]; then
    echo 'gate discarded: Git status or reported-file fingerprints changed during checks'
    exit 1
  fi
  printf '%s\n' "$sha" >"$W/.bus-built.sha"
fi
stage=prepush-validation
fetch_base
if [ "$(git -C "$REPO" rev-parse "$BASE")" != "$base" ]; then
  echo 'main changed during the gate; retained batch for a later scheduled departure'
  exit 1
fi
ci_not_red "$@" || exit 1
if [ -z "$repair" ] && ! ci_not_red >/dev/null; then
  echo 'repair must be validated by the batch entry point'; exit 1
fi
repair_check "$@" || { echo 'repair approval changed during the gate'; exit 1; }
if [ "$(git -C "$W" rev-parse HEAD)" != "$sha" ]; then
  echo 'scratch HEAD changed during the gate'; exit 1
fi
stage=push
if [ -n "$REMOTE" ]; then
  git -C "$W" push -q "$REMOTE" "HEAD:$MAIN"
else
  target=$(git -C "$REPO" worktree list --porcelain \
    | awk -v ref="branch refs/heads/$MAIN" '/^worktree /{ p = substr($0, 10) } $0 == ref { print p }')
  if [ -n "$target" ]; then git -C "$target" merge -q --ff-only "$sha";
  else git -C "$REPO" update-ref "refs/heads/$MAIN" "$sha" "$base"; fi
fi
if [ -n "$repair" ]; then
  mv "$BUS_DIR/ci-repair-approval" "$BUS_DIR/ci-repair-approval.consumed"
fi
date +%s >"$STAMP"
printf '%s\n' "$sha" >"$STAMP.sha"
bus_event push "$sha" "$(date '+%Y-%m-%d %H:%M %Z') departed exact pushed SHA $sha: ${BUS_CANDIDATES:-scheduled batch}; full gate passed; CI pending; deployment pending."
start_ci "$sha"
git -C "$W" log --oneline -1
echo merged
# A failed deployment still leaves a successfully pushed commit. Its pending pointer keeps
# the build worktree until a later scheduled retry succeeds.
bash "$S/post-push.sh" --stage "$W" "$B" "$sha" "$needed" || true
