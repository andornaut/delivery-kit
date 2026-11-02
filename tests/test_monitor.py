"""Full local inventory, explicit exact-ID acknowledgement and truthful monitor health."""
import contextlib
import copy
import io
import json
import stat
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec'))
import monitor
import unblock

TECH = '00000000-0000-0000-0000-000000000001'
ART = '00000000-0000-0000-0000-000000000002'


def entry(identity):
    return {'id': identity, 'clientUserMessageId': 'client-' + identity,
            'input': [{'type': 'text', 'text': 'private payload ' + identity}]}


class NativeFixture:
    def __init__(self):
        self.queues = {TECH: [entry('one'), entry('two')], ART: [entry('art')]}
        self.calls = []
        self.delete_result = True
        self.timeout = False
        self.remove_on_error = False
        self.before_delete = lambda params: None
        self.closed = False
        self.connection = self

    def close(self):
        self.closed = True

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == 'thread/queue/list':
            offset = int(params.get('cursor', '0'))
            values = self.queues[params['threadId']]
            page = {'data': copy.deepcopy(values[offset:offset+1])}
            if offset + 1 < len(values):
                page['nextCursor'] = str(offset + 1)
            return page
        if method == 'thread/items/list':
            return {'data': []}
        if method == 'thread/queue/delete':
            self.before_delete(params)
            identity = params['queuedSubmissionId']
            if self.delete_result or self.remove_on_error:
                self.queues[params['threadId']] = [row for row in self.queues[params['threadId']] if row['id'] != identity]
            if self.timeout:
                raise TimeoutError('private transport diagnostic')
            return {'deleted': self.delete_result}
        raise AssertionError(method)

    def deletions(self):
        return [params for method, params in self.calls if method == 'thread/queue/delete']


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'unblock'
        self.state.mkdir()
        self.client = NativeFixture()
        self.snapshot = monitor.capture(self.client, self.state, [TECH, ART], 100)
        self.identity = self.snapshot['snapshot_id']

    def ack(self, identity='one', recipient=TECH, disposition='handled'):
        return monitor.acknowledge(self.client, self.state, recipient, self.identity, [identity], disposition)

    def receipt(self):
        return json.loads(next((self.state / 'acks').glob('*.json')).read_text())

    def test_snapshot_paginates_and_retains_full_payload_without_stdout_leak(self):
        self.assertEqual(self.snapshot['queues'][TECH], [entry('one'), entry('two')])
        output = io.StringIO()
        argv = ['monitor.py', 'snapshot', '--recipient', TECH, '--state-dir', str(self.state),
                '--control-socket', '/fixture/control.sock']
        with patch.object(sys, 'argv', argv), patch('codex_adapter.control_socket_available', return_value=True), \
                patch.object(unblock, 'connect', return_value=self.client), contextlib.redirect_stdout(output):
            self.assertEqual(monitor.main(), 0)
        public = json.loads(output.getvalue())
        self.assertNotIn('private payload', output.getvalue())
        self.assertEqual(public['queue_ids'], ['one', 'two'])
        self.assertEqual(stat.S_IMODE(Path(public['path']).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(Path(public['path']).parent.stat().st_mode), 0o700)
        self.assertEqual(json.loads(Path(public['path']).read_text())['queues'][TECH], [entry('one'), entry('two')])

    def test_history_refs_are_typed_paginated_and_never_store_native_message_body(self):
        original = self.client.call
        def call(method, params):
            if method == 'thread/items/list':
                self.assertNotIn('turnId', params)
                self.assertEqual(params['sortDirection'], 'desc')
                if params.get('cursor') == 'older':
                    return {'data': [{'turnId': 'answer-turn', 'item': {'id': 'answer', 'type': 'userMessage', 'content': 'private native reply'}}]}
                return {'data': [
                    {'turnId': 'question-turn', 'item': {'id': 'prompt', 'type': 'agentMessage', 'text': 'private native question', 'questions': [{}]}},
                    {'turnId': 'question-turn', 'item': {'id': 'tool', 'type': 'dynamicToolCall', 'tool': 'request_user_input'}}], 'nextCursor': 'older'}
            return original(method, params)
        self.client.call = call
        recent = monitor.capture(self.client, self.state, [TECH])
        history = recent['history'][TECH]
        self.assertEqual(history['status'], 'partial')
        self.assertEqual(history['nextCursor'], 'older')
        self.assertEqual([row['kind'] for row in history['question_refs']], ['rendered_prompt', 'question_tool'])
        older = monitor.capture(self.client, self.state, [TECH], history_cursor='older')
        self.assertEqual(older['history'][TECH]['user_reply_refs'], [{'turn_id': 'answer-turn', 'item_id': 'answer'}])
        self.assertEqual(older['history'][TECH]['status'], 'complete')
        self.assertNotIn('private native', json.dumps(recent))
        self.assertNotIn('private native', json.dumps(older))
        self.assertEqual(older['queues'][TECH], [entry('one'), entry('two')])

    def test_explicit_ack_deletes_exact_id_even_with_pending_recipient(self):
        (self.state / 'decisions').mkdir()
        monitor.persist(self.state / 'decisions' / (TECH + '.json'), {'thread_id': TECH, 'state': 'pending'})
        def before_delete(params):
            receipt = self.receipt()
            self.assertEqual(receipt['state'], 'deleting')
            self.assertEqual(receipt['disposition'], 'handled')
            self.assertEqual(params, {'threadId': TECH, 'queuedSubmissionId': 'one'})
        self.client.before_delete = before_delete
        self.assertEqual(self.ack(), [{'queue_id': 'one', 'state': 'deleted'}])
        self.assertEqual([row['id'] for row in self.client.queues[TECH]], ['two'])
        self.assertEqual(self.client.queues[ART], [entry('art')])
        self.assertEqual(len(self.client.deletions()), 1)
        self.assertFalse(any(method.startswith('turn/') for method, _ in self.client.calls))
        self.ack()
        self.assertEqual(len(self.client.deletions()), 1)

    def test_recipient_id_and_snapshot_binding_rejects_before_mutation(self):
        with self.assertRaises(ValueError):
            self.ack(recipient=ART)
        with self.assertRaises(ValueError):
            self.ack(identity='not-snapshotted')
        altered = copy.deepcopy(self.snapshot)
        altered['snapshot_id'] = str(__import__('uuid').uuid4())
        monitor.persist(self.state / 'snapshots' / (self.identity + '.json'), altered)
        with self.assertRaises(ValueError):
            self.ack()
        self.assertEqual(self.client.deletions(), [])

    def test_same_id_changed_input_or_client_id_refuses_deletion(self):
        for field, value in (('input', []), ('clientUserMessageId', 'edited')):
            self.client.queues[TECH][0] = entry('one') | {field: value}
            self.assertEqual(self.ack()[0]['state'], 'changed_payload')
            self.assertEqual(self.client.deletions(), [])

    def test_ambiguous_result_relist_and_explicit_retry_preserve_history(self):
        self.client.delete_result = False
        self.client.timeout = True
        self.assertEqual(self.ack()[0]['state'], 'ambiguous')
        self.assertEqual(len(self.client.deletions()), 1)
        self.assertEqual(self.receipt()['attempts'][0]['state'], 'ambiguous')
        self.client.timeout = False
        self.client.delete_result = True
        # A new explicit invocation re-lists and compares before its single delete.
        self.assertEqual(self.ack()[0]['state'], 'deleted')
        receipt = self.receipt()
        self.assertEqual([row['state'] for row in receipt['attempts']], ['ambiguous', 'deleted'])
        self.assertIn('ambiguous', [row['state'] for row in receipt['history']])
        self.assertEqual(len(self.client.deletions()), 2)

    def test_interrupted_or_timeout_delete_rechecks_absence_without_replay(self):
        self.client.timeout = True
        self.client.remove_on_error = True
        self.assertEqual(self.ack()[0]['state'], 'confirmed_absent')
        path = next((self.state / 'acks').glob('*.json'))
        record = self.receipt()
        record['state'] = 'deleting'
        record['attempts'][-1]['state'] = 'deleting'
        monitor.persist(path, record)
        self.assertEqual(self.ack()[0]['state'], 'confirmed_absent')
        self.assertEqual(len(self.client.deletions()), 1)
        self.assertIn('ambiguous', [row['state'] for row in self.receipt()['history']])

    def test_false_delete_requires_absence_confirmation(self):
        self.client.delete_result = False
        self.assertEqual(self.ack(disposition='superseded')[0]['state'], 'not_deleted')
        self.assertEqual(self.client.queues[TECH][0], entry('one'))
        self.client.remove_on_error = True
        self.assertEqual(self.ack(disposition='superseded')[0]['state'], 'confirmed_absent')

    def test_two_distinct_slots_fail_health_once_per_unchanged_episode(self):
        outcome = {'status': 'accepted'}
        with patch.object(monitor, 'health_event') as event:
            first = monitor.record_health(self.state, TECH, 100, self.snapshot, outcome)
            self.assertEqual(first['monitor_status'], 'ok')
            monitor.record_health(self.state, TECH, 100, self.snapshot, outcome)
            self.assertEqual(event.call_count, 0)
            second = monitor.record_health(self.state, TECH, 200, self.snapshot, {'status': 'unchanged'})
            self.assertEqual(second['monitor_status'], 'failed')
            self.assertEqual(second['backlog_slots'], 2)
            monitor.record_health(self.state, TECH, 300, self.snapshot, {'status': 'unchanged'})
            self.assertEqual(event.call_count, 1)
            self.assertTrue(monitor.accepted_inventory(self.state, TECH, self.snapshot))
            changed = copy.deepcopy(self.snapshot)
            changed['queues'][TECH] = []
            changed['queues'][ART] = []
            resolved = monitor.record_health(self.state, TECH, 400, changed, {'status': 'accepted'})
            self.assertEqual(resolved['monitor_status'], 'ok')
            monitor.record_health(self.state, TECH, 500, changed, {'status': 'deferred', 'reason': 'pending'})
            failed = monitor.record_health(self.state, TECH, 600, changed, {'status': 'deferred', 'reason': 'pending'})
            self.assertEqual(failed['monitor_status'], 'failed')
            self.assertEqual(event.call_count, 2)

    def test_retention_is_nonmutating_exact_and_invalidated_by_handled_attempt(self):
        self.client.queues[TECH] = [entry('one')]
        snap = monitor.capture(self.client, self.state, [TECH])
        result = monitor.acknowledge(self.client, self.state, TECH, snap['snapshot_id'], ['one'], 'retained', 'independent planned work')
        self.assertEqual(result[0]['state'], 'retained')
        self.assertEqual(self.client.deletions(), [])
        self.assertEqual(self.client.queues[TECH], [entry('one')])
        self.assertTrue(monitor.accepted_inventory(self.state, TECH, snap))
        with patch.object(monitor, 'health_event') as event:
            monitor.record_health(self.state, TECH, 100, snap, {'status': 'unchanged'})
            healthy = monitor.record_health(self.state, TECH, 200, snap, {'status': 'unchanged'})
            self.assertEqual(healthy['monitor_status'], 'ok')
            self.assertEqual(event.call_count, 0)
            self.client.queues[TECH][0]['input'] = []
            edited = monitor.capture(self.client, self.state, [TECH])
            self.assertFalse(monitor.accepted_inventory(self.state, TECH, edited))
            monitor.record_health(self.state, TECH, 300, edited, {'status': 'unchanged'})
            failed = monitor.record_health(self.state, TECH, 400, edited, {'status': 'unchanged'})
            self.assertEqual(failed['monitor_status'], 'failed')
        self.client.queues[TECH] = [entry('one'), entry('new-work')]
        fresh = monitor.capture(self.client, self.state, [TECH])
        queues, count = monitor.unacknowledged(self.state, fresh)
        self.assertEqual(count, 1)
        self.assertEqual([row['id'] for row in queues[TECH]], ['new-work'])
        self.client.delete_result = False
        self.assertEqual(monitor.acknowledge(self.client, self.state, TECH, fresh['snapshot_id'], ['one'], 'handled')[0]['state'], 'not_deleted')
        self.assertFalse(json.loads(monitor.retention_path(self.state, TECH, 'one').read_text())['active'])
        self.assertEqual([row['id'] for row in monitor.unacknowledged(self.state, fresh)[0][TECH]], ['one', 'new-work'])
        self.client.delete_result = True
        self.assertEqual(monitor.acknowledge(self.client, self.state, TECH, fresh['snapshot_id'], ['one'], 'handled')[0]['state'], 'deleted')
        self.assertEqual(self.client.queues[TECH], [entry('new-work')])

    def test_persistent_item_ages_through_arrivals_errors_edits_and_retention(self):
        def snapshot(identities):
            self.client.queues[TECH] = [entry(identity) for identity in identities]
            return monitor.capture(self.client, self.state, [TECH])
        def ages():
            health = json.loads((self.state / 'health' / (TECH + '.json')).read_text())
            return {identity: item['age'] for identity, item in health['backlog_items'][TECH].items()}
        outcome = {'status': 'unchanged'}
        with patch.object(monitor, 'health_event') as event:
            first = snapshot(['A'])
            monitor.record_health(self.state, TECH, 100, first, outcome)
            monitor.record_health(self.state, TECH, 100, first, outcome)
            self.assertEqual(ages(), {'A': 1})
            second = snapshot(['A', 'B'])
            result = monitor.record_health(self.state, TECH, 200, second, outcome)
            self.assertEqual(result['monitor_status'], 'failed')
            self.assertEqual(ages(), {'A': 2, 'B': 1})
            third = snapshot(['A', 'B', 'C'])
            monitor.record_health(self.state, TECH, 300, third, outcome)
            monitor.record_health(self.state, TECH, 300, third, outcome)
            self.assertEqual(ages(), {'A': 3, 'B': 2, 'C': 1})
            self.assertEqual(event.call_count, 1)
            unknown = copy.deepcopy(third)
            unknown['queues'] = {}
            unknown['errors'] = {TECH: 'inventory unavailable'}
            monitor.record_health(self.state, TECH, 400, unknown, outcome)
            self.assertEqual(ages(), {'A': 3, 'B': 2, 'C': 1})
            self.client.queues[TECH][1]['input'] = []
            changed = monitor.capture(self.client, self.state, [TECH])
            monitor.record_health(self.state, TECH, 400, changed, outcome)
            self.assertEqual(ages(), {'A': 4, 'B': 1, 'C': 2})
            monitor.acknowledge(self.client, self.state, TECH, changed['snapshot_id'], ['B'], 'retained', 'planned work')
            monitor.record_health(self.state, TECH, 400, changed, outcome)
            self.assertEqual(ages(), {'A': 4, 'C': 2})
            self.assertEqual(event.call_count, 1)
            removed = snapshot(['C'])
            monitor.record_health(self.state, TECH, 500, removed, outcome)
            self.assertEqual(ages(), {'C': 3})
            self.assertEqual(event.call_count, 1)
            same_slot_new = snapshot(['C', 'D'])
            monitor.record_health(self.state, TECH, 500, same_slot_new, outcome)
            self.assertEqual(ages(), {'C': 3, 'D': 1})
            self.client.queues[TECH][0]['input'] = []
            same_slot_edit = monitor.capture(self.client, self.state, [TECH])
            resolved = monitor.record_health(self.state, TECH, 500, same_slot_edit, outcome)
            self.assertEqual(ages(), {'C': 1, 'D': 1})
            self.assertEqual(resolved['monitor_status'], 'ok')
            self.assertEqual(event.call_count, 1)
        # Legacy aggregate counters cannot establish a queue item's past age.
        path = self.state / 'health' / (ART + '.json')
        monitor.persist(path, {'seen_slots': [100, 200], 'backlog_slots': 99})
        legacy = monitor.record_health(self.state, ART, 300, first, outcome)
        self.assertEqual(legacy['backlog_slots'], 1)

    def test_health_failure_is_nonzero_even_after_reminder_acceptance(self):
        state = {'status': 'accepted', 'monitor_status': 'failed', 'monitor_reason': 'owner reconciliation required'}
        output = io.StringIO()
        with patch.object(sys, 'argv', ['unblock.py', '--coordinator', TECH, '--slot', '100', '--state-dir', str(self.state)]), \
                patch.object(unblock, 'run', return_value=state), contextlib.redirect_stdout(output):
            self.assertEqual(unblock.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['monitor_status'], 'failed')
