#!/usr/bin/env bash
# Export a committed mechanism snapshot into a new caller-owned directory.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if (( $# != 2 )) || [[ -e $2 ]]; then
  echo 'usage: export.sh REVISION NEW_DIRECTORY' >&2
  exit 2
fi
revision=$(git -C "$ROOT" rev-parse "$1^{commit}")
mkdir -p "$2"
git -C "$ROOT" archive "$revision" | tar -x -C "$2"
printf '%s\n' "$revision" >"$2/SOURCE_COMMIT"
printf '%s\n' "$revision"
