"""Isolated protocol fixtures. No live daemon connection or queue mutation."""

import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import importlib.util
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "libexec"))

spec = importlib.util.spec_from_file_location("hourly_unblock", Path(__file__).resolve().parents[1] / "libexec/unblock.py")
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class Fixture:
    def __init__(self, status=None, turn=None, outcomes=None):
        self.status = status or {"type": "active", "activeFlags": []}
        self.turn = turn or {"id": "turn-one", "status": "inProgress"}
        self.calls = []
        self.outcomes = list(outcomes or [{"turnId": "turn-one"}])
        self.connection = Mock()

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "thread/queue/list":
            if params.get("cursor"):
                return {"data": [{"id": "queue-two", "input": ["private user content"]}]}
            return {"data": [{"id": "queue-one", "input": ["private user content"]}], "nextCursor": "next"}
        if method == "thread/read":
            return {"thread": {"status": self.status, "canAcceptDirectInput": True}}
        if method == "thread/turns/list":
            return {"data": [self.turn]}
        if method == "thread/items/list":
            return {"data": [{"turnId": self.turn["id"], "item": {"id": "message", "type": "agentMessage", "questions": None}}]}
        if method in ("turn/steer", "turn/start"):
            outcome = self.outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        raise AssertionError(method)

    def mutations(self):
        return [(method, params) for method, params in self.calls if method.startswith("turn/")]


class UnblockTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.path = Path(self.scratch.name) / "slot.json"
        subject.persist(self.path.parent / "pending-user-decision.json", {"state": "clear"})

    def reconcile(self, client):
        return subject.reconcile(client, self.path, "tech", ["art", "gameplay"], 100)

    def test_active_reminder_reads_all_peer_queue_pages_and_retains_only_ids(self):
        client = Fixture()
        result = self.reconcile(client)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(result["queues"], {role: ["queue-one", "queue-two"] for role in ["tech", "art", "gameplay"]})
        method, params = client.mutations()[0]
        self.assertEqual(method, "turn/steer")
        self.assertEqual(params["expectedTurnId"], "turn-one")
        self.assertEqual(len(client.mutations()), 1)
        self.assertNotIn("private user content", self.path.read_text())
        self.assertNotIn("private user content", json.dumps(params))
        self.assertNotIn("thread/queue/delete", [method for method, _ in client.calls])

    def test_completed_idle_starts_reminder_without_model_or_permission_overrides(self):
        client = Fixture(status={"type": "idle"}, turn={"id": "previous", "status": "completed"}, outcomes=[{"turn": {"id": "new"}}])
        self.assertEqual(self.reconcile(client)["status"], "accepted")
        method, params = client.mutations()[0]
        self.assertEqual(method, "turn/start")
        self.assertEqual(set(params), {"threadId", "input", "clientUserMessageId"})

    def test_questions_approvals_and_ambiguous_or_interrupted_idle_are_preserved(self):
        cases = [
            ({"type": "active", "activeFlags": ["waitingOnUserInput"]}, "inProgress"),
            ({"type": "active", "activeFlags": ["waitingOnApproval"]}, "inProgress"),
            ({"type": "active"}, "inProgress"),
            ({"type": "notLoaded"}, "completed"),
            ({"type": "idle"}, "interrupted"),
            ({"type": "idle"}, "failed"),
        ]
        for status, turn in cases:
            with self.subTest(status=status, turn=turn):
                client = Fixture(status=status, turn={"id": "previous", "status": turn})
                self.assertEqual(self.reconcile(client)["status"], "deferred")
                self.assertEqual(client.mutations(), [])

    def test_only_explicit_stale_turn_rejection_refreshes_once(self):
        stale = subject.RpcError({"code": -32600, "message": "expectedTurnId does not match active turn"})
        client = Fixture(outcomes=[stale, {"turnId": "turn-one"}])
        self.assertEqual(self.reconcile(client)["status"], "accepted")
        requests = client.mutations()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0][1]["clientUserMessageId"], requests[1][1]["clientUserMessageId"])
        self.assertEqual(len([call for call in client.calls if call[0] == "thread/read"]), 2)

    def test_timeout_and_unexpected_acceptance_never_resend(self):
        for outcome in [TimeoutError(), {}, {"turnId": "unexpected-other-turn"}]:
            with self.subTest(outcome=outcome):
                client = Fixture(outcomes=[outcome])
                self.assertEqual(self.reconcile(client)["status"], "ambiguous")
                self.assertEqual(len(client.mutations()), 1)

    def test_other_rpc_rejections_are_not_stale_retries(self):
        client = Fixture(outcomes=[subject.RpcError({"code": -32600, "message": "other error"})])
        self.assertEqual(self.reconcile(client)["status"], "rejected")
        self.assertEqual(len(client.mutations()), 1)

    def test_sending_state_is_durable_before_mutation(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            if method == "turn/steer":
                self.assertEqual(json.loads(self.path.read_text())["status"], "sending")
            return original(method, params)
        client.call = call
        self.assertEqual(self.reconcile(client)["status"], "accepted")

    def test_prior_accepted_or_interrupted_send_is_deduplicated_without_connecting(self):
        for status in ["accepted", "sending"]:
            with self.subTest(status=status):
                path = Path(self.scratch.name) / "tech-100.json"
                subject.persist(path, {"status": status})
                with patch.object(subject, "connect") as connect:
                    result = subject.run(Path(self.scratch.name), Path("/fixture/control.sock"), "tech", [], 100)
                self.assertEqual(result["status"], "deduplicated")
                self.assertEqual(result["previousStatus"], "ambiguous" if status == "sending" else status)
                connect.assert_not_called()

    def test_missing_malformed_and_pending_marker_fail_closed_without_connecting(self):
        marker = self.path.parent / "pending-user-decision.json"
        for index, content in enumerate([None, "not json", "[]", '{"state":"pending"}', '{}']):
            with self.subTest(content=content):
                # A separate scratch directory represents each independent slot installation.
                directory = self.path.parent / str(index)
                directory.mkdir()
                if content is not None:
                    (directory / marker.name).write_text(content)
                with patch.object(subject, "connect") as connect:
                    result = subject.run(directory, Path("/fixture/control.sock"), "tech", [], 100)
                self.assertEqual(result["status"], "deferred")
                connect.assert_not_called()

    def test_explicit_pending_marker_overrides_empty_active_flags(self):
        subject.persist(self.path.parent / "pending-user-decision.json", {"state": "pending"})
        client = Fixture()
        self.assertEqual(self.reconcile(client)["status"], "deferred")
        self.assertEqual(client.calls, [])

    def test_marker_is_rechecked_after_metadata_before_native_mutation(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            result = original(method, params)
            if method == "thread/turns/list":
                subject.persist(self.path.parent / "pending-user-decision.json", {"state": "pending"})
            return result
        client.call = call
        self.assertEqual(self.reconcile(client)["status"], "deferred")
        self.assertEqual(client.mutations(), [])

    def test_native_question_on_later_page_overrides_empty_flags_and_clear_marker(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            if method == "thread/items/list":
                if not params.get("cursor"):
                    return {"data": [], "nextCursor": "question-page"}
                return {"data": [{"turnId": "turn-one", "item": {
                    "id": "license-question", "type": "agentMessage",
                    "questions": [{"title": "License", "options": ["One", "Two"]}],
                }}]}
            return original(method, params)
        client.call = call
        self.assertEqual(self.reconcile(client)["status"], "deferred")
        self.assertEqual(client.mutations(), [])

    def test_unknown_truncated_compacted_or_question_tool_history_defers(self):
        cases = [
            {}, {"data": [], "truncated": True}, {"data": [], "nextCursor": ""},
            {"data": [{"turnId": "other", "item": {"id": "x", "type": "userMessage"}}]},
            {"data": [{"turnId": "turn-one", "item": {"id": "x", "type": "contextCompaction"}}]},
            {"data": [{"turnId": "turn-one", "item": {"id": "x", "type": "agentMessage"}}]},
            {"data": [{"turnId": "turn-one", "item": {"id": "x", "type": "unknown"}}]},
            {"data": [{"turnId": "turn-one", "item": {
                "id": "x", "type": "dynamicToolCall", "tool": "request_user_input_async", "status": "completed",
            }}]},
            {"data": [{"turnId": "turn-one", "item": {
                "id": "x", "type": "mcpToolCall", "status": "inProgress",
            }}]},
        ]
        for page in cases:
            with self.subTest(page=page):
                client = Fixture()
                original = client.call
                def call(method, params):
                    return page if method == "thread/items/list" else original(method, params)
                client.call = call
                self.assertEqual(self.reconcile(client)["status"], "deferred")
                self.assertEqual(client.mutations(), [])

    def test_later_user_message_does_not_prove_question_resolution(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            if method == "thread/items/list":
                return {"data": [
                    {"turnId": "turn-one", "item": {"id": "q", "type": "agentMessage", "questions": [{"title": "Choose"}]}},
                    {"turnId": "turn-one", "item": {"id": "u", "type": "userMessage", "content": []}},
                ]}
            return original(method, params)
        client.call = call
        self.assertEqual(self.reconcile(client)["status"], "deferred")
        self.assertEqual(client.mutations(), [])

    def test_unavailable_socket_defers_without_native_connection(self):
        regular = Path(self.scratch.name) / 'regular-file'
        regular.touch()
        for socket_path in (None, Path('relative.sock'), regular, regular.parent / 'missing.sock'):
            with self.subTest(path=socket_path), patch.object(subject, 'connect') as connect:
                result = subject.run(self.path.parent, socket_path, 'tech', [], 100)
                self.assertEqual(result['status'], 'deferred')
                self.assertIn('CODEX_CONTROL_SOCKET', result['reason'])
                connect.assert_not_called()

    def test_explicit_socket_is_forwarded_to_mock_transport_with_guards_intact(self):
        path = Path('/fixture/explicit-control.sock')
        fixture = Fixture()
        with patch.object(subject, 'control_socket_available', return_value=True), \
                patch.object(subject, 'connect', return_value=fixture) as connect:
            result = subject.run(self.path.parent, path, 'tech', [], 100)
        self.assertEqual(result['status'], 'accepted')
        self.assertEqual(connect.call_args.args[1], path)
        fixture.connection.close.assert_called_once()

    def test_rpc_ignores_notifications_and_server_questions_without_answering_them(self):
        connection = Mock()
        connection.recv.side_effect = [
            json.dumps({"method": "thread/status/changed", "params": {}}),
            json.dumps({"id": 1, "method": "item/tool/requestUserInput", "params": {}}),
            json.dumps({"id": 1, "result": {"data": []}}),
        ]
        client = subject.Client(connection, time.monotonic() + 25)
        self.assertEqual(client.call("thread/queue/list", {"threadId": "tech"}), {"data": []})
        self.assertEqual(connection.send.call_count, 1)


if __name__ == "__main__":
    unittest.main()
