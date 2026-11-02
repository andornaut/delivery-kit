#!/usr/bin/env bash
# Combine queued branches in a private scratch worktree, then gate and push once.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
exec 9>"$BUS_DIR/merge.lock"
flock 9
# Serialize approval validation, gate and consumption for all scratch batches.
exec 6>"$BUS_DIR/ci-repair-approval.lock"
flock 6
fetch_base || exit 1
ci_not_red "$@" || exit 1
repair=0
if [ -s "$BUS_DIR/last-push.sha" ] && repair_approved "$(cat "$BUS_DIR/last-push.sha")" "$@"; then
  repair=1
  approval=$(cat "$BUS_DIR/ci-repair-approval")
fi
name=batch-$(date +%s)
W=$BUS_DIR/$name
git -C "$REPO" worktree add -q -b "$name" "$W" "$BASE" || exit 1
pinned_tip() {
  python3 - "$BUS_REQUEST_RECORD" "$1" <<'PYTIP'
import json
import sys
with open(sys.argv[1]) as stream:
    entries = dict(json.load(stream)['entries'])
print(entries[sys.argv[2]])
PYTIP
}
picked=()
for branch in "$@"; do
  subject=$branch
  if [ -n "${BUS_REQUEST_RECORD:-}" ]; then
    subject=$(pinned_tip "$branch") || exit 1
  fi
  if base=$(git -C "$REPO" merge-base "$subject" "$BASE" 2>&1); then
    :
  else
    resolution_status=$?
    failure=${base:-Git returned no diagnostic (no common ancestor)}
    echo "SKIPPED $branch (merge-base against $BASE failed, exit $resolution_status: $failure)"
    bus_event "resolution-$branch" "${BUS_ATTEMPT:-$name}" "History resolution failed for $branch: merge-base against $BASE, exit $resolution_status: $failure; branch skipped; no push yet; inspect history and requeue skipped branch."
    continue
  fi
  if git -C "$W" cherry-pick "$base..$subject" >/dev/null 2>&1; then
    picked+=("$branch")
  else
    files=$(git -C "$W" diff --name-only --diff-filter=U | tr '\n' ' ')
    git -C "$W" cherry-pick --abort
    echo "SKIPPED $branch (conflict: $files)"
    bus_event "conflict-$branch" "${BUS_ATTEMPT:-$name}" "Integration conflict in $branch; branch skipped; no push yet; fix and requeue skipped branch."
  fi
done
echo "picked: ${picked[*]:-none}"
export BUS_CANDIDATES="${picked[*]}"
if (( ${#picked[@]} == 0 )); then
  git -C "$REPO" worktree remove --force "$W"
  git -C "$REPO" branch -D "$name" >/dev/null
  exit 1
fi
# A batch is always gated at departure. No branch-side full gate is required.
if (( repair )); then
  BUS_REPAIR_APPROVAL=$approval bash "$S/merge.sh" "$W" "$name" "$@"
else
  bash "$S/merge.sh" "$W" "$name"
fi
status=$?
keep=0
if [ -s "$BUS_DIR/deploy-pending" ]; then
  mapfile -t pending <"$BUS_DIR/deploy-pending"
  [ "${pending[1]:-}" = "$W" ] && keep=1
fi
if (( keep == 0 )); then git -C "$REPO" worktree remove --force "$W"; fi
if (( status == 0 )); then
  if (( keep == 0 )); then git -C "$REPO" branch -D "$name" >/dev/null; fi
  for branch in "${picked[@]}"; do
    echo "landed $branch"
    if [[ $branch == bus/* ]]; then
      if [ -n "${BUS_REQUEST_RECORD:-}" ]; then
        tip=$(pinned_tip "$branch") || exit 1
        current=$(git -C "$REPO" rev-parse "refs/heads/$branch") || continue
        # Retain a branch advanced after queue capture, even after its pinned work lands.
        [ "$current" = "$tip" ] || continue
      fi
      git -C "$REPO" branch -D "$branch" >/dev/null
    fi
  done
  if (( keep != 0 )); then echo "kept deployment worktree $W"; fi
else
  echo "kept branch $name; inspect and requeue after fixing the failure"
fi
exit "$status"
