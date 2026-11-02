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


TECH = "00000000-0000-0000-0000-000000000001"
ART = "00000000-0000-0000-0000-000000000002"
GAMEPLAY = "00000000-0000-0000-0000-000000000003"


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
                return {"data": [{"id": "queue-two", "clientUserMessageId": "user-two", "input": ["private user content"]}]}
            return {"data": [{"id": "queue-one", "clientUserMessageId": "user-one", "input": ["private user content"]}], "nextCursor": "next"}
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
        (self.path.parent / "decisions").mkdir()
        self.decision = self.path.parent / "decisions" / f"{TECH}.json"
        subject.persist(self.decision, {"thread_id": TECH, "state": "clear"})
        # Legacy evidence is neither consulted nor modified by recipient guards.
        self.legacy = self.path.parent / "pending-user-decision.json"
        subject.persist(self.legacy, {"state": "pending"})

    def reconcile(self, client):
        return subject.reconcile(client, self.path, TECH, [ART, GAMEPLAY], 100)

    def test_active_reminder_reads_all_peer_queue_pages_and_retains_only_ids(self):
        client = Fixture()
        result = self.reconcile(client)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(result["queues"], {role: ["queue-one", "queue-two"] for role in [TECH, ART, GAMEPLAY]})
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

    def test_prior_accepted_or_interrupted_send_still_snapshots_without_resending(self):
        for status in ["accepted", "sending"]:
            with self.subTest(status=status):
                path = Path(self.scratch.name) / f"{TECH}-100.json"
                subject.persist(path, {"status": status})
                fixture = Fixture()
                with patch.object(subject, 'control_socket_available', return_value=True), \
                        patch.object(subject, "connect", return_value=fixture):
                    result = subject.run(Path(self.scratch.name), Path("/fixture/control.sock"), TECH, [], 100)
                self.assertEqual(result["status"], "deduplicated")
                self.assertEqual(result["previousStatus"], "ambiguous" if status == "sending" else status)
                self.assertEqual(fixture.mutations(), [])
                self.assertTrue(Path(result['snapshot_path']).is_file())

    def test_missing_malformed_mismatched_and_unknown_recipient_records_fail_closed(self):
        contents = [None, "not json", "[]", '{}',
                    json.dumps({"thread_id": TECH, "state": "pending"}),
                    json.dumps({"thread_id": ART, "state": "clear"}),
                    json.dumps({"thread_id": TECH, "state": "unknown"})]
        for index, content in enumerate(contents):
            with self.subTest(content=content):
                directory = self.path.parent / str(index)
                (directory / 'decisions').mkdir(parents=True)
                if content is not None:
                    (directory / 'decisions' / f'{TECH}.json').write_text(content)
                subject.persist(directory / 'pending-user-decision.json', {'state': 'clear'})
                fixture = Fixture()
                with patch.object(subject, 'control_socket_available', return_value=True), \
                        patch.object(subject, "connect", return_value=fixture):
                    result = subject.run(directory, Path("/fixture/control.sock"), TECH, [], 100)
                self.assertEqual(result["status"], "deferred")
                self.assertEqual(fixture.mutations(), [])
                self.assertIn(TECH, json.loads(Path(result['snapshot_path']).read_text())['queues'])
                self.assertEqual(json.loads((directory / 'pending-user-decision.json').read_text()), {'state': 'clear'})

    def test_art_pending_does_not_block_tech_clear_or_modify_legacy_evidence(self):
        art_record = self.path.parent / 'decisions' / f'{ART}.json'
        subject.persist(art_record, {'thread_id': ART, 'state': 'pending'})
        before = {path: path.read_bytes() for path in (self.decision, art_record, self.legacy)}
        client = Fixture()
        self.assertEqual(self.reconcile(client)['status'], 'accepted')
        self.assertEqual(client.mutations()[0][1]['threadId'], TECH)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_non_uuid_recipient_is_never_clear(self):
        self.assertFalse(subject.decision_clear(self.path.parent, '../other'))
        self.assertFalse(subject.decision_clear(self.path.parent, 'tech'))

    def test_explicit_pending_marker_overrides_empty_active_flags(self):
        subject.persist(self.decision, {"thread_id": TECH, "state": "pending"})
        client = Fixture()
        self.assertEqual(self.reconcile(client)["status"], "deferred")
        self.assertEqual(client.mutations(), [])

    def test_marker_is_rechecked_after_metadata_before_native_mutation(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            result = original(method, params)
            if method == "thread/turns/list":
                subject.persist(self.decision, {"thread_id": TECH, "state": "pending"})
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
                result = subject.run(self.path.parent, socket_path, TECH, [], 100)
                self.assertEqual(result['status'], 'deferred')
                self.assertIn('CODEX_CONTROL_SOCKET', result['reason'])
                connect.assert_not_called()

    def test_explicit_socket_is_forwarded_to_mock_transport_with_guards_intact(self):
        path = Path('/fixture/explicit-control.sock')
        fixture = Fixture()
        with patch.object(subject, 'control_socket_available', return_value=True), \
                patch.object(subject, 'connect', return_value=fixture) as connect:
            result = subject.run(self.path.parent, path, TECH, [], 100)
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
        self.assertEqual(client.call("thread/queue/list", {"threadId": TECH}), {"data": []})
        self.assertEqual(connection.send.call_count, 1)

    def test_omitted_optional_questions_defaults_to_no_question(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            if method == 'thread/items/list':
                return {'data': [{'turnId': 'turn-one', 'item': {'id': 'message', 'type': 'agentMessage', 'text': 'fixture'}}]}
            return original(method, params)
        client.call = call
        self.assertEqual(self.reconcile(client)['status'], 'accepted')

    def test_exact_answer_attestation_resolves_only_its_bound_question(self):
        resolution = {'question_turn_id': 'turn-one', 'question_item_id': 'question',
                      'answer_turn_id': 'answer-turn', 'answer_item_id': 'answer'}
        subject.persist(self.decision, {'thread_id': TECH, 'state': 'clear', 'resolutions': [resolution]})
        def fixture(answer_type='userMessage', answer_turn='answer-turn', extra_question=False):
            client = Fixture()
            original = client.call
            def call(method, params):
                if method == 'thread/items/list':
                    self.assertEqual(params['threadId'], TECH)
                    if params['turnId'] == 'answer-turn':
                        return {'data': [{'turnId': answer_turn, 'item': {'id': 'answer', 'type': answer_type}}]}
                    items = [{'turnId': 'turn-one', 'item': {'id': 'question', 'type': 'agentMessage', 'questions': [{'title': 'choose'}]}}]
                    if extra_question:
                        items.append({'turnId': 'turn-one', 'item': {'id': 'new-question', 'type': 'dynamicToolCall', 'tool': 'request_user_input'}})
                    return {'data': items}
                return original(method, params)
            client.call = call
            return client
        self.assertEqual(self.reconcile(fixture())['status'], 'accepted')
        for client in (fixture(answer_type='agentMessage'), fixture(answer_turn='wrong-turn'), fixture(answer_type='unknown'), fixture(extra_question=True)):
            self.assertEqual(self.reconcile(client)['status'], 'deferred')
            self.assertEqual(client.mutations(), [])
        for changed in ([resolution, resolution], [resolution | {'answer_item_id': 'missing'}],
                        [resolution | {'answer_turn_id': ''}]):
            subject.persist(self.decision, {'thread_id': TECH, 'state': 'clear', 'resolutions': changed})
            client = fixture()
            self.assertEqual(self.reconcile(client)['status'], 'deferred')
            self.assertEqual(client.mutations(), [])

    def test_unrelated_old_resolution_does_not_fetch_or_poison_current_clear_turn(self):
        subject.persist(self.decision, {'thread_id': TECH, 'state': 'clear', 'resolutions': [
            {'question_turn_id': 'old-unavailable', 'question_item_id': 'old-question',
             'answer_turn_id': 'old-answer', 'answer_item_id': 'old-reply'}]})
        client = Fixture()
        self.assertEqual(self.reconcile(client)['status'], 'accepted')
        self.assertTrue(all(params.get('turnId') in (None, 'turn-one') for method, params in client.calls if method == 'thread/items/list'))

    def test_same_turn_answer_must_follow_exact_question(self):
        resolution = {'question_turn_id': 'turn-one', 'question_item_id': 'question',
                      'answer_turn_id': 'turn-one', 'answer_item_id': 'answer'}
        subject.persist(self.decision, {'thread_id': TECH, 'state': 'clear', 'resolutions': [resolution]})
        for answer_first in (True, False):
            client = Fixture()
            original = client.call
            def call(method, params):
                if method == 'thread/items/list':
                    items = [{'turnId': 'turn-one', 'item': {'id': 'question', 'type': 'agentMessage', 'questions': [{}]}},
                             {'turnId': 'turn-one', 'item': {'id': 'answer', 'type': 'userMessage'}}]
                    return {'data': items[::-1] if answer_first else items}
                return original(method, params)
            client.call = call
            self.assertEqual(self.reconcile(client)['status'], 'deferred' if answer_first else 'accepted')


if __name__ == "__main__":
    unittest.main()
