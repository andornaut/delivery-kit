#!/usr/bin/env bash
# Verification in isolated containers running as the invoking user: the source is mounted
# read-only and copied to container scratch; only the project npm cache is writable. A first
# container populates that cache with network access; every check then runs with no network.
# The 0.9.x Bash and Python suite runs alongside the TypeScript checks until its removal.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$root/scripts/runtime.sh"
image=$(node_check_image "$root")
cache=${DELIVERY_KIT_NPM_CACHE:-$root/.claude/npm-cache}

before=$(source_fingerprint "$root")
finish() {
  local result=$? after
  trap - EXIT
  if ! after=$(source_fingerprint "$root"); then
    echo 'delivery-kit: cannot verify source fingerprints; discard the check result' >&2
    exit 1
  fi
  if [[ $before != "$after" ]]; then
    echo 'delivery-kit: source changed during checks; discard the check result' >&2
    exit 1
  fi
  exit "$result"
}
trap finish EXIT

# Docker creates a missing bind source as root, so the cache exists before it is mounted.
mkdir -p -- "$cache"
container=(
  docker run --rm --read-only --cpus 4
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/npmcache
  --mount "type=bind,src=$root,dst=/source,readonly"
  --mount "type=bind,src=$cache,dst=/npmcache"
  --tmpfs "/tmp:exec,uid=$(id -u),gid=$(id -g)"
  -w /tmp
)

require_load
echo 'delivery-kit: populating the project npm cache in a container'
"${container[@]}" "$image" sh -ec '
  mkdir /tmp/fetch
  cp /source/package.json /source/package-lock.json /tmp/fetch/
  cd /tmp/fetch
  npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
'

require_load
echo 'delivery-kit: checking types, lint, build, tests and the 0.9.x suite offline'
"${container[@]}" --network none "$image" bash -ec '
  mkdir /tmp/check
  tar -C /source --exclude=./.git --exclude=./.claude --exclude=./node_modules --exclude=./dist -cf - . \
    | tar -C /tmp/check -xf -
  cd /tmp/check
  npm ci --offline --ignore-scripts --no-audit --no-fund
  npm run check
  npm run lint
  npm run build
  npm test -- --maxWorkers=4
  for path in bin/* libexec/*.sh scripts/*.sh; do bash -n "$path"; done
  python3 tests/verify-scripts.py
  python3 tests/verify-events.py
  python3 tests/verify-events.py --delivery-only
  python3 tests/verify-events.py --quiet-only
  python3 tests/verify-once.py
  python3 -m unittest discover -s tests -p "test_*.py"
'
