#!/usr/bin/env bash
# Contract harness in isolated containers. Every container runs as 19001:19001 with HOME=/tmp;
# every host mount is read-only. The npm cache and all scratch stay in container paths. The 1.0 bundle is built inside the container from the
# read-only checkout. Usage: run.sh [--lock] [vitest args]
#   --lock  regenerate tests/contract/package-lock.json (network); the file leaves by stdout.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HARNESS=$ROOT/tests/contract
IMAGE=node:24.21.0
IDS=19001:19001

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

# The checkout is group-readable only (umask 007); the supplementary group grants read access.
# No host path is writable: /tmp is the container's own layer, and the npm cache moves from the
# install container to the check container with `docker cp`.
options=(--cpus 4 --user "$IDS" --group-add "$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npmcache
  --mount "type=bind,src=$ROOT,dst=/source,readonly")
containers=()
cleanup() { (( ${#containers[@]} )) && docker rm -f "${containers[@]}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [[ ${1:-} == --lock ]]; then
  require_load
  lock=$(docker run --rm "${options[@]}" "$IMAGE" sh -ec \
    'cp -r /source/tests/contract /tmp/h; cd /tmp/h; rm -rf node_modules; npm install --package-lock-only --ignore-scripts --no-audit --no-fund >&2; cat package-lock.json')
  printf '%s\n' "$lock" >"$HARNESS/package-lock.json"
  exit 0
fi

before=$(fingerprint)
require_load
echo 'contract: populating the npm cache (network)'
install=$(docker create "${options[@]}" "$IMAGE" sh -ec '
  mkdir -p /tmp/root /tmp/h
  cp /source/package.json /source/package-lock.json /tmp/root/
  cp /source/tests/contract/package.json /source/tests/contract/package-lock.json /tmp/h/
  cd /tmp/root && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund >/dev/null
  cd /tmp/h && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund >/dev/null
')
containers+=("$install")
docker start -a "$install"

require_load
echo 'contract: build, type check and cases offline'
check=$(docker create "${options[@]}" --network none -e "DK_VITEST_ARGS=$*" "$IMAGE" bash -ec '
  mkdir /tmp/check
  tar -C /source --exclude=./.git --exclude=./.claude --exclude=./node_modules --exclude=./dist \
    --exclude=./tests/contract/node_modules -cf - . | tar -C /tmp/check -xf -
  cd /tmp/check
  npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
  npm run build >/dev/null
  cd tests/contract
  npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
  npx tsc
  status=0
  echo "contract: DK_IMPL=bash"
  DK_IMPL=bash npx vitest run --maxWorkers=4 $DK_VITEST_ARGS || status=1
  echo "contract: DK_IMPL=node"
  DK_IMPL=node npx vitest run --maxWorkers=4 $DK_VITEST_ARGS || status=1
  exit "$status"
')
containers+=("$check")
docker cp "$install:/tmp/npmcache" - | docker cp -a - "$check:/tmp/"
result=0
docker start -a "$check" || result=$?

after=$(fingerprint)
[[ $before == "$after" ]] || { echo 'contract: source changed during checks; discard results' >&2; exit 1; }
if [[ -n $(find "$ROOT" -xdev \( -uid 0 -o -uid 19001 \) -print -quit) ]]; then
  echo 'contract: files owned by root or the container user found in the checkout' >&2
  exit 1
fi
exit "$result"
