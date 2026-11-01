"""Durable one-off receipts. Queue callers hold bus-queue.lock for validation."""
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

state, repo, action, *args = sys.argv[1:]
root = Path(state) / 'requests'
root.mkdir(exist_ok=True)
# Persist the requests directory entry before acknowledging any captured receipt.
parent_descriptor = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)


def write(path, record):
    # fsync the directory as well as the file before acknowledging the request.
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(record, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def snapshot():
    queue = Path(state) / 'bus-queue'
    lines = queue.read_text().splitlines() if queue.exists() else []
    branches = list(dict.fromkeys(line for line in lines if line.strip()))
    result = []
    for branch in branches:
        subprocess.run(['git', 'check-ref-format', 'refs/heads/' + branch], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tip = subprocess.check_output(['git', '-C', repo, 'rev-parse', '--verify',
                                       'refs/heads/' + branch + '^{commit}'], text=True).strip()
        result.append([branch, tip])
    return result


with ExitStack() as stack:
    if action == 'capture':
        queue_lock = stack.enter_context((Path(state) / 'bus-queue.lock').open('a'))
        fcntl.flock(queue_lock, fcntl.LOCK_EX)
    lock = stack.enter_context((root / 'requests.lock').open('a'))
    fcntl.flock(lock, fcntl.LOCK_EX)
    if action in ('capture', 'validate', 'finish'):
        identity = args[0]
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', identity):
            raise SystemExit('delivery-kit: request ID must be 1-64 ASCII letters, digits, underscores or hyphens')
        path = root / (identity + '.json')
    if action == 'capture':
        if path.exists():
            print(path.read_text(), end='')
        else:
            entries = snapshot()
            if not entries:
                raise SystemExit('delivery-kit: request requires a nonempty queue')
            record = {'id': identity, 'state': 'pending', 'entries': entries}
            write(path, record)
            print(json.dumps(record, sort_keys=True))
    elif action == 'claim':
        for path in sorted(root.glob('*.json')):
            record = json.loads(path.read_text())
            if record['state'] == 'pending':
                record['state'] = 'started'
                write(path, record)
                print(record['id'])
                break
    elif action == 'recover':
        for path in sorted(root.glob('*.json')):
            record = json.loads(path.read_text())
            if record['state'] == 'started':
                record['state'] = 'interrupted'
                write(path, record)
    elif action == 'validate':
        record = json.loads(path.read_text())
        try:
            matches = snapshot() == record['entries']
        except subprocess.CalledProcessError:
            matches = False
        if not matches:
            record['state'] = 'rejected'
            record['reason'] = 'queue or branch tips changed'
            write(path, record)
            raise SystemExit(1)
    elif action == 'finish':
        record = json.loads(path.read_text())
        if record['state'] == 'started':
            record.update(state='finished', departure_exit=int(args[1]),
                          completion='departure flow only; consult exact-commit CI and deployment state')
            write(path, record)
    else:
        raise SystemExit('delivery-kit: unknown request operation')
