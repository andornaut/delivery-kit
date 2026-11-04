#!/usr/bin/env bash
# Verification in isolated containers running as uid 19001, which owns nothing on the host.
# The checkout is bound read-only and read through its group (--group-add), then copied into
# container scratch; the npm cache is a named volume. A first container populates that volume
# with network access; every check then runs with no network. Nothing is written to the host.
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

# The files a check sees: Git's tracked and untracked list, or a snapshot's files. Paths a
# worktree deletes are left out, so the container copy matches the fingerprinted tree.
source_list() {
  local path
  if [[ -e $root/.git ]]; then
    git -C "$root" ls-files --cached --others --exclude-standard --deduplicate -z
  else
    (cd -- "$root" && find . \( -path ./.claude -o -path ./node_modules -o -path ./dist \) -prune \
      -o \( -type f -o -type l \) -printf '%P\0')
  fi | while IFS= read -r -d '' path; do
    if [[ -e $root/$path || -L $root/$path ]]; then printf '%s\0' "$path"; fi
  done
}

# The list is outside the checkout and group-readable, and is bound read-only beside it.
list=$(mktemp)
source_list >"$list"
chmod 0640 "$list"

before=$(source_fingerprint "$root")
owners_before=$(host_owners)
finish() {
  local result=$? after
  trap - EXIT
  rm -f -- "$list"
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

groups=()
for gid in $(stat -c %g -- "$root" "$list" | sort -u); do groups+=(--group-add "$gid"); done
container=(
  docker run --rm --read-only --cpus 4
  --user 19001:19001 -e HOME=/tmp "${groups[@]}" -e npm_config_cache=/var/tmp/npm
  --mount "type=bind,src=$root,dst=/source,readonly"
  --mount "type=bind,src=$list,dst=/source.list,readonly"
  --mount "type=volume,src=$volume,dst=/var/tmp"
  --tmpfs /tmp:exec,mode=1777
  -w /tmp
)

require_load
echo 'delivery-kit: populating the npm cache volume in a container'
"${container[@]}" "$image" sh -ec '
  mkdir /tmp/fetch
  cp /source/package.json /source/package-lock.json /tmp/fetch/
  cd /tmp/fetch
  npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
'

require_load
echo 'delivery-kit: checking types, lint, build and tests offline'
"${container[@]}" --network none "$image" bash -ec '
  mkdir /tmp/check
  tar -C /source --null -T /source.list -cf - | tar -x -C /tmp/check
  cd /tmp/check
  npm ci --offline --ignore-scripts --no-audit --no-fund
  npm run check
  npm run lint
  npm run build
  npm test -- --maxWorkers=4
  for path in scripts/*.sh; do bash -n "$path"; done
'
