#!/usr/bin/env bash
# Verification uses a read-only source mount and a scratch copy with no live host services.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
read -r load _ </proc/loadavg
awk -v value="$load" 'BEGIN { exit !(value < 24) }' || { echo 'delivery: load must be below 24' >&2; exit 1; }
docker run --rm --network none --cpus 4 --read-only \
  --mount "type=bind,src=$ROOT,dst=/source,readonly" \
  --tmpfs /tmp:exec,mode=1777 \
  node:24.21.0 bash -c \
  'set -e; cp -a /source /tmp/check; cd /tmp/check; for path in bin/* libexec/*.sh scripts/*.sh; do bash -n "$path"; done; python3 tests/verify-scripts.py; python3 tests/verify-events.py; python3 tests/verify-events.py --delivery-only; python3 tests/verify-events.py --quiet-only; python3 tests/verify-once.py; python3 -m unittest discover -s tests -p "test_*.py"'
