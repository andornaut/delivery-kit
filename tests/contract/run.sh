#!/usr/bin/env bash
# Contract harness in isolated containers, following scripts/check.sh: uid 19001, no host
# mount, the source streamed in as a tar and the npm cache in a named volume. A first container
# populates the cache with network access; the build and both implementations' cases then run
# with no network. Nothing is written back to the host.
# Usage: run.sh [--lock] [vitest args]
#   --lock  regenerate tests/contract/package-lock.json; the file leaves through stdout.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
. "$root/scripts/runtime.sh"
image=$(node_check_image "$root")
volume=${DELIVERY_KIT_NPM_VOLUME:-delivery-kit-npm-check}

container=(
  docker run -i --rm --read-only --cpus 4
  --user 19001:19001 -e HOME=/tmp -e npm_config_cache=/var/tmp/npm
  --mount "type=volume,src=$volume,dst=/var/tmp"
  --tmpfs /tmp:exec,mode=1777
  -w /tmp
)

if [[ ${1:-} == --lock ]]; then
  require_load
  lock=$( (cd -- "$root/tests/contract" && tar -cf - package.json) | "${container[@]}" "$image" sh -ec '
    mkdir /tmp/h && tar -x -C /tmp/h && cd /tmp/h
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund >&2
    cat package-lock.json
  ')
  printf '%s\n' "$lock" >"$root/tests/contract/package-lock.json"
  exit 0
fi

host_owners() {
  find "$root" -path "$root/.git" -prune -o -printf '%U:%G %m %p\0' | sort -z | sha256sum
}

source_tar() {
  (cd -- "$root" && git ls-files --cached --others --exclude-standard -z \
    | tar --null --ignore-failed-read -T - -cf - 2>/dev/null)
}

before=$(source_fingerprint "$root")
owners_before=$(host_owners)
finish() {
  local result=$? after
  trap - EXIT
  after=$(source_fingerprint "$root") || { echo 'contract: cannot verify source fingerprints' >&2; exit 1; }
  if [[ $before != "$after" || $owners_before != "$(host_owners)" ]]; then
    echo 'contract: source content or ownership changed during checks; discard results' >&2
    exit 1
  fi
  if [[ -n $(find "$root" \( -uid 19001 -o -gid 19001 -o -uid 0 \) -print -quit) ]]; then
    echo 'contract: a file owned by root or uid/gid 19001 exists in the checkout' >&2
    exit 1
  fi
  exit "$result"
}
trap finish EXIT

require_load
echo 'contract: populating the npm cache volume (network)'
(cd -- "$root" && tar -cf - package.json package-lock.json tests/contract/package.json tests/contract/package-lock.json) \
  | "${container[@]}" "$image" sh -ec '
  mkdir /tmp/fetch && tar -x -C /tmp/fetch
  cd /tmp/fetch && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund >/dev/null
  cd tests/contract && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund >/dev/null
'

require_load
echo 'contract: build, type check and cases offline'
source_tar | "${container[@]}" --network none -e "DK_VITEST_ARGS=$*" "$image" bash -ec '
  mkdir /tmp/check && tar -x -C /tmp/check
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
'
