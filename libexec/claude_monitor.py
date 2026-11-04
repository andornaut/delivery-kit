#!/usr/bin/python3
"""Claude monitor inventory and acknowledgements over delivered channel entries.

Claude exposes no native queue, question or history API. The acknowledgeable inventory is
the set of channel entries the consumer delivered to the monitor; everything native is
reported as unavailable and never as clearance.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import uuid

from claude_adapter import (DELIVERED, SPOOL, canonical_session, listing_or_none, resolve_route_v2,
                            role_diagnostics)
from monitor import digest, locked, payload_signature, persist, retention_path

UNAVAILABLE = {'status': 'unavailable', 'reason_code': 'claude_no_native_api'}


def delivered(state_dir, recipient):
    entries = {}
    for path in sorted((state_dir / DELIVERED).glob('*.json')):
        try:
            entry = json.loads(path.read_text())
            if entry.get('recipient') != recipient or path.stem != entry.get('requestId'):
                continue
            receipt = json.loads((state_dir.parent / entry['receipt']).read_text())
        except (OSError, ValueError, TypeError, KeyError):
            continue
        entries[entry['requestId']] = {
            'id': entry['requestId'], 'clientUserMessageId': entry['requestId'],
            'input': [{'type': 'text', 'text': entry['text']}], 'kind': entry.get('kind'),
            'acceptedAt': entry.get('acceptedAt'), 'receipt_status': receipt.get('status')}
    return entries


def retained(state_dir, recipient, entry):
    try:
        record = json.loads(retention_path(state_dir, recipient, entry['id']).read_text())
    except (OSError, ValueError):
        return False
    return (record.get('active') is True and record.get('recipient') == recipient
            and record.get('queue_id') == entry['id']
            and record.get('payload_signature') == payload_signature(entry))


def scope(route_file, recipient):
    route = json.loads(Path(route_file).read_text())
    resolved = resolve_route_v2(route_file, route['host_project_root'])
    if resolved.get('status') != 'active' or resolved['coordinator'] != recipient:
        raise ValueError('recipient must be the active Claude route monitor')
    return resolved


def capture(environment, state_dir, route_file, recipient, parents=()):
    route = scope(route_file, recipient)
    if any(parent not in {recipient, *route['peers']} for parent in parents):
        raise ValueError('parent outside active route')
    entries = list(delivered(state_dir, recipient).values())
    for entry in entries:
        entry['retained'] = retained(state_dir, recipient, entry)
    listing = listing_or_none(environment)
    roles = [recipient, *route['peers']]
    pending = []
    for path in sorted((state_dir / SPOOL).glob('*.json')) + sorted((state_dir / SPOOL).glob('*.claimed')):
        pending.append({'request_id': path.stem, 'state': 'claimed' if path.suffix == '.claimed' else 'spooled'})
    record = {
        'snapshot_id': str(uuid.uuid4()), 'harness': 'claude', 'queues': {recipient: entries}, 'errors': {},
        'history': {role: dict(UNAVAILABLE) for role in roles},
        'question_state': {row['session_id']: row for row in role_diagnostics(listing, roles)},
        'target_queues': {target['session_id']: dict(UNAVAILABLE, name=target['name']) for target in route['targets']},
        'worker_health': {parent: dict(UNAVAILABLE) for parent in parents},
        'process_health': {}, 'process_health_source': dict(UNAVAILABLE),
        'channel_pending': pending}
    persist(state_dir / 'snapshots' / (record['snapshot_id'] + '.json'), record)
    return record


def acknowledge(state_dir, route_file, recipient, snapshot_id, queue_ids, disposition, reason=None):
    canonical_session(recipient)
    canonical_session(snapshot_id)
    scope(route_file, recipient)
    if disposition not in ('handled', 'superseded', 'retained') or not queue_ids:
        raise ValueError('explicit disposition and queue IDs required')
    if disposition == 'retained' and (not isinstance(reason, str) or not reason.strip()):
        raise ValueError('retention requires a nonempty reason')
    with locked(state_dir):
        snapshot = json.loads((state_dir / 'snapshots' / (snapshot_id + '.json')).read_text())
        if (snapshot.get('snapshot_id') != snapshot_id or snapshot.get('harness') != 'claude'
                or recipient not in snapshot.get('queues', {})):
            raise ValueError('snapshot recipient mismatch')
        originals = {entry['id']: entry for entry in snapshot['queues'][recipient]}
        if any(identity not in originals for identity in queue_ids):
            raise ValueError('queue ID not present in recipient snapshot')
        results = []
        for identity in dict.fromkeys(queue_ids):
            path = state_dir / 'acks' / (digest([recipient, snapshot_id, identity]) + '.json')
            operation = json.loads(path.read_text()) if path.exists() else {
                'recipient': recipient, 'snapshot_id': snapshot_id, 'queue_id': identity, 'harness': 'claude',
                'disposition': disposition, 'attempt': 0, 'attempts': [], 'history': []}
            if operation['disposition'] != disposition:
                raise ValueError('acknowledgement disposition differs from durable operation')
            if operation.get('state') == 'deleting':
                operation['state'] = 'ambiguous'
                operation['attempts'][-1]['state'] = 'ambiguous'
                operation['history'].append({'attempt': operation['attempt'], 'state': 'ambiguous'})
                persist(path, operation)
            retained_path = retention_path(state_dir, recipient, identity)
            if disposition in ('handled', 'superseded') and retained_path.exists():
                retention = json.loads(retained_path.read_text())
                retention['active'] = False
                retention.setdefault('history', []).append({'state': 'invalidated', 'snapshot_id': snapshot_id})
                persist(retained_path, retention)
            if operation.get('state') in ('deleted', 'confirmed_absent'):
                results.append({'queue_id': identity, 'state': operation['state']})
                continue
            current = delivered(state_dir, recipient)
            original = originals[identity]
            if identity not in current:
                operation['state'] = 'confirmed_absent'
            elif payload_signature(current[identity]) != payload_signature(original):
                operation['state'] = 'changed_payload'
            elif disposition == 'retained':
                retention = json.loads(retained_path.read_text()) if retained_path.exists() else {'history': []}
                retention.update(recipient=recipient, queue_id=identity, snapshot_id=snapshot_id, reason=reason,
                                 payload_signature=payload_signature(original), active=True)
                retention['history'].append({'state': 'retained', 'snapshot_id': snapshot_id})
                persist(retained_path, retention)
                operation.update(state='retained', reason=reason)
            else:
                operation.update(state='deleting', attempt=operation['attempt'] + 1,
                                 payload_signature=payload_signature(original))
                operation['attempts'].append({'attempt': operation['attempt'], 'state': 'deleting'})
                persist(path, operation)
                (state_dir / DELIVERED / f'{identity}.json').unlink()
                operation['state'] = 'deleted'
                operation['attempts'][-1]['state'] = 'deleted'
            operation['history'].append({'attempt': operation['attempt'], 'state': operation['state']})
            persist(path, operation)
            results.append({'queue_id': identity, 'state': operation['state']})
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('snapshot', 'ack'))
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--route', required=True)
    parser.add_argument('--recipient', type=canonical_session, required=True)
    parser.add_argument('--snapshot', type=canonical_session)
    parser.add_argument('--parent', type=canonical_session, action='append', default=[])
    parser.add_argument('--queue-id', action='append', default=[])
    parser.add_argument('--disposition', choices=('handled', 'superseded', 'retained'))
    parser.add_argument('--reason')
    args = parser.parse_args()
    if len(args.parent) != len(set(args.parent)):
        parser.error('duplicate parent UUID')
    if args.command == 'ack' and (not args.snapshot or not args.queue_id or not args.disposition):
        parser.error('ack requires --snapshot, --queue-id and --disposition')
    if args.disposition == 'retained' and not (args.reason and args.reason.strip()):
        parser.error('retained requires --reason')
    try:
        if args.command == 'snapshot':
            with locked(args.state_dir):
                snapshot = capture(os.environ, args.state_dir, args.route, args.recipient, args.parent)
            print(json.dumps({'snapshot_id': snapshot['snapshot_id'],
                              'path': str(args.state_dir / 'snapshots' / (snapshot['snapshot_id'] + '.json')),
                              'queue_ids': [entry['id'] for entry in snapshot['queues'][args.recipient]],
                              'complete': True, 'harness': 'claude', 'history': snapshot['history'],
                              'worker_health': snapshot['worker_health'],
                              'question_state_status': {owner: value['status'] for owner, value in snapshot['question_state'].items()},
                              'session_status': {owner: value['session_status'] for owner, value in snapshot['question_state'].items()},
                              'target_queue_status': {owner: value['status'] for owner, value in snapshot['target_queues'].items()},
                              'process_health_source': snapshot['process_health_source'],
                              'channel_pending': snapshot['channel_pending']}))
            return 0
        results = acknowledge(args.state_dir, args.route, args.recipient, args.snapshot, args.queue_id,
                              args.disposition, args.reason)
        print(json.dumps({'results': results}))
        return int(any(row['state'] not in ('deleted', 'confirmed_absent', 'retained') for row in results))
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason': 'inspect local monitor state and retry explicit reconciliation'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
