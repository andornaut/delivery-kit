#!/usr/bin/env bash
# Contract harness in isolated containers. Only the npm cache is a writable host mount; the
# checkout is read-only and copied into container tmpfs. Usage: run.sh [--lock] [vitest args]
#   --lock  regenerate tests/contract/package-lock.json (network; writes only that file)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HARNESS=$ROOT/tests/contract
IMAGE=node:24.21.0
CACHE=${DK_NPM_CACHE:-$ROOT/.claude/npm-cache}
uid=$(id -u)
gid=$(id -g)

require_load() {
  local load
  read -r load _ </proc/loadavg
  awk -v value="$load" 'BEGIN { exit !(value < 24) }' || { echo 'contract: load must be below 24' >&2; exit 1; }
}

fingerprint() {
  {
    git -C "$ROOT" status --porcelain=v1 -z
    git -C "$ROOT" ls-files -co --exclude-standard -z | sort -z | while IFS= read -r -d '' path; do
      if [[ -L $ROOT/$path ]]; then printf '%s link %s\n' "$path" "$(readlink "$ROOT/$path")"
      elif [[ -f $ROOT/$path ]]; then printf '%s %s %s\n' "$path" "$(stat -c %a "$ROOT/$path")" "$(sha256sum <"$ROOT/$path")"
      else printf '%s missing\n' "$path"; fi
    done
  } | sha256sum | cut -d' ' -f1
}

# Docker creates a missing bind source as root, so the cache exists before mounting.
mkdir -p "$CACHE"
container=(docker run --rm --read-only --cpus 4 -u "$uid:$gid" -e HOME=/tmp -e npm_config_cache=/npmcache
  --mount "type=bind,src=$ROOT,dst=/source,readonly"
  --mount "type=bind,src=$CACHE,dst=/npmcache"
  --tmpfs "/tmp:exec,uid=$uid,gid=$gid")

if [[ ${1:-} == --lock ]]; then
  require_load
  out=$(mktemp -d)
  "${container[@]}" --mount "type=bind,src=$out,dst=/out" "$IMAGE" sh -ec \
    'cp -a /source/tests/contract /tmp/h; cd /tmp/h; rm -rf node_modules; npm install --package-lock-only --ignore-scripts --no-audit --no-fund; cp package-lock.json /out/'
  cp "$out/package-lock.json" "$HARNESS/package-lock.json"
  exit 0
fi

before=$(fingerprint)
require_load
echo 'contract: populating the npm cache (network)'
"${container[@]}" "$IMAGE" sh -ec \
  'cp -a /source/tests/contract /tmp/h; cd /tmp/h; npm ci --ignore-scripts --no-audit --no-fund >/dev/null'

require_load
echo 'contract: type check and cases offline'
result=0
"${container[@]}" --network none -e "DK_VITEST_ARGS=$*" "$IMAGE" bash -ec '
  cp -a /source /tmp/check
  cd /tmp/check/tests/contract
  npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
  npx tsc
  echo "contract: DK_IMPL=bash"
  DK_IMPL=bash npx vitest run --maxWorkers=4 $DK_VITEST_ARGS
  echo "contract: DK_IMPL=node"
  DK_IMPL=node npx vitest run --maxWorkers=4 $DK_VITEST_ARGS
' || result=$?

after=$(fingerprint)
[[ $before == "$after" ]] || { echo 'contract: source changed during checks; discard results' >&2; exit 1; }
if [[ -n $(find "$ROOT" -xdev -uid 0 -print -quit) ]]; then
  echo 'contract: root-owned files found in the checkout' >&2
  exit 1
fi
exit "$result"
