"""Guarded bus-event input for the confirmed monitor, without queue fallback."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

from codex_adapter import control_socket_available, resolve_route
from unblock import connect, decision_clear, decision_record, persist, RpcError, target


def monitor_recipient(environment, recipient):
    """Return True for native, False for queue, or None for deferred routing."""
    route_file = environment.get('MONITOR_ROUTE_FILE')
    if route_file is None:
        return False
    try:
        route = json.loads(Path(route_file).read_text())
        resolved = resolve_route(route_file, route['host_project_root'])
        monitor = route['monitor_thread_id']
        if monitor is None:
            return None
        if monitor != recipient:
            return False
        return True if resolved.get('status') == 'active' else None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


def deliver(client, state_dir, path, recipient, event, message):
    request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"bus-event:{event['id']}:{recipient}"))
    state = {'event_id': event['id'], 'recipient': recipient,
             'clientUserMessageId': request_id, 'attempts': []}
    if path.exists():
        state = json.loads(path.read_text())
        if (state.get('event_id'), state.get('recipient'), state.get('clientUserMessageId')) != (
                event['id'], recipient, request_id):
            return False
        if state['status'] == 'accepted':
            return True
        if state['status'] in ('sending', 'ambiguous', 'rejected'):
            # Native userMessage items expose no clientUserMessageId linkage.
            # Neither item text, clientId nor turnId proves request acceptance.
            if state['status'] == 'sending':
                state.update(status='ambiguous')
                persist(path, state)
            return False
    for attempt in range(len(state['attempts']), 2):
        clearance = decision_record(state_dir, recipient)
        if not decision_clear(state_dir, recipient):
            state.update(status='deferred')
            persist(path, state)
            return False
        selected, _ = target(client, state_dir, recipient)
        if (selected is None or not decision_clear(state_dir, recipient)
                or decision_record(state_dir, recipient) != clearance):
            state.update(status='deferred')
            persist(path, state)
            return False
        method = selected['method']
        params = {'threadId': recipient, 'input': [{'type': 'text', 'text': message}],
                  'clientUserMessageId': request_id}
        if method == 'turn/steer':
            params['expectedTurnId'] = selected['expectedTurnId']
        record = {'method': method, 'status': 'sending'}
        if 'expectedTurnId' in params:
            record['expectedTurnId'] = params['expectedTurnId']
        state['attempts'].append(record)
        state.update(status='sending')
        persist(path, state)
        try:
            response = client.call(method, params)
        except RpcError as error:
            record.update(status='rejected')
            state.update(status='rejected')
            persist(path, state)
            if method == 'turn/steer' and error.stale_turn and attempt == 0:
                continue
            return False
        except Exception:
            record.update(status='ambiguous')
            state.update(status='ambiguous')
            persist(path, state)
            return False
        turn_id = None
        if isinstance(response, dict):
            turn_id = response.get('turnId')
            if turn_id is None and isinstance(response.get('turn'), dict):
                turn_id = response['turn'].get('id')
        accepted = isinstance(turn_id, str) and bool(turn_id) and (
            method != 'turn/steer' or turn_id == params['expectedTurnId'])
        record.update(status='accepted' if accepted else 'ambiguous')
        state.update(status=record['status'])
        if accepted:
            record['turnId'] = turn_id
        persist(path, state)
        return accepted
    return False


def main():
    state_dir, event_path, recipient, message = sys.argv[1:]
    state_dir = Path(state_dir)
    event = json.loads(Path(event_path).read_text())
    if monitor_recipient(os.environ, recipient) is not True:
        return 1
    receipts = state_dir / 'events' / 'native'
    receipts.mkdir(exist_ok=True)
    path = receipts / f"{event['id']}-{recipient}.json"
    client = None
    try:
        socket_value = os.environ.get('CODEX_CONTROL_SOCKET')
        socket_path = Path(socket_value) if socket_value else None
        if not control_socket_available(socket_path):
            return 1
        client = connect(time.monotonic() + 15, socket_path)
        return 0 if deliver(client, state_dir / 'unblock', path, recipient, event, message) else 1
    except Exception:
        # Transport bodies and native payloads must not enter logs or receipts.
        return 1
    finally:
        if client is not None:
            client.connection.close()


if __name__ == '__main__':
    raise SystemExit(main())
