#!/usr/bin/env bash
# Build the npm release asset from an exact committed revision, offline, as the invoking user.
# Output: delivery-kit-VERSION.tgz, SOURCE_COMMIT and SHA256SUMS in a new directory.
set -euo pipefail
umask 022
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$root/scripts/runtime.sh"
if (( $# != 2 )) || [[ ! $1 =~ ^[0-9a-f]{40}$ || $2 != /* || -e $2 ]]; then
  echo 'usage: pack.sh EXACT_COMMIT_SHA NEW_ABSOLUTE_DIRECTORY' >&2
  exit 2
fi
revision=$(git -C "$root" rev-parse --verify "$1^{commit}")
[[ $revision == "$1" ]] || exit 2
cache=${DELIVERY_KIT_NPM_CACHE:-$root/.claude/npm-cache}
[[ -d $cache ]] || { echo 'delivery-kit: run scripts/check.sh first to populate the npm cache' >&2; exit 2; }
image=$(node_check_image "$root")
require_load
mkdir -p -- "$2" "$root/.claude"
output=$(cd -- "$2" && pwd -P)
# CLEANUP (added 2026-11-03): retain release scratch until its artifacts are verified.
scratch=$(mktemp -d "$root/.claude/release.XXXXXXXX")
git -C "$root" archive "$revision" | tar -x -C "$scratch"
printf '%s\n' "$revision" >"$scratch/SOURCE_COMMIT"
docker run --rm --read-only --network none --cpus 4 -u "$(id -u):$(id -g)" -e HOME=/tmp \
  --mount "type=bind,src=$scratch,dst=/package" \
  --mount "type=bind,src=$output,dst=/out" \
  --mount "type=bind,src=$cache,dst=/npmcache,readonly" \
  --tmpfs "/tmp:exec,uid=$(id -u),gid=$(id -g)" \
  -e "SOURCE_DATE_EPOCH=$(git -C "$root" show -s --format=%ct "$revision")" \
  -e npm_config_cache=/tmp/npm-cache -w /package "$image" sh -ec '
    umask 022
    cp -a /npmcache /tmp/npm-cache
    npm ci --offline --ignore-scripts --no-audit --no-fund
    npm run build
    node scripts/release-package.mjs release /out
  '
echo "delivery-kit: release artifacts in $output"
