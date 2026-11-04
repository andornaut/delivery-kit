#!/usr/bin/env bash
# Verification uses a read-only source mount and a scratch copy with no live host services.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
read -r load _ </proc/loadavg
awk -v value="$load" 'BEGIN { exit !(value < 24) }' || { echo 'delivery: load must be below 24' >&2; exit 1; }
fingerprint() {
  python3 - "$ROOT" <<'PYFINGERPRINT'
import hashlib
from pathlib import Path
import subprocess
import sys
root = Path(sys.argv[1])
if (root / '.git').exists():
    status = subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain=v1', '-z'])
    paths = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-co', '--exclude-standard', '-z'])
else:
    if not (root / 'SOURCE_COMMIT').is_file():
        raise SystemExit('delivery-kit: checks require a checkout or identified source snapshot')
    status = b'snapshot'
    paths = b'\0'.join(str(path.relative_to(root)).encode() for path in root.rglob('*')
                       if path.is_file() or path.is_symlink())
digest = hashlib.sha256(status)
for name in sorted(set(paths.split(b'\0')) - {b''}):
    path = root / name.decode()
    digest.update(name + b'\0')
    if path.is_symlink():
        digest.update(str(path.readlink()).encode())
    elif path.is_file():
        digest.update(path.read_bytes())
        digest.update(str(path.stat().st_mode).encode())
    else:
        digest.update(b'missing')
print(digest.hexdigest())
PYFINGERPRINT
}
before=$(fingerprint)
result=0
docker run --rm --network none --cpus 4 --read-only -u "$(id -u):$(id -g)" -e HOME=/tmp \
  --mount "type=bind,src=$ROOT,dst=/source,readonly" \
  --tmpfs /tmp:exec,mode=1777 \
  node:24.21.0 bash -c \
  'set -e; cp -a /source /tmp/check; cd /tmp/check; for path in bin/* libexec/*.sh scripts/*.sh; do bash -n "$path"; done; python3 tests/verify-scripts.py; python3 tests/verify-events.py; python3 tests/verify-events.py --delivery-only; python3 tests/verify-events.py --quiet-only; python3 tests/verify-once.py; python3 -m unittest discover -s tests -p "test_*.py"' || result=$?
after=$(fingerprint)
[[ $before == "$after" ]] || { echo 'delivery-kit: source changed during checks; discard results' >&2; exit 1; }
exit "$result"
