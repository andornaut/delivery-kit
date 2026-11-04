#!/usr/bin/python3
"""Stdio MCP channel server: delivers each spooled monitor brief once to its own Claude session."""

import argparse
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import re
import select
import sys

from claude_adapter import DELIVERED, RECEIPT_KEYS, SPOOL, canonical_session
from unblock import persist

SERVER_NAME = 'delivery-kit-monitor'
LEGACY_PROTOCOLS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
RECEIPT = re.compile(r'(?:unblock|events/native)/[A-Za-z0-9_-]+\.json')


def channel_notification(entry):
    """The only Claude channel contract dependency: method, content and string-valued meta."""
    meta = {'request_id': entry['requestId'], 'kind': entry['kind']}
    meta.update({key: str(entry[key]) for key in ('slot', 'event_id') if key in entry})
    return {'jsonrpc': '2.0', 'method': 'notifications/claude/channel',
            'params': {'content': entry['text'], 'meta': meta}}


def initialize_result(params):
    requested = params.get('protocolVersion') if isinstance(params, dict) else None
    return {'protocolVersion': requested if requested in LEGACY_PROTOCOLS else LEGACY_PROTOCOLS[1],
            'capabilities': {'experimental': {'claude/channel': {}}},
            'serverInfo': {'name': SERVER_NAME, 'version': '1'},
            'instructions': ('Scheduled delivery-kit monitor briefs arrive as channel events. '
                             'Delivery is not handling; record handling separately.')}


def write_message(output, message):
    output.write(json.dumps(message, separators=(',', ':')) + '\n')
    output.flush()


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def receipt_for(state_dir, entry):
    """Receipts are named relative to STATE, the parent of STATE/unblock."""
    name = entry.get('receipt')
    if (entry.get('kind') not in RECEIPT_KEYS or not isinstance(name, str)
            or not RECEIPT.fullmatch(name)):
        raise ValueError('invalid receipt reference')
    return state_dir.parent / name


def matches(receipt, entry):
    return receipt.get(RECEIPT_KEYS[entry['kind']]) == entry['requestId'] and receipt.get('status') == 'sending'


def mark(receipt, status, **fields):
    receipt.update(status=status, **fields)
    if isinstance(receipt.get('attempts'), list) and receipt['attempts']:
        receipt['attempts'][-1].update(status=status)


def reconcile_claims(state_dir):
    """A claimed entry with a sending receipt was interrupted mid-delivery; never resend it."""
    for claimed in sorted((state_dir / SPOOL).glob('*.claimed')):
        try:
            entry = json.loads(claimed.read_text())
            path = receipt_for(state_dir, entry)
            receipt = json.loads(path.read_text())
            if matches(receipt, entry):
                mark(receipt, 'ambiguous', reason='channel delivery interrupted; do not resend')
                persist(path, receipt)
        except (OSError, ValueError, TypeError, KeyError):
            continue


def deliver_pending(output, state_dir, monitor):
    """Return False once the channel output is unusable."""
    spool = state_dir / SPOOL
    with (state_dir / 'unblock.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        reconcile_claims(state_dir)
        for pending in sorted(spool.glob('*.json')):
            try:
                entry = json.loads(pending.read_text())
                if (entry.get('recipient') != monitor or pending.stem != entry.get('requestId')
                        or not isinstance(entry.get('text'), str)):
                    continue
                path = receipt_for(state_dir, entry)
                receipt = json.loads(path.read_text())
                if not matches(receipt, entry):
                    continue
                message = channel_notification(entry)
                claimed = pending.with_suffix('.claimed')
                pending.replace(claimed)
            except (OSError, ValueError, TypeError, KeyError):
                continue
            try:
                write_message(output, message)
            except (OSError, ValueError):
                mark(receipt, 'ambiguous', reason='channel write failed; do not resend')
                persist(path, receipt)
                return False
            accepted_at = now()
            # The delivered copy is the monitor's acknowledgeable inventory (monitor-ack).
            (state_dir / DELIVERED).mkdir(mode=0o700, exist_ok=True)
            persist(state_dir / DELIVERED / claimed.with_suffix('.json').name,
                    dict(entry, acceptedAt=accepted_at))
            mark(receipt, 'accepted', acceptedAt=accepted_at)
            persist(path, receipt)
            claimed.unlink()
    return True


def handle(output, message):
    """Answer requests; return True once the client reports initialization."""
    method = message.get('method')
    if 'id' not in message:
        return method == 'notifications/initialized'
    if method == 'initialize':
        write_message(output, {'jsonrpc': '2.0', 'id': message['id'],
                               'result': initialize_result(message.get('params'))})
    elif method == 'ping':
        write_message(output, {'jsonrpc': '2.0', 'id': message['id'], 'result': {}})
    else:
        write_message(output, {'jsonrpc': '2.0', 'id': message['id'],
                               'error': {'code': -32601, 'message': 'method not found'}})
    return False


def serve(source, output, state_dirs, monitor, poll_seconds):
    initialized = False
    buffer = b''
    while True:
        readable, _, _ = select.select([source], [], [], poll_seconds)
        if readable:
            chunk = source.read1(65536) if hasattr(source, 'read1') else source.read(65536)
            if not chunk:
                return 0
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    try:
                        initialized = handle(output, message) or initialized
                    except (OSError, ValueError):
                        return 1
        if initialized and not all(deliver_pending(output, state_dir, monitor) for state_dir in state_dirs):
            return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, action='append', required=True,
                        help='a project STATE/unblock directory; repeat once per project')
    parser.add_argument('--monitor', type=canonical_session, required=True)
    parser.add_argument('--poll-seconds', type=float, default=5.0)
    args = parser.parse_args()
    if (any(not path.is_absolute() or not path.is_dir() for path in args.state_dir)
            or len({path.resolve() for path in args.state_dir}) != len(args.state_dir)):
        parser.error('each --state-dir must name a distinct existing absolute STATE/unblock directory')
    return serve(sys.stdin.buffer, sys.stdout, args.state_dir, args.monitor, args.poll_seconds)


if __name__ == '__main__':
    raise SystemExit(main())
