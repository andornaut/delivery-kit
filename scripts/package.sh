#!/usr/bin/env bash
# Package only an explicitly pinned committed source tree.
set -euo pipefail
umask 022
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if (( $# != 2 )) || [[ ! $1 =~ ^[0-9a-f]{40}$ || $2 != /* || -e $2 ]]; then
  echo 'usage: package.sh EXACT_COMMIT_SHA NEW_ABSOLUTE_DIRECTORY' >&2
  exit 2
fi
revision=$(git -C "$ROOT" rev-parse --verify "$1^{commit}")
[[ $revision == "$1" ]] || exit 2
version=$(git -C "$ROOT" show "$revision:VERSION")
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo 'delivery-kit: VERSION must be a semantic version' >&2; exit 2;
}
epoch=$(git -C "$ROOT" show -s --format=%ct "$revision")
mkdir -p "$2"
output=$(cd "$2" && pwd)
scratch=$(mktemp -d)
trap 'rm -r -- "$scratch"' EXIT
name=delivery-kit-$version
mkdir "$scratch/$name"
git -C "$ROOT" archive "$revision" -- bin examples libexec scripts tests README.md VERSION LICENSE \
  | tar -x -C "$scratch/$name"
printf '%s\n' "$revision" >"$scratch/$name/SOURCE_COMMIT"
printf '%s\n' "$revision" >"$output/SOURCE_COMMIT"
tar --sort=name --format=gnu --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  -C "$scratch" -cf - "$name" | gzip -n >"$output/$name.tar.gz"
(cd "$output" && sha256sum "$name.tar.gz" SOURCE_COMMIT >SHA256SUMS)
printf '%s\n' "$output/$name.tar.gz"
