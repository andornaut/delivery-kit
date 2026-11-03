"""Offline scoped child evidence and privacy regressions."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import time

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
        self.list_pages = {False: [{'data': [self.child], 'nextCursor': None}],
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
            return {'thread': copy.deepcopy(self.fresh_child if self.read_count >= 1 and
                                           self.fresh_child is not None else self.child)}
        if method == 'thread/turns/list':
            assert params['itemsView'] == 'notLoaded'
            assert params['sortDirection'] == 'desc' and params['limit'] == 1
            self.turn_count += 1
            latest = self.fresh_turn if self.turn_count > 1 and self.fresh_turn is not None else self.turn
            return {'data': [copy.deepcopy(latest)], 'nextCursor': 'older-private-cursor'}
        raise AssertionError(method)


class ScopedNative:
    def __init__(self, sizes, failures=0):
        self.parents = [f'00000000-0000-0000-0001-{n:012d}' for n in range(len(sizes))]
        self.rows = {}
        self.turns = {}
        self.calls = []
        self.children = {}
        for i, (parent, size) in enumerate(zip(self.parents, sizes)):
            children = [f'00000000-0000-0000-0002-{i * 1000 + n:012d}' for n in range(size)]
            self.children[parent] = children
            for n, child in enumerate(children):
                self.rows[child] = row(child, parent)
                failed = i == 0 and n < failures
                self.turns[child] = turn('failed' if failed else 'completed',
                                         'serverOverloaded' if failed else None,
                                         f'00000000-0000-0000-0003-{i * 1000 + n:012d}')

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == 'thread/list':
            parent = params['parentThreadId']
            assert parent in self.parents
            assert params['sourceKinds'] == ['subAgentThreadSpawn']
            children = [] if params['archived'] else self.children[parent]
            start = int(params.get('cursor', 0))
            end = start + params['limit']
            return {'data': [copy.deepcopy(self.rows[c]) for c in children[start:end]],
                    'nextCursor': str(end) if end < len(children) else None}
        child = params['threadId']
        assert child in self.rows
        if method == 'thread/read':
            assert params['includeTurns'] is False
            return {'thread': copy.deepcopy(self.rows[child])}
        assert method == 'thread/turns/list'
        assert params == {'threadId': child, 'sortDirection': 'desc', 'limit': 1, 'itemsView': 'notLoaded'}
        return {'data': [copy.deepcopy(self.turns[child])], 'nextCursor': 'privateOlderHistory'}


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
                self.assertEqual(len(native.calls), 5)

    def test_no_status_or_untyped_error_inference(self):
        for status in ('completed', 'interrupted', 'inProgress', 'failed'):
            for code in (None, 'other', {'rateLimitExceeded': {}},
                         {'flexUnavailable': {}}, {'serverOverloaded': {}},
                         {'unknown': PRIVATE}, PRIVATE):
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
        native.fresh_child = row(parent=N)
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

    def test_shared_deadline_stops_calls_and_preserves_all_parent_results(self):
        native = Native()
        native.deadline = time.monotonic() - 1
        snapshots = collect(native, [P, N])
        self.assertEqual(native.calls, [])
        for snapshot in snapshots.values():
            self.assertEqual(snapshot['status'], 'unavailable')
            self.assertFalse(snapshot['complete'])
            self.assertIn('native_deadline_exhausted', snapshot['diagnostics'])
            self.assertEqual(snapshot['budget']['calls_used'], 0)

    def test_timeout_halts_native_work_and_marks_omissions(self):
        class TimedOut:
            def __init__(self):
                self.calls = 0
            def call(self, method, params):
                self.calls += 1
                raise TimeoutError(PRIVATE)
        native = TimedOut()
        snapshots = collect(native, [P, N])
        self.assertEqual(native.calls, 1)
        for snapshot in snapshots.values():
            self.assertIn('native_timeout', snapshot['diagnostics'])
            self.assertTrue(snapshot['budget']['exhausted'])
            self.assertNotIn(PRIVATE, json.dumps(snapshot))

    def test_all_parent_inventories_precede_child_reads_and_call_cap(self):
        class ManyParents:
            def __init__(self):
                self.calls = []
            def call(self, method, params):
                self.calls.append((method, params))
                if method == 'thread/list':
                    parent = params['parentThreadId']
                    return {'data': [] if params['archived'] else [row(parent=parent)]}
                raise RuntimeError(PRIVATE)
        native = ManyParents()
        snapshots = collect(native, [P, N])
        self.assertEqual([m for m, _ in native.calls[:4]], ['thread/list'] * 4)
        self.assertFalse(any(s['complete'] for s in snapshots.values()))
        native = Native()
        with patch('child_health.MAX_CALLS', 3):
            snapshot = self.snapshot(native)
        self.assertEqual(len(native.calls), 3)
        child = snapshot['children'][0]
        self.assertTrue(child['lineage_verified'])
        self.assertEqual(child['status'], 'partial')
        self.assertFalse(child['requires_parent_action'])
        self.assertIn('native_call_budget_exhausted', snapshot['diagnostics'])
        self.assertEqual(snapshot['budget']['max_calls'], 3)
        self.assertEqual(snapshot['counts'], {'discovered': 1, 'observed': 1, 'validated': 0, 'omitted': 0})

    def test_expiring_deadline_during_call_never_alerts(self):
        native = Native()
        native.deadline = time.monotonic() + 100
        original = native.call
        def call(method, params):
            response = original(method, params)
            if method == 'thread/read':
                native.deadline = time.monotonic() - 1
            return response
        native.call = call
        snapshot = self.snapshot(native)
        self.assertEqual(len(native.calls), 4)
        self.assertIn('native_deadline_exhausted', snapshot['diagnostics'])
        self.assertFalse(snapshot['children'][0]['requires_parent_action'])

    def test_recognized_rate_capacity_errors_require_terminal_failed_turn(self):
        for code in ('rateLimitExceeded', 'flexUnavailable', 'serverOverloaded'):
            for status in ('completed', 'interrupted', 'inProgress'):
                native = Native()
                native.turn = turn(status, code)
                child = self.snapshot(native)['children'][0]
                self.assertEqual(child['error_code'], code)
                self.assertFalse(child['requires_parent_action'])
            native = Native()
            native.turn = turn(code=code)
            native.child['status'] = {'type': 'active', 'activeFlags': ['waitingOnUserInput']}
            self.assertFalse(self.snapshot(native)['children'][0]['requires_parent_action'])

    def test_unknown_recent_error_clears_earlier_typed_metadata(self):
        native = Native()
        native.turn = turn(code='unknownFutureCode')
        child = self.snapshot(native)['children'][0]
        self.assertIsNone(child['error_code'])
        self.assertFalse(child['requires_parent_action'])
        native = Native()
        native.fresh_turn = turn(code='unknownFutureCode', identifier=N)
        child = self.snapshot(native)['children'][0]
        self.assertFalse(child['requires_parent_action'])
        self.assertEqual(child['status'], 'partial')
        self.assertIsNone(child['error_code'])
        self.assertEqual(child['turn_id'], N)

    def test_125_children_ten_parents_complete_with_eight_exact_failures(self):
        native = ScopedNative([22, 11, 12, 12, 12, 12, 11, 11, 11, 11], failures=8)
        snapshots = collect(native, native.parents)
        self.assertEqual(len(native.calls), 20 + 125 + 2 * 8)
        self.assertEqual(sum(s['counts']['observed'] for s in snapshots.values()), 125)
        self.assertEqual(sum(s['counts']['validated'] for s in snapshots.values()), 8)
        self.assertTrue(all(s['complete'] for s in snapshots.values()))
        for parent, snapshot in snapshots.items():
            count = len(native.children[parent])
            self.assertEqual(snapshot['counts'], {'discovered': count, 'observed': count,
                             'validated': 8 if parent == native.parents[0] else 0, 'omitted': 0})
        self.assertNotIn(PRIVATE, json.dumps(snapshots))
        self.assertNotIn('privateOlderHistory', json.dumps(snapshots))
        methods = [m for m, _ in native.calls]
        self.assertEqual(methods.count('thread/read'), 8)
        self.assertEqual(methods.count('thread/turns/list'), 133)

    def test_inventory_pages_round_robin_before_any_parent_second_page(self):
        native = ScopedNative([120, 120])
        with patch('child_health.MAX_CALLS', 4):
            snapshots = collect(native, native.parents)
        self.assertEqual([(p['parentThreadId'], p['archived']) for _, p in native.calls],
                         [(native.parents[0], False), (native.parents[1], False),
                          (native.parents[0], True), (native.parents[1], True)])
        for snapshot in snapshots.values():
            self.assertEqual(snapshot['counts'], {'discovered': 50, 'observed': 0, 'validated': 0, 'omitted': 50})
            self.assertFalse(snapshot['complete'])
            self.assertIn('native_call_budget_exhausted', snapshot['diagnostics'])

    def test_child_observations_round_robin_under_call_bound(self):
        native = ScopedNative([3, 3, 3])
        with patch('child_health.MAX_CALLS', 9):
            snapshots = collect(native, native.parents)
        self.assertEqual([p['threadId'] for _, p in native.calls[6:]],
                         [native.children[parent][0] for parent in native.parents])
        for snapshot in snapshots.values():
            self.assertEqual(snapshot['counts'], {'discovered': 3, 'observed': 1, 'validated': 0, 'omitted': 2})
            self.assertFalse(snapshot['complete'])

    def test_discovered_counts_include_listed_beyond_child_inspection_bound(self):
        native = ScopedNative([125])
        snapshot = collect(native, native.parents)[native.parents[0]]
        self.assertEqual(snapshot['counts'], {'discovered': 125, 'observed': 100, 'validated': 0, 'omitted': 25})
        self.assertIn('child_bound_exceeded', snapshot['diagnostics'])
        self.assertFalse(snapshot['complete'])

    def test_nonfailed_and_unknown_children_need_only_latest_turn_read(self):
        for status, code in [('completed', None), ('interrupted', None),
                             ('inProgress', 'contextWindowExceeded'), ('failed', 'unknown')]:
            native = Native()
            native.turn = turn(status, code)
            snapshot = self.snapshot(native)
            self.assertEqual([method for method, _ in native.calls],
                             ['thread/list', 'thread/list', 'thread/turns/list'])
            self.assertEqual(snapshot['counts'], {'discovered': 1, 'observed': 1, 'validated': 0, 'omitted': 0})
            self.assertFalse(snapshot['children'][0]['requires_parent_action'])

    def test_invalid_inventory_metadata_cannot_validate_failure(self):
        for key, value in [('updatedAt', None), ('updatedAt', True), ('status', {'type': 'future'})]:
            native = Native()
            native.child[key] = value
            snapshot = self.snapshot(native)
            self.assertEqual(len(native.calls), 2)
            self.assertEqual(snapshot['counts'], {'discovered': 1, 'observed': 0, 'validated': 0, 'omitted': 1})
            self.assertFalse(snapshot['complete'])
            self.assertIn('thread_schema_unavailable', snapshot['diagnostics'])

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
