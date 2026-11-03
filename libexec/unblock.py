#!/usr/bin/python3
"""Send one slot-scoped coordinator reminder through the existing local Codex server."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
import uuid

from codex_adapter import control_socket_available
from monitor import accepted_inventory, canonical_uuid, capture, locked, pending_worker_failures, pending_proven, question_brief, question_notices, process_notices, process_request_started, process_request_result, prior_process_observations, record_health, scoped_parents


NATIVE_ITEM_TYPES = {
    'agentMessage', 'collabAgentToolCall', 'commandExecution', 'contextCompaction', 'dynamicToolCall',
    'enteredReviewMode', 'exitedReviewMode', 'fileChange', 'functionCallOutput',
    'hookPrompt', 'imageGeneration', 'imageView', 'mcpToolCall', 'plan',
    'reasoning', 'sleep', 'subAgentActivity', 'userMessage', 'webSearch',
}


class CapabilityError(Exception):
    pass


class RpcError(Exception):
    def __init__(self, error):
        super().__init__("native request rejected")
        self.code = error.get("code")
        message = str(error.get("message", ""))
        self.stale_turn = bool(re.search(
            r"expectedTurnId.*(?:does not match|mismatch)", message, re.IGNORECASE
        ))


class Client:
    def __init__(self, connection, deadline):
        self.connection = connection
        self.deadline = deadline
        self.sequence = 0

    def send(self, message):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("native request deadline")
        self.connection.settimeout(min(5, remaining))
        self.connection.send(json.dumps(message))

    def call(self, method, params):
        self.sequence += 1
        identifier = self.sequence
        self.send({"id": identifier, "method": method, "params": params})
        while True:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("native response deadline")
            self.connection.settimeout(min(5, remaining))
            message = json.loads(self.connection.recv())
            # Notifications and server questions belong to their existing client.
            if message.get("id") != identifier or "method" in message:
                continue
            if "error" in message:
                raise RpcError(message["error"])
            return message["result"]


def connect(deadline, control_socket):
    try:
        import websocket
    except ModuleNotFoundError as error:
        executable = re.sub(r"[\x00-\x1f\x7f]", "?", sys.executable)
        raise CapabilityError(
            f"websocket-client unavailable in native interpreter {executable}; "
            "provide websocket-client in this interpreter or select CODEX_PYTHON with that dependency"
        ) from error

    transport = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    transport.settimeout(min(5, max(0, deadline - time.monotonic())))
    try:
        transport.connect(str(control_socket))
        connection = websocket.create_connection("ws://localhost/", socket=transport, timeout=5)
    except Exception:
        transport.close()
        raise
    client = Client(connection, deadline)
    try:
        client.call("initialize", {
            "clientInfo": {"name": "hourly-unblock", "version": "1"},
            "capabilities": {"experimentalApi": True},
        })
        client.send({"method": "initialized"})
    except Exception:
        connection.close()
        raise
    return client


def persist(path, state):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(state, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def decision_record(state_dir, recipient):
    try:
        if str(uuid.UUID(recipient)) != recipient:
            return None
        marker = json.loads((state_dir / "decisions" / f"{recipient}.json").read_text())
        if not isinstance(marker, dict) or marker.get('thread_id') != recipient:
            return None
        resolutions = marker.get('resolutions', [])
        if not isinstance(resolutions, list):
            return None
        seen = set()
        for resolution in resolutions:
            fields = ('question_turn_id', 'question_item_id', 'answer_turn_id', 'answer_item_id')
            if (not isinstance(resolution, dict)
                    or any(not isinstance(resolution.get(field), str) or not resolution[field] for field in fields)):
                return None
            reference = (resolution['question_turn_id'], resolution['question_item_id'])
            if reference in seen:
                return None
            seen.add(reference)
        return marker
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def decision_clear(state_dir, recipient):
    marker = decision_record(state_dir, recipient)
    return marker is not None and marker.get('state') == 'clear'


def question_item(item):
    if item['type'] == 'agentMessage':
        # Omitted questions default to null in the native schema.
        return item.get('questions') not in (None, [])
    if item['type'] in ('dynamicToolCall', 'functionCallOutput'):
        tool = str(item.get('tool', item.get('name', ''))).lower().replace('_', '')
        return any(name in tool for name in ('requestuserinput', 'askuserquestion', 'elicitation'))
    return False


def native_items(client, recipient, turn_id):
    cursor = None
    cursors = set()
    items = {}
    while True:
        params = {'threadId': recipient, 'turnId': turn_id, 'limit': 100, 'sortDirection': 'asc'}
        if cursor is not None:
            params['cursor'] = cursor
        page = client.call('thread/items/list', params)
        if (not isinstance(page, dict) or not isinstance(page.get('data'), list)
                or page.get('truncated') or page.get('hasMore')):
            raise ValueError('native item history incomplete')
        for entry in page['data']:
            if not isinstance(entry, dict) or entry.get('turnId') != turn_id:
                raise ValueError('native turn identity mismatch')
            item = entry.get('item')
            if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                    or not item['id'] or item.get('type') not in NATIVE_ITEM_TYPES):
                raise ValueError('unknown native item')
            if item['type'] == 'mcpToolCall' and item.get('status') != 'completed':
                raise ValueError('native tool incomplete')
            if item['id'] in items:
                raise ValueError('duplicate native item')
            items[item['id']] = item
        cursor = page.get('nextCursor')
        if cursor is None:
            return items
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError('native pagination incomplete')
        cursors.add(cursor)


def native_questions_clear(client, state_dir, recipient, turn_id):
    try:
        record = decision_record(state_dir, recipient)
        if record is None:
            return False, 'recipient resolution record missing or invalid'
        pages = {turn_id: native_items(client, recipient, turn_id)}
        if any(item['type'] == 'contextCompaction' for item in pages[turn_id].values()):
            return False, 'native latest-turn context compaction prevents complete question proof'
        resolved = set()
        for resolution in record.get('resolutions', []):
            if resolution['question_turn_id'] != turn_id:
                continue
            question_turn = resolution['question_turn_id']
            answer_turn = resolution['answer_turn_id']
            for selected_turn in (question_turn, answer_turn):
                if selected_turn not in pages:
                    pages[selected_turn] = native_items(client, recipient, selected_turn)
            question = pages[question_turn].get(resolution['question_item_id'])
            answer = pages[answer_turn].get(resolution['answer_item_id'])
            if question is None or not question_item(question) or answer is None or answer['type'] != 'userMessage':
                return False, 'recipient question resolution cannot be verified by exact native IDs'
            if question_turn == answer_turn:
                order = list(pages[question_turn])
                if order.index(answer['id']) <= order.index(question['id']):
                    return False, 'recipient answer item must follow its question in the same native turn'
            resolved.add((question_turn, question['id']))
        for item in pages[turn_id].values():
            if question_item(item) and (turn_id, item['id']) not in resolved:
                return False, f'native question pending: question_turn_id={turn_id} question_item_id={item["id"]}'
        return True, None
    except Exception:
        return False, 'native question history incomplete or unknown'


def target(client, state_dir, coordinator):
    thread = client.call("thread/read", {"threadId": coordinator, "includeTurns": False})["thread"]
    status = thread.get("status", {})
    if thread.get("canAcceptDirectInput") is not True:
        return None, "coordinator input availability unknown"
    if status.get("type") == "active" and status.get("activeFlags") != []:
        return None, "coordinator waiting on a question or approval"
    turns = client.call("thread/turns/list", {
        "threadId": coordinator, "limit": 1, "itemsView": "notLoaded", "sortDirection": "desc",
    })["data"]
    latest = turns[0] if turns else None
    if latest:
        clear, reason = native_questions_clear(client, state_dir, coordinator, latest['id'])
        if not clear:
            return None, reason
    if status.get("type") == "active" and latest and latest["status"] == "inProgress":
        return {"method": "turn/steer", "expectedTurnId": latest["id"]}, None
    if status.get("type") == "idle" and latest and latest["status"] == "completed":
        return {"method": "turn/start"}, None
    return None, "coordinator state ambiguous or interrupted; no automatic resume"


def reminder(slot, queues, snapshot_path, worker_failures=(), questions=(), question_diagnostics=(), processes=(), process_diagnostics=()):
    inventory = "\n".join(f"{thread}: {','.join(ids) if ids else 'none'}" for thread, ids in queues.items())
    worker_review = (
        "\nVerified latest failed child turns (parent, child, turn, typed code): "
        + json.dumps(worker_failures) +
        ". Live deliver these exact references to the owning parent only after checking its "
        "recipient guards and native questions. Request that parent checkpoint and quiesce affected "
        "approved work before reassigning to a healthy existing worker or replacement, within eight "
        "useful workers and ten total spawns. Preserve WIP, worktrees, jobs, exact decisions and "
        "unanswered questions. Parent decides and confirms handling; acceptance is delivery only. "
        "Do not contact or mutate children, spawn workers, clear guards, or infer stalls from silence."
        if worker_failures else ""
    )
    question_review = (
        "\nOwner-attested confirmed pending questions: " + json.dumps(questions, ensure_ascii=False)
        + ". Surface the exact owner, native references, original title and choices, and where to answer "
        "in the owner's native conversation. An escalation is a visibility notification after distinct "
        "scheduled slots, not queue starvation, failed work, recovery or clearance. Only if needed, ask "
        "that owner to restore its prompt through supported controls while preserving the original "
        "decision and any replacement mapping. Never auto reissue, answer, cancel, clear guards, "
        "interrupt or create another owner's question. UI visibility is unknown; acceptance is delivery only."
        if questions else ""
    )
    diagnostic_review = ("\nQuestion capability diagnostics (no pending-decision inference): "
                         + json.dumps(question_diagnostics) if question_diagnostics else "")
    process_review = (
        "\nConfirmed owner-attested stalled resources: " + json.dumps(processes)
        + ". Ask only the exact owning parent/team to checkpoint WIP and preserve diagnostics, "
        "then safely close that exact job/start identity and report closure proof or a concrete blocker. "
        "Resource identity and progress are owner_attested; native invocation references corroborate "
        "metadata only. Do not kill, remove, cancel, restart or rerun any resource from the monitor. "
        "Preserve healthy jobs, services, protected and unknown resources, and unanswered questions. "
        "Delivery acceptance is not reported closure. Reported closure is not verified closure. "
        "Verified closure means an exact owner verification receipt corroborated by a supported "
        "successful native verification result, never a direct host probe. Exit zero, completed "
        "invocation or an absent handle alone never proves closure. Reconcile ambiguous existing "
        "requests before another request; do not duplicate accepted closure requests."
        if processes else ""
    )
    process_diagnostic_review = ("\nProcess visibility diagnostics (no stall or closure inference): "
                                 + json.dumps(process_diagnostics) if process_diagnostics else "")
    return (
        f"Scheduled monitoring review, slot {slot}. Review recent Art, Gameplay and Tech activity "
        "and these persisted queue IDs. Reconcile already handled IDs; prioritize actual user replies "
        "and dependency unblockers. Use native live steering only for confirmed unblockers. Remove an "
        "original only after confirmed delivery or reconciliation. Preserve unanswered questions and "
        "independent work; silence is not a decision. Resolve reciprocal waits with the smallest owner "
        "question. Report only new or unresolved blockers. This is a triage reminder, not permission "
        "to interrupt turns, answer questions, restart work, or duplicate deliveries.\n"
        + f"Full local inventory: {snapshot_path}\n" + inventory + worker_review + question_review + diagnostic_review + process_review + process_diagnostic_review
    )


def reconcile(client, path, coordinator, peers, slot, snapshot=None):
    if snapshot is None:
        snapshot = capture(client, path.parent, [coordinator, *peers], slot)
    snapshot = dict(snapshot, slot=slot)
    queues = {thread: [entry['id'] for entry in entries]
              for thread, entries in snapshot['queues'].items()}
    state = {"coordinator": coordinator, "slot": slot, "queues": queues,
             "snapshot_id": snapshot['snapshot_id'],
             "snapshot_path": str(path.parent / 'snapshots' / (snapshot['snapshot_id'] + '.json')),
             "requestId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"hourly-unblock:{coordinator}:{slot}"))}
    if snapshot['errors']:
        state.update(status='deferred', reason='queue inventory incomplete; inspect snapshot and retry reconciliation')
        persist(path, state)
        return state
    own_wait = any(pending_proven(coordinator, q) for q in
                   snapshot.get('question_state', {}).get(coordinator, {}).get('questions', []))
    if not decision_clear(path.parent, coordinator):
        state['waiting_on_user'] = own_wait
        state.update(status='deferred', reason='recipient-bound user-decision clearance missing, invalid or pending')
        persist(path, state)
        return state
    if accepted_inventory(path.parent, coordinator, snapshot):
        state.update(status='unchanged', reason='inventory already reminded or explicitly retained; reconcile any remaining unacknowledged work')
        persist(path, state)
        return state
    notices = question_notices(path.parent, coordinator, snapshot, slot)
    questions, state['question_notice_keys'] = question_brief(notices)
    diagnostics = [{'owner': owner, **{key: value.get(key) for key in
                    ('status', 'pending_status', 'cancelled_status', 'ui_visibility', 'diagnostics')}}
                   for owner, value in snapshot.get('question_state', {}).items()]
    # Diagnostics carry safe capability codes only, never unknown question bodies.
    if len(json.dumps(diagnostics).encode('utf-8')) > 4096:
        diagnostics = [{'reason_code': 'question_diagnostics_exceed_brief_bounds',
                        'snapshot_path': state['snapshot_path']}]
    processes = process_notices(path.parent, coordinator, snapshot)
    state['process_request_keys'] = [notice['request_key'] for notice in processes]
    process_diagnostics = [{'owner': owner, 'status': value['status'],
        'diagnostics': value.get('diagnostics', []), 'closure_receipts': [
            {field: job.get(field) for field in ('kind', 'job_id', 'start_identity', 'closure_status',
             'closure_provenance', 'closure_result_ref', 'closure_evidence_id',
             'closure_reason_code', 'closure_next_review_slot')}
            for job in value.get('jobs', []) if job.get('closure_status') not in ('none', None)]}
            for owner, value in snapshot.get('process_health', {}).items()]
    if snapshot.get('process_health_source', {}).get('status') == 'unavailable':
        process_diagnostics.append(snapshot['process_health_source'])
    if len(json.dumps(process_diagnostics).encode('utf-8')) > 4096:
        process_diagnostics = [{'reason_code': 'process_diagnostics_exceed_brief_bounds',
                                'snapshot_path': state['snapshot_path']}]
    text = reminder(slot, queues, state["snapshot_path"],
                    pending_worker_failures(path.parent, coordinator, snapshot), questions, diagnostics,
                    processes, process_diagnostics)
    for attempt in range(2):
        clearance = decision_record(path.parent, coordinator)
        selected, reason = target(client, path.parent, coordinator)
        if selected is None:
            state['waiting_on_user'] = own_wait
            state.update(status="deferred", reason=reason)
            persist(path, state)
            return state
        if not decision_clear(path.parent, coordinator) or decision_record(path.parent, coordinator) != clearance:
            state.update(status="deferred", reason="recipient-bound user-decision clearance missing, invalid or pending")
            persist(path, state)
            return state
        method = selected["method"]
        params = {"threadId": coordinator, "input": [{"type": "text", "text": text}],
                  "clientUserMessageId": state["requestId"]}
        if method == "turn/steer":
            params["expectedTurnId"] = selected["expectedTurnId"]
        if not process_request_started(path.parent, coordinator, state['process_request_keys'], state['requestId']):
            state.update(status='deferred', reason='process request has an unresolved delivery; reconcile exact existing receipt')
            persist(path, state)
            return state
        state.update(status="sending", method=method, attempt=attempt + 1)
        persist(path, state)
        try:
            response = client.call(method, params)
        except RpcError as error:
            process_request_result(path.parent, coordinator, state['process_request_keys'], state['requestId'], 'rejected')
            state.update(status="rejected", errorCode=error.code)
            persist(path, state)
            if method == "turn/steer" and error.stale_turn and attempt == 0:
                continue
            return state
        except Exception:
            process_request_result(path.parent, coordinator, state['process_request_keys'], state['requestId'], 'ambiguous')
            state.update(status="ambiguous", reason="response unavailable; do not resend")
            persist(path, state)
            return state
        turn_id = response.get("turnId") or response.get("turn", {}).get("id")
        if not isinstance(turn_id, str) or not turn_id or (
            method == "turn/steer" and turn_id != params["expectedTurnId"]
        ):
            process_request_result(path.parent, coordinator, state['process_request_keys'], state['requestId'], 'ambiguous')
            state.update(status="ambiguous", reason="unexpected acceptance response; do not resend")
            persist(path, state)
            return state
        process_request_result(path.parent, coordinator, state['process_request_keys'], state['requestId'], 'accepted')
        state.update(status="accepted", turnId=turn_id)
        persist(path, state)
        return state
    raise AssertionError("bounded attempt exhausted")


def run(state_dir, control_socket, coordinator, peers, slot, *, parents=()):
    try:
        parents = scoped_parents(parents)
    except ValueError:
        return {'status': 'deferred', 'reason': 'worker parents require unique canonical UUIDs in an active MONITOR_ROUTE_FILE'}
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / f"{coordinator}-{slot}.json"
    with (state_dir / "unblock.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "busy"}
        client = None
        snapshot = None
        try:
            if not control_socket_available(control_socket):
                with locked(state_dir):
                    snapshot = capture(None, state_dir, [coordinator, *peers], slot, parents=parents,
                                       process_prior=prior_process_observations(state_dir, coordinator))
                state = {"status": "deferred", "reason": "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path"}
                state.update(record_health(state_dir, coordinator, slot, snapshot, state))
                state['snapshot_path'] = str(state_dir / 'snapshots' / (snapshot['snapshot_id'] + '.json'))
                return state
            client = connect(time.monotonic() + 25, control_socket)
            # Inventory precedes decision guards and reminder deduplication.
            with locked(state_dir):
                snapshot = capture(client, state_dir, [coordinator, *peers], slot, parents=parents,
                                       process_prior=prior_process_observations(state_dir, coordinator))
            if path.exists():
                previous = json.loads(path.read_text())
                if previous["status"] == "sending":
                    previous.update(status="ambiguous", reason="previous send interrupted; do not resend")
                    persist(path, previous)
                state = {"status": "deduplicated", "previousStatus": previous['status']}
                health_outcome = state | {"reason": previous.get("reason")}
            else:
                state = reconcile(client, path, coordinator, peers, slot, snapshot)
                health_outcome = state
            state.update(record_health(state_dir, coordinator, slot, snapshot, health_outcome))
            state['snapshot_id'] = snapshot['snapshot_id']
            state['snapshot_path'] = str(state_dir / 'snapshots' / (snapshot['snapshot_id'] + '.json'))
            return state
        except Exception as error:
            # Never log queue contents, native error messages, or transport data.
            if path.exists():
                state = json.loads(path.read_text())
                if state.get("status") == "sending":
                    state.update(status="ambiguous", reason="send outcome unavailable; do not resend")
            else:
                reason = str(error) if isinstance(error, CapabilityError) else "native metadata unavailable"
                state = {"status": "blocked", "slot": slot, "reason": reason}
            persist(path, state)
            if snapshot is None:
                with locked(state_dir):
                    snapshot = capture(None, state_dir, [coordinator, *peers], slot, parents=parents,
                                       process_prior=prior_process_observations(state_dir, coordinator))
            state.update(record_health(state_dir, coordinator, slot, snapshot, state))
            state['snapshot_path'] = str(state_dir / 'snapshots' / (snapshot['snapshot_id'] + '.json'))
            return state
        finally:
            if client is not None:
                client.connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coordinator", type=canonical_uuid, required=True)
    parser.add_argument("--peer", type=canonical_uuid, action="append", default=[])
    parser.add_argument("--parent", type=canonical_uuid, action="append", default=[])
    parser.add_argument("--slot", type=int, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--control-socket", type=Path)
    args = parser.parse_args()
    try:
        args.parent = scoped_parents(args.parent)
    except ValueError as error:
        parser.error(str(error))
    state = run(args.state_dir, args.control_socket, str(args.coordinator), [str(peer) for peer in args.peer], args.slot,
                parents=[str(parent) for parent in args.parent])
    # Status only. Persisted queue IDs stay local for coordinator reconciliation.
    print(json.dumps({key: state[key] for key in ("status", "previousStatus", "reason", "snapshot_id", "snapshot_path", "history_status", "worker_health_status", "question_state_status", "process_health_status", "monitor_status", "monitor_reason", "recipient", "backlog_slots", "deferral_slots") if key in state}))
    return 0 if state["status"] in ("accepted", "deduplicated", "unchanged", "busy") and state.get("monitor_status") != "failed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
