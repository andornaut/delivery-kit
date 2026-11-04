#!/usr/bin/env bash
# Build the npm release asset from an exact committed revision, offline, in a container running
# as uid 19001 with no host mount. The committed tree is streamed in with git archive, the npm
# cache comes read-only from the volume check.sh populates, and the host user copies the
# artifacts out with docker cp. Output: delivery-kit-VERSION.tgz, SOURCE_COMMIT and SHA256SUMS.
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
volume=${DELIVERY_KIT_NPM_VOLUME:-delivery-kit-npm-check}
docker volume inspect "$volume" >/dev/null 2>&1 \
  || { echo "delivery-kit: run scripts/check.sh first to populate the $volume volume" >&2; exit 2; }
image=$(node_check_image "$root")
require_load
# Deterministic per revision, so a leftover container from an interrupted pack is replaced.
name=delivery-kit-pack-${revision:0:12}
docker rm --force "$name" >/dev/null 2>&1 || true
trap 'docker rm --force "$name" >/dev/null 2>&1 || true' EXIT
docker create -i --name "$name" --network none --cpus 4 --user 19001:19001 -e HOME=/tmp \
  --mount "type=volume,src=$volume,dst=/var/tmp,readonly" \
  -e "SOURCE_DATE_EPOCH=$(git -C "$root" show -s --format=%ct "$revision")" \
  -e "SOURCE_REVISION=$revision" -e npm_config_cache=/tmp/npm-cache -w /tmp "$image" sh -ec '
    umask 022
    mkdir /tmp/package /tmp/out
    tar -x -C /tmp/package
    cd /tmp/package
    printf "%s\n" "$SOURCE_REVISION" >SOURCE_COMMIT
    cp -R /var/tmp/npm /tmp/npm-cache
    npm ci --offline --ignore-scripts --no-audit --no-fund
    npm run build
    node scripts/release-package.mjs /tmp/release /tmp/out
  ' >/dev/null
git -C "$root" archive "$revision" | docker start -ai "$name"
mkdir -p -- "$2"
output=$(cd -- "$2" && pwd -P)
docker cp --quiet "$name:/tmp/out/." "$output/"
echo "delivery-kit: release artifacts in $output"
