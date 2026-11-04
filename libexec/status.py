#!/usr/bin/python3
"""Runner self-attested identity and a read-only singleton, idle and drain report.

Only the runner writes its identity, while it holds runner.lock. The report never reads
/proc: the singleton test is a non-blocking flock on the same lock files.
"""

from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sys
import time
import uuid

IDENTITY = 'runner.identity.json'


def lock_held(path):
    """True when another open file description holds the lock; never creates the file."""
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return False
    finally:
        os.close(descriptor)


def read_text(path):
    try:
        return Path(path).read_text().strip()
    except (OSError, UnicodeDecodeError):
        return None


def record(state_dir, tool_root, config, pid):
    """Called by the runner after it acquires runner.lock; binds the record to the lock file."""
    started = time.time_ns()
    token = f'{pid}:{started}:{uuid.uuid4()}'
    identity = {
        'pid': pid, 'started_ns': started,
        'started_at': datetime.fromtimestamp(started / 1e9, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'version': read_text(tool_root / 'VERSION'), 'source_commit': read_text(tool_root / 'SOURCE_COMMIT'),
        'config': str(config), 'state_dir': str(state_dir), 'tool_root': str(tool_root), 'token': token}
    temporary = state_dir / f'.{IDENTITY}.{uuid.uuid4()}.tmp'
    with temporary.open('w') as stream:
        json.dump(identity, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(state_dir / IDENTITY)
    # O_TRUNC keeps the lock inode; an older runner truncates this token on open.
    descriptor = os.open(state_dir / 'runner.lock', os.O_WRONLY | os.O_TRUNC)
    try:
        os.write(descriptor, (token + '\n').encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return identity


def report(state_dir, ci_enabled):
    running = lock_held(state_dir / 'runner.lock')
    try:
        identity = json.loads((state_dir / IDENTITY).read_text())
        if not isinstance(identity, dict):
            identity = None
    except (OSError, ValueError):
        identity = None
    if identity is None:
        identity_status = 'absent'
    elif not running:
        identity_status = 'stale'
    elif identity.get('token') and identity.get('token') == read_text(state_dir / 'runner.lock'):
        identity_status = 'current'
    else:
        identity_status = 'unattested'
    blockers = []
    if read_text(state_dir / 'active-departure'):
        blockers.append('active_departure')
    if read_text(state_dir / 'deploy-pending'):
        blockers.append('deploy_retry_pending')
    for status in sorted((state_dir / 'ci').glob('*.status')):
        if read_text(status) in ('pending', 'running'):
            blockers.append(f'ci_watch:{status.stem}')
    pushed = read_text(state_dir / 'last-push.sha')
    if ci_enabled and pushed and not (state_dir / 'ci' / f'{pushed}.status').exists():
        blockers.append(f'ci_watch_unrecorded:{pushed}')
    for request in sorted((state_dir / 'requests').glob('*.json')):
        try:
            value = json.loads(request.read_text()).get('state')
        except (OSError, ValueError, AttributeError):
            value = 'unreadable'
        if value in ('pending', 'started', 'unreadable'):
            blockers.append(f'request_{value}:{request.stem}')
    reporters = []
    if lock_held(state_dir / 'events' / 'dispatch.lock'):
        reporters.append('event_flush_running')
    unsent = 0
    for path in (state_dir / 'events').glob('*.json'):
        try:
            event = json.loads(path.read_text())
        except (OSError, ValueError):
            reporters.append(f'event_unreadable:{path.stem}')
            continue
        if isinstance(event, dict) and not event.get('sent') and not event.get('suppressed'):
            unsent += 1
    if unsent:
        reporters.append(f'unsent_events:{unsent}')
    queue = read_text(state_dir / 'bus-queue')
    return {'status': 'running' if running else 'not running', 'runner_lock_held': running,
            'loop_lock_held': lock_held(state_dir / 'loop.lock'),
            'identity_status': identity_status, 'identity': identity,
            'idle': not blockers, 'idle_blockers': blockers,
            'drained': not blockers and not reporters, 'reporter_blockers': reporters,
            'queued_branches': len(queue.split()) if queue else 0}


def main():
    command, state_dir, *rest = sys.argv[1:]
    state_dir = Path(state_dir)
    if command == 'record':
        tool_root, config, pid = rest
        record(state_dir, Path(tool_root).resolve(), config, int(pid))
        return 0
    if command == 'report':
        print(json.dumps(report(state_dir, rest == ['1']), sort_keys=True))
        return 0
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
