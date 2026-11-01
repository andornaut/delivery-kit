#!/usr/bin/python3
"""Send one slot-scoped coordinator reminder through the existing local Codex server."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import time
import uuid

CONTROL_SOCKET = Path.home() / ".codex/app-server-control/app-server-control.sock"


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


def connect(deadline):
    try:
        import websocket
    except ModuleNotFoundError as error:
        raise CapabilityError("websocket-client unavailable for /usr/bin/python3") from error

    transport = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    transport.settimeout(min(5, max(0, deadline - time.monotonic())))
    try:
        transport.connect(str(CONTROL_SOCKET))
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


def decision_clear(state_dir):
    # Only the coordinator owns this marker. Missing or unknown state is not clearance.
    try:
        marker = json.loads((state_dir / "pending-user-decision.json").read_text())
    except (OSError, ValueError):
        return False
    return isinstance(marker, dict) and marker.get("state") == "clear"


def queue_ids(client, thread):
    identifiers = []
    cursors = set()
    cursor = None
    while True:
        params = {"threadId": thread, "limit": 100}
        if cursor is not None:
            params["cursor"] = cursor
        page = client.call("thread/queue/list", params)
        identifiers.extend(entry["id"] for entry in page["data"])
        cursor = page.get("nextCursor")
        if cursor is None:
            return list(dict.fromkeys(identifiers))
        if cursor in cursors:
            raise ValueError("queue pagination did not advance")
        cursors.add(cursor)


def native_questions_clear(client, coordinator, turn_id):
    cursor = None
    cursors = set()
    known = {
        "agentMessage", "commandExecution", "dynamicToolCall", "enteredReviewMode",
        "exitedReviewMode", "fileChange", "functionCallOutput", "hookPrompt", "imageGeneration",
        "imageView", "mcpToolCall", "plan", "reasoning", "sleep", "subAgentActivity",
        "collabAgentToolCall", "userMessage", "webSearch",
    }
    try:
        while True:
            params = {"threadId": coordinator, "turnId": turn_id, "limit": 100, "sortDirection": "asc"}
            if cursor is not None:
                params["cursor"] = cursor
            page = client.call("thread/items/list", params)
            if not isinstance(page, dict) or not isinstance(page.get("data"), list):
                return False
            if page.get("truncated") or page.get("hasMore"):
                return False
            for entry in page["data"]:
                if not isinstance(entry, dict) or entry.get("turnId") != turn_id:
                    return False
                item = entry.get("item")
                if not isinstance(item, dict) or not item.get("id") or item.get("type") not in known:
                    return False
                if item["type"] == "agentMessage":
                    # The native schema has no resolved-question linkage. Do not infer an answer.
                    if "questions" not in item or item["questions"] not in (None, []):
                        return False
                if item["type"] in ("dynamicToolCall", "functionCallOutput"):
                    tool = str(item.get("tool", item.get("name", ""))).lower().replace("_", "")
                    if "requestuserinput" in tool or "askuserquestion" in tool or "elicitation" in tool:
                        return False
                if item["type"] == "mcpToolCall" and item.get("status") != "completed":
                    return False
            cursor = page.get("nextCursor")
            if cursor is None:
                return True
            if not isinstance(cursor, str) or not cursor or cursor in cursors:
                return False
            cursors.add(cursor)
    except Exception:
        return False


def target(client, coordinator):
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
    if latest and not native_questions_clear(client, coordinator, latest["id"]):
        return None, "native question history pending, incomplete, or unknown"
    if status.get("type") == "active" and latest and latest["status"] == "inProgress":
        return {"method": "turn/steer", "expectedTurnId": latest["id"]}, None
    if status.get("type") == "idle" and latest and latest["status"] == "completed":
        return {"method": "turn/start"}, None
    return None, "coordinator state ambiguous or interrupted; no automatic resume"


def reminder(slot, queues):
    inventory = "\n".join(f"{thread}: {','.join(ids) if ids else 'none'}" for thread, ids in queues.items())
    return (
        f"Hourly unblock review, scheduled slot {slot}. Review recent Art, Gameplay and Tech activity "
        "and these persisted queue IDs. Reconcile already handled IDs; prioritize actual user replies "
        "and dependency unblockers. Use native live steering only for confirmed unblockers. Remove an "
        "original only after confirmed delivery or reconciliation. Preserve unanswered questions and "
        "independent work; silence is not a decision. Resolve reciprocal waits with the smallest owner "
        "question. Report only new or unresolved blockers. This is a triage reminder, not permission "
        "to interrupt turns, answer questions, restart work, or duplicate deliveries.\n" + inventory
    )


def reconcile(client, path, coordinator, peers, slot):
    if not decision_clear(path.parent):
        state = {"status": "deferred", "slot": slot,
                 "reason": "explicit user-decision clearance missing or pending"}
        persist(path, state)
        return state
    queues = {thread: queue_ids(client, thread) for thread in dict.fromkeys([coordinator, *peers])}
    state = {"coordinator": coordinator, "slot": slot, "queues": queues,
             "requestId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"hourly-unblock:{coordinator}:{slot}"))}
    text = reminder(slot, queues)
    for attempt in range(2):
        selected, reason = target(client, coordinator)
        if selected is None:
            state.update(status="deferred", reason=reason)
            persist(path, state)
            return state
        if not decision_clear(path.parent):
            state.update(status="deferred", reason="explicit user-decision clearance missing or pending")
            persist(path, state)
            return state
        method = selected["method"]
        params = {"threadId": coordinator, "input": [{"type": "text", "text": text}],
                  "clientUserMessageId": state["requestId"]}
        if method == "turn/steer":
            params["expectedTurnId"] = selected["expectedTurnId"]
        state.update(status="sending", method=method, attempt=attempt + 1)
        persist(path, state)
        try:
            response = client.call(method, params)
        except RpcError as error:
            state.update(status="rejected", errorCode=error.code)
            persist(path, state)
            if method == "turn/steer" and error.stale_turn and attempt == 0:
                continue
            return state
        except Exception:
            state.update(status="ambiguous", reason="response unavailable; do not resend")
            persist(path, state)
            return state
        turn_id = response.get("turnId") or response.get("turn", {}).get("id")
        if not isinstance(turn_id, str) or not turn_id or (
            method == "turn/steer" and turn_id != params["expectedTurnId"]
        ):
            state.update(status="ambiguous", reason="unexpected acceptance response; do not resend")
            persist(path, state)
            return state
        state.update(status="accepted", turnId=turn_id)
        persist(path, state)
        return state
    raise AssertionError("bounded attempt exhausted")


def run(state_dir, coordinator, peers, slot):
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / f"{coordinator}-{slot}.json"
    with (state_dir / "unblock.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "busy"}
        if path.exists():
            state = json.loads(path.read_text())
            if state["status"] == "sending":
                state.update(status="ambiguous", reason="previous send interrupted; do not resend")
                persist(path, state)
            return {"status": "deduplicated", "previousStatus": state["status"]}
        client = None
        try:
            if not decision_clear(state_dir):
                state = {"status": "deferred", "slot": slot,
                         "reason": "explicit user-decision clearance missing or pending"}
                persist(path, state)
                return state
            client = connect(time.monotonic() + 25)
            return reconcile(client, path, coordinator, peers, slot)
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
            return state
        finally:
            if client is not None:
                client.connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coordinator", type=uuid.UUID, required=True)
    parser.add_argument("--peer", type=uuid.UUID, action="append", default=[])
    parser.add_argument("--slot", type=int, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    args = parser.parse_args()
    state = run(args.state_dir, str(args.coordinator), [str(peer) for peer in args.peer], args.slot)
    # Status only. Persisted queue IDs stay local for coordinator reconciliation.
    print(json.dumps({key: state[key] for key in ("status", "previousStatus", "reason") if key in state}))
    return 0 if state["status"] in ("accepted", "deduplicated", "busy") else 1


if __name__ == "__main__":
    raise SystemExit(main())
