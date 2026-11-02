#!/usr/bin/env bash
# Deploy already gated assets. A failed deployment is retried only at a later departure.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
pending=$BUS_DIR/deploy-pending
report_deploy_exit() {
  local result=$? failed_sha=${sha:-}
  if (( result )) && [[ $failed_sha =~ ^[0-9a-f]{40}$ ]]; then
    bus_event deploy_failure "$failed_sha" "Deployment blocked/failed for pushed $failed_sha; retained pending assets; inspect configuration, base and artifacts before next scheduled retry. CI tracked separately."
  fi
}
trap report_deploy_exit EXIT
finish_pending() {
  local fields sha work branch current log
  [ -s "$pending" ] || return 0
  mapfile -t fields <"$pending"
  sha=${fields[0]}; work=${fields[1]}; branch=${fields[2]}
  if [ "$DEPLOY_MODE" != wrangler ]; then
    echo "deployment pending for $sha; DEPLOY_MODE must be wrangler before retrying"
    return 1
  fi
  fetch_base || return 1
  current=$(git -C "$REPO" rev-parse "$BASE")
  if [ "$current" != "$sha" ]; then
    echo "deployment pending $sha differs from $BASE ($current); queue retained for operator review"
    return 1
  fi
  if [ ! -f "$work/.bus-built.sha" ] || [ "$(cat "$work/.bus-built.sha")" != "$sha" ] \
    || [ ! -d "$work/dist" ]; then
    echo "deployment assets missing or built for another commit: $sha"
    return 1
  fi
  mkdir -p "$BUS_DIR/deploy"
  log=$BUS_DIR/deploy/$sha.log
  bus_event deploy_retry "$sha" "Deployment pending/retrying exact pushed $sha using retained gated assets; CI tracked separately."
  echo "deploying gated assets for $sha; log $log"
  if (cd "$work" && node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.jsonc \
      --no-bundle --tag "${sha:0:8}" --message "Scheduled bus $sha") >>"$log" 2>&1; then
    printf '%s\n' "$sha" >"$BUS_DIR/last-deploy.sha"
    date +%s >"$BUS_DIR/last-deploy"
    mv "$pending" "$BUS_DIR/deploy/$sha.completed"
    bus_event deploy_success "$sha" "Deployment success for exact pushed $sha; CI completion tracked separately."
    echo "deployed $sha"
    return 0
  fi
  bus_event deploy_failure "$sha" "Deployment FAILED for pushed $sha; gated assets retained; retry at next scheduled departure; CI tracked separately."
  echo "DEPLOY FAILED $sha; retained assets for the next scheduled departure; see $log"
  return 1
}
case "${1:-}" in
  --retry)
    [ -s "$pending" ] || exit 0
    mapfile -t saved <"$pending"
    sha=${saved[0]}
    if finish_pending; then
      # The retained worktree and batch branch belong only to this bus.
      git -C "$REPO" worktree remove --force "${saved[1]}"
      git -C "$REPO" branch -D "${saved[2]}" >/dev/null
    else
      exit 1
    fi
    ;;
  --stage)
    work=$2; branch=$3; sha=$4; needed=$5
    if [ "$needed" != 1 ]; then
      printf '%s\n' "$sha" >"$BUS_DIR/last-deploy-skipped.sha"
      bus_event deploy_skipped "$sha" "Deployment skipped for pushed $sha: documentation/art-source exclusions; CI pending until verified."
      echo "deploy skipped: entire batch matches documentation/art-source exclusions"
    elif [ "$DEPLOY_MODE" = none ]; then
      echo "deployment disabled for $sha"
    else
      printf '%s\n' "$sha" "$work" "$branch" >"$pending.tmp"
      mv "$pending.tmp" "$pending"
      finish_pending
    fi
    ;;
  *) echo 'usage: post-push.sh --retry | --stage worktree branch sha needed' >&2; exit 2 ;;
esac
