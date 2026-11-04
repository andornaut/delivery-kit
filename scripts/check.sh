#!/usr/bin/env bash
# Verification in isolated containers running as uid 19001, which owns nothing on the host.
# No host path is mounted: the source tree is streamed into container scratch as a tar, and
# the npm cache is a named volume. A first container populates that volume with network
# access; every check then runs with no network. Nothing is written back to the host.
# The 0.9.x Bash and Python suite runs alongside the TypeScript checks until its removal.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$root/scripts/runtime.sh"
image=$(node_check_image "$root")
volume=${DELIVERY_KIT_NPM_VOLUME:-delivery-kit-npm-check}

# Owner, group and mode of every host file under the checkout, so a container that changed
# any of them is detected even where the content fingerprint does not look.
host_owners() {
  find "$root" -path "$root/.git" -prune -o -printf '%U:%G %m %p\0' | sort -z | sha256sum
}

# The files a check sees: Git's tracked and untracked list, or a snapshot's files.
source_list() {
  if [[ -e $root/.git ]]; then
    git -C "$root" ls-files --cached --others --exclude-standard -z
  else
    (cd -- "$root" && find . \( -path ./.claude -o -path ./node_modules -o -path ./dist \) -prune \
      -o \( -type f -o -type l \) -printf '%P\0')
  fi
}

source_tar() {
  (cd -- "$root" && source_list | tar --null --ignore-failed-read -T - -cf - 2>/dev/null)
}

before=$(source_fingerprint "$root")
owners_before=$(host_owners)
finish() {
  local result=$? after
  trap - EXIT
  if ! after=$(source_fingerprint "$root"); then
    echo 'delivery-kit: cannot verify source fingerprints; discard the check result' >&2
    exit 1
  fi
  if [[ $before != "$after" || $owners_before != "$(host_owners)" ]]; then
    echo 'delivery-kit: source content or ownership changed during checks; discard the check result' >&2
    exit 1
  fi
  if [[ -n $(find "$root" \( -uid 19001 -o -gid 19001 \) -print -quit) ]]; then
    echo 'delivery-kit: a file owned by uid or gid 19001 exists in the checkout' >&2
    exit 1
  fi
  exit "$result"
}
trap finish EXIT

container=(
  docker run -i --rm --read-only --cpus 4
  --user 19001:19001 -e HOME=/tmp -e npm_config_cache=/var/tmp/npm
  --mount "type=volume,src=$volume,dst=/var/tmp"
  --tmpfs /tmp:exec,mode=1777
  -w /tmp
)

require_load
echo 'delivery-kit: populating the npm cache volume in a container'
(cd -- "$root" && tar -cf - package.json package-lock.json) | "${container[@]}" "$image" sh -ec '
  mkdir /tmp/fetch
  tar -x -C /tmp/fetch
  cd /tmp/fetch
  npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
'

require_load
echo 'delivery-kit: checking types, lint, build, tests and the 0.9.x suite offline'
source_tar | "${container[@]}" --network none "$image" bash -ec '
  mkdir /tmp/check
  tar -x -C /tmp/check
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
