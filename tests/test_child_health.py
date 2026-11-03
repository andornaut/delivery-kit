"""Offline scoped child evidence and privacy regressions."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec'))
from child_health import collect, ERROR_CLASSES

P, C, T, N = [f'00000000-0000-0000-0000-{n:012d}' for n in range(1, 5)]
PRIVATE = 'PRIVATE_NATIVE_BODY'


def row(child=C, parent=P):
    return {'id': child, 'parentThreadId': parent,
            'source': {'subAgent': {'thread_spawn': {'parent_thread_id': parent, 'depth': 1}}},
            'status': {'type': 'idle'}, 'updatedAt': 1,
            'preview': PRIVATE, 'name': PRIVATE, 'path': PRIVATE}


def turn(status='failed', code='contextWindowExceeded', identifier=T):
    return {'id': identifier, 'status': status, 'items': [{'text': PRIVATE}],
            'error': {'codexErrorInfo': code, 'message': PRIVATE, 'additionalDetails': PRIVATE}}


class Native:
    def __init__(self):
        self.calls = []
        self.child = row()
        self.turn = turn()
        self.list_pages = {False: [{'data': [row()], 'nextCursor': None}],
                           True: [{'data': [], 'nextCursor': None}]}
        self.failure = None
        self.read_count = 0
        self.turn_count = 0
        self.fresh_child = None
        self.fresh_turn = None

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if self.failure == method:
            raise RuntimeError(PRIVATE)
        if method == 'thread/list':
            assert params['parentThreadId'] == P
            assert params['sourceKinds'] == ['subAgentThreadSpawn']
            pages = self.list_pages[params['archived']]
            index = 0 if 'cursor' not in params else int(params['cursor'])
            return copy.deepcopy(pages[index])
        assert params['threadId'] == C
        if method == 'thread/read':
            assert params['includeTurns'] is False
            self.read_count += 1
            return {'thread': copy.deepcopy(self.fresh_child if self.read_count > 1 and
                                           self.fresh_child is not None else self.child)}
        if method == 'thread/turns/list':
            assert params['itemsView'] == 'notLoaded'
            assert params['sortDirection'] == 'desc' and params['limit'] == 1
            self.turn_count += 1
            latest = self.fresh_turn if self.turn_count > 1 and self.fresh_turn is not None else self.turn
            return {'data': [copy.deepcopy(latest)], 'nextCursor': 'older-private-cursor'}
        raise AssertionError(method)


class ChildHealthTests(unittest.TestCase):
    def snapshot(self, native=None, **kwargs):
        return collect(native or Native(), [P], **kwargs)[P]

    def test_typed_failures_and_private_fields_discarded(self):
        for code, classification in ERROR_CLASSES.items():
            with self.subTest(code=code):
                native = Native()
                native.turn = turn(code=code)
                snapshot = self.snapshot(native)
                child = snapshot['children'][0]
                self.assertTrue(snapshot['complete'])
                self.assertTrue(child['requires_parent_action'])
                self.assertTrue(child['lineage_verified'])
                self.assertEqual(child['classification'], classification)
                self.assertEqual(child['error_code'], code)
                self.assertEqual(child['turn_id'], T)
                self.assertNotIn(PRIVATE, json.dumps(snapshot))
                self.assertNotIn('older-private-cursor', json.dumps(snapshot))
                self.assertEqual(len(native.calls), 6)

    def test_no_status_or_untyped_error_inference(self):
        for status in ('completed', 'interrupted', 'inProgress', 'failed'):
            for code in (None, 'other', 'rateLimitExceeded', 'serverOverloaded',
                         'flexUnavailable', {'unknown': PRIVATE}, PRIVATE):
                native = Native()
                native.turn = turn(status, code)
                child = self.snapshot(native)['children'][0]
                self.assertFalse(child['requires_parent_action'])
                self.assertIsNone(child['error_code'])

    def test_waiting_retrying_and_long_busy_are_not_terminal(self):
        for flags in ([], ['waitingOnApproval'], ['waitingOnUserInput']):
            native = Native()
            native.child['status'] = {'type': 'active', 'activeFlags': flags}
            child = self.snapshot(native)['children'][0]
            self.assertFalse(child['requires_parent_action'])
            self.assertEqual(child['thread_status'], 'active')

    def test_newer_success_or_resumed_work_supersedes_failure(self):
        for status in ('completed', 'inProgress', 'interrupted'):
            native = Native()
            native.turn = turn(status)
            self.assertFalse(self.snapshot(native)['children'][0]['requires_parent_action'])
        native = Native()
        native.fresh_turn = turn('completed', identifier=N)
        snapshot = self.snapshot(native)
        self.assertEqual(snapshot['status'], 'partial')
        self.assertFalse(snapshot['children'][0]['requires_parent_action'])
        native = Native()
        native.fresh_child = row()
        native.fresh_child['updatedAt'] = 2
        self.assertFalse(self.snapshot(native)['children'][0]['requires_parent_action'])

    def test_invalid_lineage_never_reads_unrelated_child(self):
        for change in ({'parentThreadId': N}, {'parentThreadId': None},
                       {'source': {'subAgent': {'thread_spawn': {'parent_thread_id': N}}}},
                       {'id': PRIVATE}):
            native = Native()
            native.list_pages[False][0]['data'] = [row() | change]
            snapshot = self.snapshot(native)
            self.assertFalse(snapshot['complete'])
            self.assertEqual(snapshot['children'], [])
            self.assertEqual(len(native.calls), 2)
        native = Native()
        native.child['parentThreadId'] = N
        self.assertFalse(self.snapshot(native)['children'][0]['lineage_verified'])

    def test_active_and_archived_pagination_and_deduplication(self):
        native = Native()
        native.list_pages[False] = [{'data': [], 'nextCursor': '1'},
                                    {'data': [row()], 'nextCursor': None}]
        native.list_pages[True] = [{'data': [row()], 'nextCursor': None}]
        snapshot = self.snapshot(native)
        self.assertTrue(snapshot['complete'])
        self.assertEqual(len(snapshot['children']), 1)
        self.assertEqual(snapshot['inventories']['active']['pages'], 2)

    def test_partial_inventory_keeps_safe_verified_facts(self):
        native = Native()
        native.list_pages[False][0]['nextCursor'] = '1'
        snapshot = self.snapshot(native, max_pages=1)
        self.assertEqual(snapshot['status'], 'partial')
        self.assertIn('page_bound_reached', snapshot['diagnostics'])
        self.assertTrue(snapshot['children'][0]['requires_parent_action'])

    def test_partial_latest_history_never_searches_older_failures(self):
        native = Native()
        native.turn = {'id': T, 'status': PRIVATE}
        snapshot = self.snapshot(native)
        self.assertFalse(snapshot['children'][0]['requires_parent_action'])
        self.assertIn('turn_schema_unavailable', snapshot['diagnostics'])
        self.assertNotIn(PRIVATE, json.dumps(snapshot))

    def test_unavailable_reads_and_schema_are_explicit_and_private(self):
        for method in ('thread/list', 'thread/read', 'thread/turns/list'):
            native = Native()
            native.failure = method
            snapshot = self.snapshot(native)
            self.assertFalse(snapshot['complete'])
            self.assertNotIn(PRIVATE, json.dumps(snapshot))
            self.assertFalse(any(c['requires_parent_action'] for c in snapshot['children']))
        native = Native()
        native.list_pages[False] = [{'data': PRIVATE}]
        self.assertEqual(self.snapshot(native)['schema_status'], 'unknown')

    def test_repeated_cursor_and_oversized_pages_are_bounded(self):
        native = Native()
        native.list_pages[False] = [{'data': [row()], 'nextCursor': '1'},
                                    {'data': [row()], 'nextCursor': '1'}]
        snapshot = self.snapshot(native)
        self.assertIn('pagination_invalid', snapshot['diagnostics'])
        self.assertEqual(snapshot['inventories']['active']['pages'], 2)
        native = Native()
        native.list_pages[False][0]['data'] = [row()] * 51
        snapshot = self.snapshot(native)
        self.assertFalse(snapshot['complete'])
        self.assertIn('page_bound_exceeded', snapshot['diagnostics'])

    def test_conflicting_duplicate_lineage_is_excluded(self):
        native = Native()
        native.list_pages[True][0]['data'] = [row(parent=N)]
        snapshot = self.snapshot(native)
        self.assertEqual(snapshot['children'], [])
        self.assertFalse(snapshot['complete'])

    def test_empty_or_overfull_latest_turn_page_is_explicit(self):
        for data, cursor in (([], None), ([], 'private'), ([turn(), turn()], None)):
            native = Native()
            original = native.call
            def call(method, params):
                if method == 'thread/turns/list':
                    return {'data': data, 'nextCursor': cursor}
                return original(method, params)
            native.call = call
            child = self.snapshot(native)['children'][0]
            self.assertFalse(child['requires_parent_action'])
            self.assertEqual(child['complete'], data == [] and cursor is None)

    def test_invalid_scope_and_bounds_make_no_calls(self):
        for parents in ([PRIVATE], P, [P.upper() + 'x']):
            native = Native()
            with self.assertRaises(ValueError):
                collect(native, parents)
            self.assertEqual(native.calls, [])
        for bound in (0, True, 101, '10'):
            with self.assertRaises(ValueError):
                self.snapshot(max_pages=bound)

    def test_repeated_observations_keep_exact_dedup_identity_without_delivery(self):
        first = self.snapshot()['children'][0]
        second = self.snapshot()['children'][0]
        key = lambda child: tuple(child[k] for k in ('parent_id', 'child_id', 'turn_id', 'error_code'))
        self.assertEqual(key(first), key(second))
        self.assertNotIn('handled', first)
        self.assertEqual(collect(Native(), []), {})

    def test_notloaded_idle_and_system_error_without_failure_are_unknown(self):
        for status in ('notLoaded', 'idle', 'systemError'):
            native = Native()
            native.child['status'] = {'type': status}
            native.turn = turn('completed', None)
            self.assertFalse(self.snapshot(native)['children'][0]['requires_parent_action'])


if __name__ == '__main__':
    unittest.main()
