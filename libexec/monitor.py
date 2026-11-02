"""Local queue inventory and explicitly authorised, snapshot-bound acknowledgements."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def persist(path, record):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / ('.' + path.name + '.' + str(uuid.uuid4()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(record, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    # Include newly created directory entries in the durability boundary.
    for directory in (path.parent, path.parent.parent):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def canonical_uuid(value):
    if str(uuid.UUID(value)) != value:
        raise ValueError('canonical UUID required')
    return value


@contextmanager
def locked(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'monitor.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def queue_entries(client, recipient):
    entries = {}
    cursor = None
    cursors = set()
    while True:
        params = {'threadId': recipient, 'limit': 100}
        if cursor is not None:
            params['cursor'] = cursor
        page = client.call('thread/queue/list', params)
        if (not isinstance(page, dict) or not isinstance(page.get('data'), list)
                or page.get('truncated') or page.get('hasMore')):
            raise ValueError('queue inventory incomplete')
        for entry in page['data']:
            if (not isinstance(entry, dict) or not isinstance(entry.get('id'), str)
                    or not entry['id'] or not isinstance(entry.get('clientUserMessageId'), str)
                    or not isinstance(entry.get('input'), list)):
                raise ValueError('unknown queued submission shape')
            identity = entry['id']
            if identity in entries and entries[identity] != entry:
                raise ValueError('queue changed during pagination')
            entries[identity] = entry
        cursor = page.get('nextCursor')
        if cursor is None:
            return list(entries.values())
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError('queue pagination did not advance')
        cursors.add(cursor)


def history_refs(client, recipient, cursor=None):
    params = {'threadId': recipient, 'limit': 100, 'sortDirection': 'desc'}
    if cursor is not None:
        params['cursor'] = cursor
    result = {'status': 'unavailable', 'complete': False, 'cursor': cursor,
              'nextCursor': None, 'question_refs': [], 'user_reply_refs': [],
              'reason_code': 'metadata_unavailable', 'category': 'metadata'}
    try:
        from unblock import NATIVE_ITEM_TYPES, RpcError, question_item
        page = client.call('thread/items/list', params)
        if not isinstance(page, dict) or not isinstance(page.get('data'), list):
            result.update(reason_code='malformed_page', category='page')
            return result
        next_cursor = page.get('nextCursor')
        if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor):
            result.update(reason_code='invalid_cursor', category='pagination')
            return result
        result['nextCursor'] = next_cursor
        for entry in page['data']:
            if not isinstance(entry, dict) or not isinstance(entry.get('turnId'), str) or not entry['turnId']:
                result.update(reason_code='malformed_row', category='row')
                return result
            item = entry.get('item')
            if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                    or not item['id'] or not isinstance(item.get('type'), str)):
                result.update(reason_code='malformed_item', category='item')
                return result
            if item['type'] not in NATIVE_ITEM_TYPES:
                category = 'context_compaction' if item['type'] == 'contextCompaction' else 'unknown_item'
                result.update(reason_code='unsupported_item_type', category=category)
                return result
            reference = {'turn_id': entry['turnId'], 'item_id': item['id']}
            if question_item(item):
                reference['kind'] = 'rendered_prompt' if item['type'] == 'agentMessage' else 'question_tool'
                result['question_refs'].append(reference)
            elif item['type'] == 'userMessage':
                result['user_reply_refs'].append(reference)
        result['complete'] = not (next_cursor is not None or page.get('truncated') or page.get('hasMore'))
        result['status'] = 'complete' if result['complete'] else 'partial'
        if page.get('truncated') or page.get('hasMore'):
            result.update(reason_code='incomplete_page', category='pagination')
        elif next_cursor is not None:
            result.update(reason_code='more_history', category='pagination')
        else:
            result.update(reason_code='complete', category='history')
        return result
    except json.JSONDecodeError:
        result.update(reason_code='json_parse_failure', category='json')
    except RpcError:
        result.update(reason_code='native_rpc_failure', category='native_rpc')
    except (OSError, TimeoutError):
        result.update(reason_code='transport_failure', category='transport')
    except Exception:
        result.update(reason_code='metadata_failure', category='metadata')
    return result


def capture(client, state_dir, recipients, slot=None, history_cursor=None):
    record = {'snapshot_id': str(uuid.uuid4()), 'queues': {}, 'errors': {}, 'history': {}}
    if slot is not None:
        record['slot'] = slot
    for recipient in dict.fromkeys(recipients):
        canonical_uuid(recipient)
        try:
            record['queues'][recipient] = queue_entries(client, recipient)
        except Exception:
            record['errors'][recipient] = 'queue inventory unavailable or incomplete; retry snapshot before reconciliation'
        record['history'][recipient] = history_refs(client, recipient, history_cursor)
    path = state_dir / 'snapshots' / (record['snapshot_id'] + '.json')
    persist(path, record)
    return record


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def retention_path(state_dir, recipient, identity):
    return state_dir / 'retentions' / (digest([recipient, identity]) + '.json')


def payload_signature(entry):
    return digest([entry['clientUserMessageId'], entry['input']])


def unacknowledged(state_dir, snapshot):
    queues = {}
    retained = 0
    for recipient, entries in snapshot['queues'].items():
        queues[recipient] = []
        for entry in entries:
            path = retention_path(state_dir, recipient, entry['id'])
            try:
                record = json.loads(path.read_text())
                matches = (record.get('active') is True and record.get('recipient') == recipient
                           and record.get('queue_id') == entry['id']
                           and record.get('payload_signature') == payload_signature(entry))
            except (OSError, ValueError, AttributeError):
                matches = False
            if matches:
                retained += 1
            else:
                queues[recipient].append(entry)
    return queues, retained


def inventory_signature(state_dir, snapshot):
    queues, _ = unacknowledged(state_dir, snapshot)
    return digest({'queues': queues, 'errors': snapshot['errors']})


def accepted_inventory(state_dir, recipient, snapshot):
    queues, retained = unacknowledged(state_dir, snapshot)
    if retained and not any(queues.values()) and not snapshot['errors']:
        return True
    path = state_dir / 'health' / (recipient + '.json')
    if snapshot['errors'] or not path.exists():
        return False
    return json.loads(path.read_text()).get('accepted_signature') == inventory_signature(state_dir, snapshot)


def health_event(state_dir, recipient, slot, snapshot_id, signature):
    snapshot_path = state_dir / 'snapshots' / (snapshot_id + '.json')
    message = (f'Monitor needs owner reconciliation for {recipient} after two distinct slots: '
               f'inspect local snapshot {snapshot_path}; classify queued work, preserve independent work, '
               'and explicitly monitor-ack handled, superseded or retained IDs. Check recipient clearance/native '
               'question state for deferred reminders. Accepted reminders do not acknowledge queue work.')
    subprocess.run([sys.executable, str(Path(__file__).with_name('event.py')), str(state_dir.parent),
                    'emit', 'monitor-stuck', f'{recipient}-{slot}-{signature}', message], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def record_health(state_dir, recipient, slot, snapshot, outcome):
    path = state_dir / 'health' / (recipient + '.json')
    record = json.loads(path.read_text()) if path.exists() else {'seen_slots': []}
    queues, retained = unacknowledged(state_dir, snapshot)
    previous_items = record.get('backlog_items', {})
    items = {thread: entries for thread, entries in previous_items.items()
             if thread in snapshot['errors']}
    for thread, entries in queues.items():
        items[thread] = {}
        for entry in entries:
            identity = entry['id']
            signature = payload_signature(entry)
            previous = previous_items.get(thread, {}).get(identity, {})
            slots = (list(previous.get('slots', []))
                     if previous.get('payload_signature') == signature else [])
            if slot not in slots:
                slots.append(slot)
            items[thread][identity] = {'payload_signature': signature, 'slots': slots, 'age': len(slots)}
    record['backlog_items'] = items
    record['backlog_slots'] = max((item['age'] for entries in items.values()
                                   for item in entries.values()), default=0)
    status = outcome.get('previousStatus', outcome['status'])
    deferred = (status in ('deferred', 'blocked') or bool(snapshot['errors'])
                or any(history['status'] == 'unavailable' for history in snapshot.get('history', {}).values()))
    if slot not in record['seen_slots']:
        record['seen_slots'].append(slot)
        record['deferral_slots'] = record.get('deferral_slots', 0) + 1 if deferred else 0
    if not deferred:
        record['deferral_slots'] = 0
    if outcome['status'] == 'accepted':
        record['accepted_signature'] = inventory_signature(state_dir, snapshot)
    failed = max(record.get('backlog_slots', 0), record.get('deferral_slots', 0)) >= 2
    health = {'monitor_status': 'failed' if failed else 'ok', 'recipient': recipient,
              'snapshot_id': snapshot['snapshot_id'],
              'backlog_slots': record.get('backlog_slots', 0),
              'deferral_slots': record.get('deferral_slots', 0)}
    if failed:
        health['monitor_reason'] = 'owner must inspect snapshot, reconcile queued work or recipient clearance, and explicitly acknowledge handled IDs'
    record.update(health, last_delivery_status=outcome['status'])
    if not failed:
        record['reported'] = False
        record.pop('problem_signature', None)
        record.pop('episode_first_slot', None)
    elif not record.get('reported', False):
        problem_signature = digest({'items': {thread: sorted(identity for identity, item in entries.items()
                                                                    if item['age'] >= 2)
                                             for thread, entries in items.items()},
                                    'deferred': record.get('deferral_slots', 0) >= 2})
        record.update(problem_signature=problem_signature, episode_first_slot=slot)
        health_event(state_dir, recipient, slot, snapshot['snapshot_id'], problem_signature)
        record['reported'] = True
    persist(path, record)
    return health


def acknowledge(client, state_dir, recipient, snapshot_id, queue_ids, disposition, reason=None):
    canonical_uuid(recipient)
    canonical_uuid(snapshot_id)
    if disposition not in ('handled', 'superseded', 'retained') or not queue_ids:
        raise ValueError('explicit disposition and queue IDs required')
    if disposition == 'retained' and (not isinstance(reason, str) or not reason.strip()):
        raise ValueError('retention requires a nonempty reason')
    with locked(state_dir):
        snapshot = json.loads((state_dir / 'snapshots' / (snapshot_id + '.json')).read_text())
        if snapshot.get('snapshot_id') != snapshot_id or recipient not in snapshot.get('queues', {}):
            raise ValueError('snapshot recipient mismatch')
        originals = {entry['id']: entry for entry in snapshot['queues'][recipient]}
        if any(identity not in originals for identity in queue_ids):
            raise ValueError('queue ID not present in recipient snapshot')
        results = []
        for identity in dict.fromkeys(queue_ids):
            path = state_dir / 'acks' / (digest([recipient, snapshot_id, identity]) + '.json')
            operation = json.loads(path.read_text()) if path.exists() else {
                'recipient': recipient, 'snapshot_id': snapshot_id, 'queue_id': identity,
                'disposition': disposition, 'attempt': 0, 'attempts': []}
            retained_path = retention_path(state_dir, recipient, identity)
            if operation.get('state') == 'deleting':
                operation['state'] = 'ambiguous'
                if operation['attempts']:
                    operation['attempts'][-1]['state'] = 'ambiguous'
                operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': 'ambiguous'})
                persist(path, operation)
            if operation['disposition'] != disposition:
                raise ValueError('acknowledgement disposition differs from durable operation')
            if disposition in ('handled', 'superseded') and retained_path.exists():
                retention = json.loads(retained_path.read_text())
                retention['active'] = False
                retention.setdefault('history', []).append({'state': 'invalidated', 'snapshot_id': snapshot_id})
                persist(retained_path, retention)
            if operation.get('state') in ('deleted', 'confirmed_absent'):
                results.append({'queue_id': identity, 'state': operation['state']})
                continue
            # Every explicit invocation re-lists, including interrupted/ambiguous operations.
            try:
                current = {entry['id']: entry for entry in queue_entries(client, recipient)}
            except Exception:
                operation['state'] = 'unavailable'
                operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': 'unavailable'})
                persist(path, operation)
                results.append({'queue_id': identity, 'state': 'unavailable'})
                continue
            if identity not in current:
                operation['state'] = 'confirmed_absent'
            elif payload_signature(current[identity]) != payload_signature(originals[identity]):
                operation['state'] = 'changed_payload'
            elif disposition == 'retained':
                retention = json.loads(retained_path.read_text()) if retained_path.exists() else {'history': []}
                retention.update(recipient=recipient, queue_id=identity, snapshot_id=snapshot_id,
                                 reason=reason, payload_signature=payload_signature(current[identity]), active=True)
                retention['history'].append({'state': 'retained', 'snapshot_id': snapshot_id})
                persist(retained_path, retention)
                operation.update(state='retained', reason=reason)
            else:
                if operation.get('state') == 'deleting' and operation['attempts']:
                    operation['attempts'][-1]['state'] = 'ambiguous'
                operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': operation.get('state', 'acknowledged')})
                operation.update(state='deleting', attempt=operation['attempt'] + 1)
                operation['attempts'].append({'attempt': operation['attempt'], 'state': 'deleting'})
                persist(path, operation)
                try:
                    response = client.call('thread/queue/delete', {
                        'threadId': recipient, 'queuedSubmissionId': identity})
                    if not isinstance(response, dict) or type(response.get('deleted')) is not bool:
                        raise ValueError('unknown deletion response')
                    if response['deleted']:
                        operation['state'] = 'deleted'
                    else:
                        after = {entry['id']: entry for entry in queue_entries(client, recipient)}
                        operation['state'] = 'confirmed_absent' if identity not in after else 'not_deleted'
                except Exception:
                    operation['state'] = 'ambiguous'
                    try:
                        after = {entry['id']: entry for entry in queue_entries(client, recipient)}
                        if identity not in after:
                            operation['state'] = 'confirmed_absent'
                    except Exception:
                        pass
            if operation.get('attempts') and operation['attempts'][-1]['state'] == 'deleting':
                operation['attempts'][-1]['state'] = operation['state']
            operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': operation['state']})
            persist(path, operation)
            results.append({'queue_id': identity, 'state': operation['state']})
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('snapshot', 'ack'))
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--control-socket', type=Path)
    parser.add_argument('--recipient', type=canonical_uuid, required=True)
    parser.add_argument('--snapshot', type=canonical_uuid)
    parser.add_argument('--history-cursor')
    parser.add_argument('--queue-id', action='append', default=[])
    parser.add_argument('--disposition', choices=('handled', 'superseded', 'retained'))
    parser.add_argument('--reason')
    args = parser.parse_args()
    if args.command == 'ack' and (not args.snapshot or not args.queue_id or not args.disposition):
        parser.error('ack requires --snapshot, --queue-id and --disposition')
    if args.disposition == 'retained' and not (args.reason and args.reason.strip()):
        parser.error('retained requires --reason')
    from codex_adapter import control_socket_available
    from unblock import CapabilityError, connect
    if not control_socket_available(args.control_socket):
        print(json.dumps({'status': 'unavailable', 'reason': 'configure an available absolute CODEX_CONTROL_SOCKET'}))
        return 1
    client = None
    try:
        client = connect(time.monotonic() + 25, args.control_socket)
        if args.command == 'snapshot':
            with locked(args.state_dir):
                snapshot = capture(client, args.state_dir, [args.recipient], history_cursor=args.history_cursor)
            print(json.dumps({'snapshot_id': snapshot['snapshot_id'],
                              'path': str(args.state_dir / 'snapshots' / (snapshot['snapshot_id'] + '.json')),
                              'queue_ids': [entry['id'] for entry in snapshot['queues'].get(args.recipient, [])],
                              'complete': not snapshot['errors'], 'history': snapshot['history']}))
            return int(bool(snapshot['errors']) or any(history['status'] == 'unavailable' for history in snapshot['history'].values()))
        results = acknowledge(client, args.state_dir, args.recipient, args.snapshot, args.queue_id, args.disposition, args.reason)
        print(json.dumps({'results': results}))
        return int(any(row['state'] not in ('deleted', 'confirmed_absent', 'retained') for row in results))
    except CapabilityError as error:
        print(json.dumps({'status': 'unavailable', 'reason': str(error)}))
        return 1
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason': 'inspect local monitor state and retry explicit reconciliation'}))
        return 1
    finally:
        if client is not None:
            client.connection.close()


if __name__ == '__main__':
    raise SystemExit(main())
