"""Durable bus events and bounded delivery to the permanent project thread."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1]) / 'events'
root.mkdir(exist_ok=True)
project = os.environ.get('REPORT_PROJECT', 'Game')
thread = os.environ.get('REPORT_THREAD', '')
QUIET_KINDS = {'ci_pending', 'ci_running', 'deploy_pending', 'deploy_retry'}


def write(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as output:
        output.write(json.dumps(value, sort_keys=True) + '\n')
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def clean(value):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', value)[:1800]


def enqueue(kind, key, message):
    if kind in QUIET_KINDS: return
    identity_kind = 'blocked' if kind.startswith('blocked-') else kind
    identifier = hashlib.sha256((identity_kind + ':' + key).encode()).hexdigest()
    path = root / (identifier + '.json')
    if not path.exists():
        write(path, {'created': time.time_ns(), 'id': identifier, 'kind': kind,
                     'key': clean(key), 'message': clean(project + ' bus: ' + message), 'sent': False})


def delivery_message(event):
    suffix = ' [bus event ' + event['id'][:12] + ']'
    budget = 900 - len(suffix.encode('utf-8'))
    body = event['message'].encode('utf-8')[:budget].decode('utf-8', errors='ignore')
    return body + suffix


if sys.argv[2] == 'emit':
    kind, key, message = sys.argv[3:6]
    with (root / 'state.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        enqueue(kind, key, message)
        if re.fullmatch('[0-9a-f]{40}', key):
            path = root / (key + '.state')
            state = json.loads(path.read_text()) if path.exists() else {'ci': 'pending', 'deploy': 'pending'}
            if kind.startswith('ci_') and not (kind in QUIET_KINDS and state['ci'] == 'success'): state['ci'] = kind[3:]
            if kind.startswith('deploy_') and not (kind in QUIET_KINDS and state['deploy'] in ('success', 'skipped')): state['deploy'] = kind[7:]
            if kind == 'push': state['pushed'] = True
            write(path, state)
            if state.get('pushed') and state['ci'] == 'success' and state['deploy'] in ('success', 'skipped'):
                enqueue('complete', key, 'COMPLETE ' + key + ': full gate passed; CI success; deployment ' + state['deploy'] + '.')
elif sys.argv[2] == 'flush' and thread:
    with (root / 'dispatch.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: sys.exit(0)
        entries = sorted(((p, json.loads(p.read_text())) for p in root.glob('*.json')), key=lambda item: item[1]['created'])
        for path, event in entries:
            if event.get('suppressed') or event['sent']: continue
            if event['kind'] in QUIET_KINDS:
                event['suppressed'] = True
                write(path, event)
                continue
            try:
                result = subprocess.run(['codex', 'queue', '--thread', thread, '--message',
                                         delivery_message(event)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                if result.returncode: break
            except (OSError, subprocess.TimeoutExpired): break
            event['sent'] = True
            write(path, event)
