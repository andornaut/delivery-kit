#!/usr/bin/env bash
# Build the npm release asset from an exact committed revision, offline, in a container running
# as uid 19001. The host writes the committed tree with git archive to a group-readable file
# outside the checkout, bound read-only (--group-add its group); the npm cache comes read-only
# from the volume check.sh populates, and the host user copies the artifacts out with docker cp.
# Output: delivery-kit-VERSION.tgz, SOURCE_COMMIT and SHA256SUMS.
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
scratch=$(mktemp -d)
archive=$scratch/source.tar
trap 'docker rm --force "$name" >/dev/null 2>&1 || true; rm -f -- "$archive"; rmdir -- "$scratch"' EXIT
git -C "$root" archive -o "$archive" "$revision"
chmod 0640 "$archive"
docker create --name "$name" --network none --cpus 4 --user 19001:19001 -e HOME=/tmp \
  --group-add "$(stat -c %g -- "$archive")" \
  --mount "type=bind,src=$archive,dst=/source.tar,readonly" \
  --mount "type=volume,src=$volume,dst=/var/tmp,readonly" \
  -e "SOURCE_DATE_EPOCH=$(git -C "$root" show -s --format=%ct "$revision")" \
  -e "SOURCE_REVISION=$revision" -e npm_config_cache=/tmp/npm-cache -w /tmp "$image" sh -ec '
    umask 022
    mkdir /tmp/package /tmp/out
    tar -x -f /source.tar -C /tmp/package
    cd /tmp/package
    printf "%s\n" "$SOURCE_REVISION" >SOURCE_COMMIT
    cp -R /var/tmp/npm /tmp/npm-cache
    npm ci --offline --ignore-scripts --no-audit --no-fund
    npm run build
    node scripts/release-package.mjs /tmp/release /tmp/out
  ' >/dev/null
docker start -a "$name"
mkdir -p -- "$2"
output=$(cd -- "$2" && pwd -P)
docker cp --quiet "$name:/tmp/out/." "$output/"
echo "delivery-kit: release artifacts in $output"
