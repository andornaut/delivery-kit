#!/usr/bin/python3
"""Claude monitor route (version 2) and slot-scoped brief spooling for a channel consumer."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid


DEFAULT_AGENTS_COMMAND = 'claude agents --json'
SPOOL = 'claude-spool'
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._ -]{0,63}')
RECEIPT_KEYS = {'monitor': 'requestId', 'event': 'clientUserMessageId'}


def pending_entries(spool, kind, recipient):
    """Spooled entries the consumer has not yet claimed; accepted entries are removed on delivery."""
    found = []
    for pending in sorted(spool.glob('*.json')):
        try:
            entry = json.loads(pending.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and entry.get('kind') == kind and entry.get('recipient') == recipient:
            found.append(pending)
    return found


def monitor_ready(environment, session_id):
    try:
        return monitor_availability(agents_listing(environment), session_id)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None, 'claude agents listing unavailable'


def canonical_session(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('canonical session UUID required')
    return value


def route_harness(route):
    """Select the resolver by declared schema; anything else is unsupported."""
    if isinstance(route, dict) and type(route.get('version')) is int:
        if route['version'] == 1 and route.get('harness') == 'codex':
            return 'codex'
        if route['version'] == 2 and route.get('harness') == 'claude':
            return 'claude'
    raise ValueError('unsupported monitor route schema')


def endpoint(value, *, monitor=False):
    if (not isinstance(value, dict) or set(value) != {'session_id', 'name', 'ownership'}
            or value['ownership'] not in ('active', 'held')
            or not isinstance(value['name'], str) or not NAME.fullmatch(value['name'])):
        raise ValueError('invalid route endpoint')
    if monitor and value['session_id'] is None:
        return value
    canonical_session(value['session_id'])
    return value


def resolve_route_v2(route_file, project_root):
    if not Path(route_file).is_absolute() or not Path(project_root).is_absolute():
        raise ValueError('absolute monitor route and project root paths required')
    route = json.loads(Path(route_file).read_text())
    if (route_harness(route) != 'claude'
            or set(route) != {'version', 'harness', 'state', 'host_project_root', 'monitor', 'targets'}
            or route['state'] not in ('active', 'held')
            or not isinstance(route['host_project_root'], str)
            or not Path(route['host_project_root']).is_absolute()
            or not isinstance(route['targets'], list)):
        raise ValueError('invalid monitor route schema')
    monitor = endpoint(route['monitor'], monitor=True)
    targets = {}
    for target in route['targets']:
        endpoint(target)
        previous = targets.get(target['session_id'])
        if previous is not None and previous != target:
            raise ValueError('conflicting target ownership or name')
        targets[target['session_id']] = target
    coordinator = monitor['session_id']
    if route['state'] == 'active':
        if coordinator is None or monitor['ownership'] != 'active':
            raise ValueError('active route requires an active monitor identity')
        if coordinator in targets:
            raise ValueError('active monitor identity must be distinct from every target')
    peers = [target for target in targets.values() if target['ownership'] == 'active']
    if route['state'] == 'active' and not peers:
        raise ValueError('active route requires active targets')
    if Path(route['host_project_root']).resolve() != Path(project_root).resolve():
        return {'status': 'nonhost'}
    if route['state'] == 'held':
        return {'status': 'held'}
    return {'status': 'active', 'coordinator': coordinator, 'monitor_name': monitor['name'],
            'peers': [target['session_id'] for target in peers],
            'targets': [{'session_id': target['session_id'], 'name': target['name']} for target in peers]}


def agents_listing(environment):
    command = shlex.split(environment.get('CLAUDE_AGENTS_COMMAND') or DEFAULT_AGENTS_COMMAND)
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=15, check=True)
    entries = json.loads(result.stdout)
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise ValueError('unexpected agents listing')
    return entries


def monitor_availability(entries, session_id):
    """Interactive sessions report status idle/busy; background sessions report state."""
    matches = [entry for entry in entries if entry.get('sessionId') == session_id]
    if not matches:
        return None, 'monitor session missing from claude agents listing'
    for entry in matches:
        if entry.get('state') == 'blocked':
            return None, 'monitor session blocked'
    for entry in matches:
        if entry.get('status') in ('idle', 'busy') and entry.get('state') is None:
            return entry['status'], None
    return None, 'monitor session state unknown'


def brief(slot, route, diagnostics):
    targets = '\n'.join(f"{target['name']}: {target['session_id']}" for target in route['targets'])
    return (
        f"Scheduled monitoring review, slot {slot}. Review recent activity of these active route "
        "targets and relay only confirmed unblockers through your own cross-session messaging. "
        "Preserve unanswered questions and independent work; silence is not a decision. Report only "
        "new or unresolved blockers. This is a triage reminder, not permission to interrupt turns, "
        "answer questions, restart work or duplicate deliveries. Channel acceptance is delivery only; "
        "record handling separately.\n" + targets
        + "\nCapability diagnostics (unavailable is never clearance): " + json.dumps(diagnostics)
    )


def run(environment, state_dir, route_file, project_root, slot, parents=()):
    # Imported here so route selection needs no Codex-side module.
    from unblock import decision_clear, persist
    route = resolve_route_v2(route_file, project_root)
    if route['status'] != 'active':
        return {'status': 'unchanged', 'reason': f"route {route['status']}; no monitor input"}
    coordinator = route['coordinator']
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / f'{coordinator}-{slot}.json'
    spool = state_dir / SPOOL
    request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'hourly-unblock:{coordinator}:{slot}'))
    with (state_dir / 'unblock.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'busy'}
        if path.exists():
            previous = json.loads(path.read_text())
            # The consumer holds this lock while claiming, so an absent spool entry is final.
            if previous.get('status') == 'sending' and not (spool / f"{previous.get('requestId')}.json").exists():
                previous.update(status='ambiguous', reason='previous send interrupted; do not resend')
                persist(path, previous)
            return {'status': 'deduplicated', 'previousStatus': previous.get('status'), 'reason': previous.get('reason')}
        state = {'coordinator': coordinator, 'slot': slot, 'requestId': request_id, 'harness': 'claude'}
        if any(parent not in {coordinator, *route['peers']} for parent in parents):
            state.update(status='deferred', reason='worker parents require membership in the active monitor route')
            persist(path, state)
            return state
        if not decision_clear(state_dir, coordinator):
            state.update(status='deferred', reason='recipient-bound user-decision clearance missing, invalid or pending')
            persist(path, state)
            return state
        # One unclaimed brief bounds the spool while the consumer is not running.
        if pending_entries(spool, 'monitor', coordinator):
            state.update(status='deferred', reason='channel consumer has not claimed an earlier monitor brief')
            persist(path, state)
            return state
        availability, reason = monitor_ready(environment, coordinator)
        if availability is None:
            state.update(status='deferred', reason=reason)
            persist(path, state)
            return state
        diagnostics = [{'kind': kind, 'status': 'unavailable', 'reason_code': 'claude_no_native_api'}
                       for kind in ('queue_inventory', 'question_history')]
        diagnostics += [{'kind': 'worker_health', 'parent': parent, 'status': 'unavailable',
                         'reason_code': 'claude_no_native_api'} for parent in parents]
        entry = {'kind': 'monitor', 'requestId': request_id, 'recipient': coordinator, 'slot': slot,
                 'receipt': f'{state_dir.name}/{path.name}', 'text': brief(slot, route, diagnostics)}
        # The receipt precedes the spool entry so an interruption between them is never resent.
        state.update(status='sending', method='claude-channel', monitor_session_status=availability,
                     spool=str(spool / f'{request_id}.json'), diagnostics=diagnostics)
        persist(path, state)
        spool.mkdir(mode=0o700, exist_ok=True)
        persist(spool / f'{request_id}.json', entry)
        return state


def spool_event(environment, state_dir, path, recipient, event, message):
    """event_native.deliver semantics with the channel spool as transport; True only once accepted."""
    from unblock import decision_clear, persist
    unblock = state_dir / 'unblock'
    spool = unblock / SPOOL
    request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"bus-event:{event['id']}:{recipient}"))
    state = {'event_id': event['id'], 'recipient': recipient,
             'clientUserMessageId': request_id, 'attempts': []}
    unblock.mkdir(parents=True, exist_ok=True)
    with (unblock / 'unblock.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        if path.exists():
            state = json.loads(path.read_text())
            if (state.get('event_id'), state.get('recipient'), state.get('clientUserMessageId')) != (
                    event['id'], recipient, request_id):
                return False
            if state['status'] == 'accepted':
                return True
            if state['status'] == 'sending':
                if (spool / f'{request_id}.json').exists():
                    return False
                state['attempts'][-1].update(status='ambiguous')
                state.update(status='ambiguous')
                persist(path, state)
                return False
            if state['status'] in ('ambiguous', 'rejected') or len(state['attempts']) >= 2:
                return False
        if not decision_clear(unblock, recipient) or monitor_ready(environment, recipient)[0] is None:
            state.update(status='deferred')
            persist(path, state)
            return False
        # The receipt precedes the spool entry so an interruption between them is never resent.
        state['attempts'].append({'method': 'claude-channel', 'status': 'sending'})
        state.update(status='sending')
        persist(path, state)
        spool.mkdir(mode=0o700, exist_ok=True)
        persist(spool / f'{request_id}.json', {
            'kind': 'event', 'requestId': request_id, 'recipient': recipient, 'event_id': event['id'],
            'receipt': f'{path.parent.parent.name}/{path.parent.name}/{path.name}', 'text': message})
        return False


def event_main(arguments):
    from event_native import monitor_recipient
    state_dir, event_path, recipient, message = arguments
    state_dir = Path(state_dir)
    event = json.loads(Path(event_path).read_text())
    if monitor_recipient(os.environ, recipient) != 'claude':
        return 1
    receipts = state_dir / 'events' / 'native'
    receipts.mkdir(exist_ok=True)
    try:
        return 0 if spool_event(os.environ, state_dir, receipts / f"{event['id']}-{recipient}.json",
                                recipient, event, message) else 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return 1


def main():
    if len(sys.argv) == 6 and sys.argv[1] == 'event':
        return event_main(sys.argv[2:])
    if len(sys.argv) == 3 and sys.argv[1] == '--route-harness':
        try:
            print(route_harness(json.loads(Path(sys.argv[2]).read_text())))
        except (OSError, ValueError, TypeError):
            return 1
        return 0
    if len(sys.argv) == 4 and sys.argv[1] == '--monitor-route':
        try:
            route = resolve_route_v2(sys.argv[2], sys.argv[3])
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return 1
        if route['status'] == 'active':
            print('\n'.join([route['coordinator'], *route['peers']]))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['unblock'])
    parser.add_argument('--route', required=True)
    parser.add_argument('--project-root', required=True)
    parser.add_argument('--slot', type=int, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--parent', type=canonical_session, action='append', default=[])
    args = parser.parse_args()
    if len(args.parent) != len(set(args.parent)):
        parser.error('duplicate parent UUID')
    try:
        state = run(os.environ, args.state_dir, args.route, args.project_root, args.slot, args.parent)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        state = {'status': 'blocked', 'reason': 'monitor route or state unavailable'}
    print(json.dumps({key: state[key] for key in ('status', 'previousStatus', 'reason', 'monitor_session_status')
                      if key in state}))
    return 0 if state['status'] in ('sending', 'deduplicated', 'unchanged', 'busy') else 1


if __name__ == '__main__':
    raise SystemExit(main())
