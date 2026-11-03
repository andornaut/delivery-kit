"""Full local inventory, explicit exact-ID acknowledgement and truthful monitor health."""
import contextlib
import copy
import io
import json
import os
import stat
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
import types
from unittest.mock import Mock, patch

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


def empty_question_state(client, recipients, *, decision_records, max_pages=10):
    return {owner: {'status': 'complete', 'complete': True, 'questions': [],
                   'diagnostics': ['native_pending_getter_unavailable'],
                   'pending_status': 'unavailable', 'cancelled_status': 'unavailable',
                   'ui_visibility': 'unknown', 'budget': {}} for owner in recipients}


def pending_question(owner=ART):
    return {'turn_id': 'question-turn', 'item_id': 'question-item', 'question_index': 0,
            'kind': 'rendered_prompt', 'title': 'Choose the local path', 'options': ['First', 'Second'],
            'state': 'pending', 'proof_complete': True, 'proof_scope': 'latest_turn',
            'proof_refs': [{'kind': 'owner_pending_attestation', 'recipient': owner,
                           'question_turn_id': 'question-turn', 'question_item_id': 'question-item', 'question_index': 0,
                           'confirmed_at': '2026-11-03T12:00:00Z'}]}


def process_fixture(owner=ART, slot=100):
    invocation = {'thread_id': owner, 'turn_id': 'launch-turn', 'item_id': 'launch-item'}
    evidence = {'confirmed_by': owner, 'confirmed_at': '2026-11-03T12:00:00Z',
                'identity_verified': True, 'provenance': 'owner_attested', 'state': 'running',
                'confirmed_stalled': True, 'episode_id': 'episode-1'}
    identity = {'owner_parent_id': owner, 'worker_id': None, 'kind': 'process',
                'job_id': 'job-1', 'start_identity': 'start-1', 'invocation': invocation}
    sample = identity | {'slot': slot, 'provenance': 'owner_attested', 'collected_at': '2026-11-03T12:01:00Z',
                         'protected': False, 'owner_evidence': evidence}
    row = identity | {'protected': False, 'identity_provenance': 'owner_attested',
        'progress_provenance': 'owner_attested', 'lineage_verified': True, 'invocation_verified': True,
        'native_status': 'completed', 'exit_code': 0, 'state': 'stalled', 'stall_episode': 'episode-1',
        'requires_owner_action': True, 'closure_status': 'none', 'closure_provenance': None,
        'closure_result_ref': None, 'closure_evidence_id': None, 'closure_reason_code': None,
        'closure_next_review_slot': None, 'owner_evidence_ref': {'confirmed_by': owner,
          'confirmed_at': evidence['confirmed_at'], 'episode_id': 'episode-1', 'blocked_condition': None},
        'diagnostics': []}
    return {'status': 'complete', 'complete': True, 'jobs': [row], 'observations': [sample],
            'diagnostics': ['live_process_getter_unavailable'], 'budget': {}, 'omitted_jobs': 0}


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        process_environment = patch.dict(os.environ)
        process_environment.start()
        self.addCleanup(process_environment.stop)
        os.environ.pop('PROCESS_HEALTH_FILE', None)
        self.question_collector = types.SimpleNamespace(collect=Mock(side_effect=empty_question_state))
        question_module = patch.dict(sys.modules, {'question_state': self.question_collector})
        question_module.start()
        self.addCleanup(question_module.stop)
        self.state = Path(self.temp.name) / 'unblock'
        self.state.mkdir()
        route = self.state / 'route.json'
        route.write_text(json.dumps({'version': 1, 'harness': 'codex', 'state': 'active',
            'host_project_root': str(self.state), 'monitor_thread_id': TECH,
            'targets': [{'thread_id': ART, 'ownership': 'active'}]}))
        environment = patch.dict(os.environ, {'MONITOR_ROUTE_FILE': str(route)})
        environment.start()
        self.addCleanup(environment.stop)
        self.client = NativeFixture()
        self.snapshot = monitor.capture(self.client, self.state, [TECH, ART], 100)
        self.identity = self.snapshot['snapshot_id']

    def ack(self, identity='one', recipient=TECH, disposition='handled'):
        return monitor.acknowledge(self.client, self.state, recipient, self.identity, [identity], disposition)

    def receipt(self):
        return json.loads(next((self.state / 'acks').glob('*.json')).read_text())

    def manifest_path(self, jobs=None):
        path = self.state / 'process-health.json'
        path.write_text(json.dumps({'version': 1, 'jobs': [] if jobs is None else jobs}))
        return path

    def test_unset_process_feature_never_loads_or_inspects_resources(self):
        collector = Mock()
        with patch.dict(sys.modules, {'process_health': types.SimpleNamespace(collect=collector)}):
            snapshot = monitor.capture(self.client, self.state, [TECH])
        self.assertEqual(snapshot['process_health'], {})
        self.assertEqual(snapshot['process_health_source']['status'], 'disabled')
        collector.assert_not_called()
        self.assertFalse(any(method == 'thread/items/read' for method, _ in self.client.calls))

    def test_process_manifest_bad_paths_bounds_and_schema_do_not_block_queues(self):
        valid = self.manifest_path()
        oversized = self.state / 'oversized.json'
        oversized.write_bytes(b'x' * 1048577)
        alias = self.state / 'alias.json'
        alias.symlink_to(valid)
        invalid = self.state / 'invalid.json'
        invalid.write_text('{PRIVATE_BAD_JSON')
        too_many = self.manifest_path([{}] * 101)
        paths = ['relative.json', str(self.state / 'missing.json'), str(oversized), str(alias),
                 str(invalid), str(too_many)]
        collector = Mock()
        for path in paths:
            with patch.dict(os.environ, {'PROCESS_HEALTH_FILE': path}), \
                    patch.dict(sys.modules, {'process_health': types.SimpleNamespace(collect=collector)}):
                snapshot = monitor.capture(self.client, self.state, [TECH])
            self.assertFalse(snapshot['errors'])
            self.assertEqual(snapshot['queues'][TECH], [entry('one'), entry('two')])
            self.assertEqual(snapshot['process_health_source']['status'], 'unavailable')
            self.assertNotIn('PRIVATE_BAD_JSON', json.dumps(snapshot))
        collector.assert_not_called()

    def test_process_collection_explicit_route_scope_and_shared_deadline(self):
        path = self.manifest_path()
        self.client.deadline = 125.0
        def collect(client, registrations, *, allowed_parents, slot, prior_observations):
            self.assertEqual(client.deadline, 120.0)
            self.assertEqual(registrations, {'version': 1, 'jobs': []})
            self.assertEqual(allowed_parents, [TECH])
            self.assertIsNone(slot)
            self.assertIsNone(prior_observations)
            return {TECH: process_fixture(TECH), ART: process_fixture(ART)}
        with patch.dict(os.environ, {'PROCESS_HEALTH_FILE': str(path)}), \
                patch.object(monitor.time, 'monotonic', return_value=100.0), \
                patch.dict(sys.modules, {'process_health': types.SimpleNamespace(collect=collect)}):
            snapshot = monitor.capture(self.client, self.state, [TECH])
        self.assertEqual(set(snapshot['process_health']), {TECH})
        self.assertEqual(self.client.deadline, 125.0)

    def test_public_snapshot_never_loads_or_persists_process_prior_samples(self):
        path = self.manifest_path()
        sample = process_fixture(TECH)['observations'][0]
        health_path = self.state / 'health' / (TECH + '.json')
        monitor.persist(health_path, {'process_observations': [sample]})
        before = health_path.read_bytes()
        collector = Mock(return_value={TECH: process_fixture(TECH)})
        with patch.dict(os.environ, {'PROCESS_HEALTH_FILE': str(path)}), \
                patch.dict(sys.modules, {'process_health': types.SimpleNamespace(collect=collector)}):
            monitor.capture(self.client, self.state, [TECH])
        self.assertIsNone(collector.call_args.kwargs['prior_observations'])
        self.assertEqual(health_path.read_bytes(), before)

    def test_scheduled_health_stores_exact_samples_without_owner_record_mutation(self):
        first = process_fixture(TECH, 100)
        second = process_fixture(TECH, 200)
        marker = self.manifest_path()
        before = marker.read_bytes()
        first_snapshot = dict(self.snapshot, queues={TECH: []}, process_health={TECH: first})
        monitor.record_health(self.state, TECH, 100, first_snapshot, {'status': 'unchanged'})
        with patch.dict(os.environ, {'PROCESS_HEALTH_FILE': str(marker)}):
            prior = monitor.prior_process_observations(self.state, TECH)
            self.assertEqual(prior, first['observations'])
            collector = Mock(return_value={TECH: second})
            with patch.dict(sys.modules, {'process_health': types.SimpleNamespace(collect=collector)}):
                snapshot = monitor.capture(self.client, self.state, [TECH], 200, process_prior=prior)
            self.assertEqual(collector.call_args.kwargs['prior_observations'], first['observations'])
            self.assertEqual(marker.read_bytes(), before)
            snapshot['queues'] = {TECH: []}
            monitor.record_health(self.state, TECH, 200, snapshot, {'status': 'unchanged'})
            self.assertEqual(monitor.prior_process_observations(self.state, TECH), second['observations'])
            self.assertEqual(second['observations'][0]['owner_evidence']['confirmed_at'],
                             first['observations'][0]['owner_evidence']['confirmed_at'])

    def test_process_collection_cannot_restart_exhausted_shared_budget(self):
        path = self.manifest_path()
        self.client.deadline = 125.0
        def questions(client, recipients, **kwargs):
            for _ in range(256):
                client.call('thread/items/list', {'threadId': TECH})
            return empty_question_state(client, recipients, decision_records={})
        self.question_collector.collect.side_effect = questions
        def processes(client, *args, **kwargs):
            self.assertEqual(client.deadline, 120.0)
            client.call('thread/items/read', {'threadId': TECH})
        with patch.dict(os.environ, {'PROCESS_HEALTH_FILE': str(path)}), \
                patch.object(monitor.time, 'monotonic', return_value=100.0), \
                patch.dict(sys.modules, {'process_health': types.SimpleNamespace(collect=processes)}):
            snapshot = monitor.capture(self.client, self.state, [TECH])
        self.assertEqual(snapshot['collection_budget']['calls_used'], 256)
        self.assertEqual(snapshot['process_health'][TECH]['status'], 'unavailable')
        self.assertFalse(any(method == 'thread/items/read' for method, _ in self.client.calls))
        self.assertEqual(self.client.deadline, 125.0)

    def test_real_process_collector_public_and_scheduled_provenance_and_closure(self):
        import process_health as dependency
        from datetime import datetime, timezone
        now, slot = 1800000030, 1800000000
        stamp = datetime.fromtimestamp(now - 10, timezone.utc).isoformat()
        invocation = {'thread_id': TECH, 'turn_id': 'launch-turn', 'item_id': 'launch-item'}
        job = {'owner_parent_id': TECH, 'worker_id': None, 'kind': 'process', 'job_id': 'job-1',
               'start_identity': 'start-1', 'invocation': invocation,
               'owner_evidence': {'confirmed_by': TECH, 'confirmed_at': stamp, 'identity_verified': True,
                   'provenance': 'owner_attested', 'state': 'running', 'confirmed_stalled': True,
                   'episode_id': 'episode-1'}}
        path = self.manifest_path([job])
        original = self.client.call
        def call(method, params):
            if method == 'thread/items/read':
                self.assertEqual(params, {'threadId': TECH, 'turnId': 'launch-turn', 'itemIds': ['launch-item']})
                return {'data': [{'turnId': 'launch-turn', 'item': {'id': 'launch-item',
                    'type': 'commandExecution', 'status': 'completed', 'exitCode': 0,
                    'command': 'PRIVATE_COMMAND', 'aggregatedOutput': 'PRIVATE_COMMAND'}}]}
            return original(method, params)
        self.client.call = call
        with patch.dict(os.environ, {'PROCESS_HEALTH_FILE': str(path)}), \
                patch.object(dependency.time, 'time', return_value=now):
            public = monitor.capture(self.client, self.state, [TECH])
            self.assertEqual(public['process_health'][TECH]['observations'], [])
            self.assertEqual(public['process_health'][TECH]['jobs'][0]['state'], 'stalled')
            self.assertEqual(public['process_health'][TECH]['jobs'][0]['closure_status'], 'none')
            snapshot = monitor.capture(self.client, self.state, [TECH], slot)
            self.assertEqual(len(monitor.process_notices(self.state, TECH, snapshot)), 1)
            self.assertEqual(snapshot['process_health'][TECH]['jobs'][0]['identity_provenance'], 'owner_attested')
            sample = snapshot['process_health'][TECH]['observations'][0]
            self.assertEqual(sample['collected_at'], datetime.fromtimestamp(now, timezone.utc).isoformat())
            self.assertEqual(sample['provenance'], 'owner_attested')
            self.assertTrue(monitor.process_sample(sample, [TECH]))
            self.assertNotIn('PRIVATE_COMMAND', json.dumps(snapshot))
            with patch.object(dependency.time, 'time', return_value=now + 90):
                outside = monitor.capture(self.client, self.state, [TECH], slot)
                self.assertEqual(outside['process_health'][TECH]['observations'], [])
                self.assertEqual(len(monitor.process_notices(self.state, TECH, outside)), 1)
            job['closure'] = {key: job[key] for key in
                              ('owner_parent_id', 'kind', 'job_id', 'start_identity', 'invocation')}
            job['closure'].update(confirmed_by=TECH, confirmed_at=stamp, provenance='owner_attested',
                                  state='reported_closed', evidence_id='owner-closure-1')
            self.manifest_path([job])
            before = path.read_bytes()
            closed = monitor.capture(self.client, self.state, [TECH], slot)
            self.assertEqual(closed['process_health'][TECH]['jobs'][0]['closure_status'], 'reported_closed')
            self.assertEqual(monitor.process_notices(self.state, TECH, closed), [])
            self.assertEqual(path.read_bytes(), before)

    def test_optional_process_path_export_does_not_validate_unrelated_bus(self):
        root = Path(__file__).resolve().parents[1]
        config = self.state / 'project.conf'
        example = (root / 'examples/project.conf').read_text()
        environment = dict(os.environ, BUS_CONF=str(config), BUS_STATE_DIR=str(self.state),
                           S=str(root / 'libexec'))
        environment.pop('PROCESS_HEALTH_FILE', None)
        for declared in (False, True):
            config.write_text(example + ('\nPROCESS_HEALTH_FILE=relative-invalid-at-feature-boundary\n' if declared else ''))
            check = ('[[ $PROCESS_HEALTH_FILE == relative-invalid-at-feature-boundary ]] && '
                     '[[ $(declare -p PROCESS_HEALTH_FILE) == "declare -x "* ]]' if declared else
                     '! declare -p PROCESS_HEALTH_FILE >/dev/null 2>&1')
            result = subprocess.run(['bash', '-c', 'source "$S/bus-common.sh"; ' + check],
                                    env=environment, capture_output=True)
            self.assertEqual(result.returncode, 0)

    def test_question_state_reads_existing_records_only_and_keeps_module_flags(self):
        decisions = self.state / 'decisions'
        decisions.mkdir()
        marker = {'thread_id': ART, 'state': 'pending', 'pending_questions': []}
        path = decisions / (ART + '.json')
        path.write_text(json.dumps(marker))
        before = path.read_bytes()
        snapshot = monitor.capture(self.client, self.state, [TECH, ART])
        args, kwargs = self.question_collector.collect.call_args
        self.assertEqual(args[1], [TECH, ART])
        self.assertEqual(kwargs['decision_records'], {TECH: None, ART: marker})
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(snapshot['question_state'][ART]['ui_visibility'], 'unknown')
        self.assertIn('native_pending_getter_unavailable', snapshot['question_state'][ART]['diagnostics'])
        self.assertEqual(stat.S_IMODE((self.state / 'snapshots' / (snapshot['snapshot_id'] + '.json')).stat().st_mode), 0o600)

    def test_questions_use_explicit_recipient_route_scope_without_native_expansion(self):
        other = '00000000-0000-0000-0000-000000000099'
        self.client.queues[other] = []
        snapshot = monitor.capture(self.client, self.state, [ART, other])
        self.assertEqual(self.question_collector.collect.call_args.args[1], [ART])
        self.assertEqual(snapshot['question_state'][other]['status'], 'unavailable')
        self.assertIn('question_recipient_outside_active_route', snapshot['question_state'][other]['diagnostics'])
        self.assertEqual(set(snapshot['question_state']), {ART, other})
        self.assertEqual(set(self.question_collector.collect.call_args.kwargs['decision_records']), {ART})

    def test_worker_and_questions_share_reserved_deadline_and_call_budget(self):
        self.client.deadline = 125.0
        def questions(client, recipients, *, decision_records, max_pages=10):
            self.assertEqual(client.deadline, 120.0)
            for _ in range(256):
                client.call('thread/items/list', {'threadId': TECH})
            return empty_question_state(client, recipients, decision_records=decision_records)
        self.question_collector.collect.side_effect = questions
        def workers(client, parents):
            self.assertEqual(client.deadline, 120.0)
            client.call('thread/list', {'parentThreadId': TECH})
        with patch.object(monitor.time, 'monotonic', return_value=100.0), \
                patch.dict(sys.modules, {'child_health': types.SimpleNamespace(collect=workers)}):
            snapshot = monitor.capture(self.client, self.state, [TECH], parents=[TECH])
        self.assertEqual(snapshot['collection_budget']['calls_used'], 256)
        self.assertEqual(snapshot['collection_budget']['reason_code'], 'collection_call_budget_exhausted')
        self.assertEqual(snapshot['worker_health'][TECH]['status'], 'unavailable')
        self.assertEqual(self.client.deadline, 125.0)
        self.assertFalse(any(method == 'thread/list' for method, _ in self.client.calls))

    def test_question_failure_reports_visibility_without_queue_failure_or_raw_errors(self):
        self.question_collector.collect.side_effect = RuntimeError('PRIVATE_NATIVE_ERROR')
        snapshot = monitor.capture(self.client, self.state, [TECH])
        snapshot['queues'] = {TECH: []}
        with patch.object(monitor, 'health_event') as event:
            for slot in (100, 200):
                health = monitor.record_health(self.state, TECH, slot, snapshot, {'status': 'accepted'})
                self.assertEqual(health['monitor_status'], 'degraded')
                self.assertEqual(health['deferral_slots'], 0)
            event.assert_not_called()
        self.assertNotIn('PRIVATE_NATIVE_ERROR', json.dumps(snapshot))
        self.assertEqual(snapshot['question_state'][TECH]['pending_status'], 'unavailable')

    def test_oversized_question_preserves_snapshot_choices_but_is_unknown(self):
        question = pending_question()
        question['options'] = ['x' * 40000, 'Second']
        value = empty_question_state(None, [ART], decision_records={})
        value[ART]['questions'] = [question]
        self.question_collector.collect.side_effect = lambda *args, **kwargs: value
        snapshot = monitor.capture(self.client, self.state, [ART])
        self.assertEqual(snapshot['question_state'][ART]['questions'][0]['options'], ['x' * 40000, 'Second'])
        self.assertEqual(snapshot['question_state'][ART]['questions'][0]['state'], 'unknown')
        self.assertEqual(monitor.question_notices(self.state, TECH, snapshot), [])
        self.assertIn('question_text_exceeds_reminder_bounds', snapshot['question_state'][ART]['diagnostics'])

    def test_real_collector_partial_old_history_and_complete_current_proof(self):
        import importlib.util
        from datetime import datetime, timezone
        spec = importlib.util.spec_from_file_location('question_dependency',
            Path(__file__).resolve().parents[1] / 'libexec/question_state.py')
        dependency = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dependency)
        question = {'turnId': 'current', 'item': {'id': 'prompt', 'type': 'agentMessage',
                    'text': 'PRIVATE_UNRELATED_BODY',
                    'questions': [{'title': 'Choose a local path', 'options': ['First', 'Second']}]}}
        compact = {'turnId': 'older', 'item': {'id': 'old-compaction', 'type': 'contextCompaction'}}
        marker = {'thread_id': TECH, 'state': 'pending', 'pending_questions': [{
            'question_turn_id': 'current', 'question_item_id': 'prompt', 'question_index': 0,
            'title': 'Choose a local path', 'options': ['First', 'Second'],
            'confirmed_pending': True, 'confirmed_at': datetime.now(timezone.utc).isoformat()}]}
        monitor.persist(self.state / 'decisions' / (TECH + '.json'), marker)
        original = self.client.call
        incomplete = [False]
        def call(method, params):
            if method == 'thread/read':
                return {'thread': {'id': TECH, 'updatedAt': 1,
                        'status': {'type': 'active', 'activeFlags': ['waitingOnUserInput']}}}
            if method == 'thread/turns/list':
                return {'data': [{'id': 'current', 'status': 'inProgress'}]}
            if method == 'thread/items/list':
                if 'turnId' in params:
                    return {'data': [question], 'truncated': incomplete[0]}
                return {'data': [question, compact]}
            return original(method, params)
        self.client.call = call
        with patch.dict(sys.modules, {'question_state': dependency}):
            snapshot = monitor.capture(self.client, self.state, [TECH], 100)
            value = snapshot['question_state'][TECH]
            self.assertEqual(value['status'], 'partial')
            self.assertFalse(value['complete'])
            self.assertTrue(value['latest_turn_proof']['complete'])
            self.assertTrue(value['questions'][0]['proof_complete'])
            self.assertEqual(len(monitor.question_notices(self.state, ART, snapshot, 100)), 1)
            self.assertNotIn('PRIVATE_UNRELATED_BODY', json.dumps(snapshot))
            incomplete[0] = True
            snapshot = monitor.capture(self.client, self.state, [TECH], 200)
            self.assertFalse(snapshot['question_state'][TECH]['latest_turn_proof']['complete'])
            self.assertEqual(snapshot['question_state'][TECH]['questions'][0]['state'], 'unknown')
            self.assertEqual(monitor.question_notices(self.state, ART, snapshot, 200), [])
        self.assertEqual(json.loads((self.state / 'decisions' / (TECH + '.json')).read_text()), marker)

    def test_child_budget_follows_inventory_reserves_delivery_and_restores_deadline(self):
        import types
        clock = [100.0]
        self.client.deadline = 125.0
        original = self.client.call
        def inventory(method, params):
            self.assertEqual(self.client.deadline, 125.0)
            clock[0] += 1
            return original(method, params)
        self.client.call = inventory
        def slow_collector(client, parents):
            self.assertEqual(parents, [TECH])
            self.assertEqual(client.deadline, 120.0)
            self.assertTrue(any(method == 'thread/items/list' for method, _ in self.client.calls))
            self.assertTrue(any(method == 'thread/queue/list' for method, _ in self.client.calls))
            clock[0] = client.deadline
            raise TimeoutError('PRIVATE_BUDGET_DETAIL')
        collector = types.SimpleNamespace(collect=__import__('unittest.mock').mock.Mock(side_effect=slow_collector))
        with patch.dict(sys.modules, {'child_health': collector}), \
                patch.object(monitor.time, 'monotonic', side_effect=lambda: clock[0]):
            snapshot = monitor.capture(self.client, self.state, [TECH], parents=[TECH])
        self.assertEqual(snapshot['queues'][TECH], [entry('one'), entry('two')])
        self.assertEqual(snapshot['history'][TECH]['status'], 'complete')
        self.assertFalse(snapshot['errors'])
        self.assertEqual(self.client.deadline, 125.0)
        self.assertEqual(self.client.deadline - clock[0], 5.0)
        self.assertEqual(snapshot['worker_health'][TECH]['status'], 'unavailable')
        self.assertNotIn('PRIVATE_BUDGET_DETAIL', json.dumps(snapshot))
        collector.collect.side_effect = RuntimeError('PRIVATE_COLLECTOR_ERROR')
        with patch.dict(sys.modules, {'child_health': collector}), \
                patch.object(monitor.time, 'monotonic', return_value=100.0):
            monitor.worker_health(self.client, [TECH])
        self.assertEqual(self.client.deadline, 125.0)
        collector.collect.reset_mock()
        with patch.dict(sys.modules, {'child_health': collector}), \
                patch.object(monitor.time, 'monotonic', return_value=121.0):
            unavailable = monitor.worker_health(self.client, [TECH])
        collector.collect.assert_not_called()
        self.assertEqual(self.client.deadline, 125.0)
        self.assertEqual(unavailable[TECH]['diagnostics'],
                         [{'reason_code': 'collector_budget_exhausted'}])

    def test_reviewed_collector_dependency_produces_safe_failure_and_timeout_metadata(self):
        child = '00000000-0000-0000-0000-000000000003'
        failed_turn = '00000000-0000-0000-0000-000000000004'
        original = self.client.call
        def call(method, params):
            if method == 'thread/list':
                self.assertEqual(params['parentThreadId'], TECH)
                return {'data': [] if params['archived'] else [
                    {'id': child, 'parentThreadId': TECH,
                     'status': {'type': 'idle'}, 'updatedAt': 1}]}
            if method == 'thread/read':
                self.assertEqual(params['threadId'], child)
                return {'thread': {'id': child, 'parentThreadId': TECH,
                                   'status': {'type': 'idle'}, 'updatedAt': 1}}
            if method == 'thread/turns/list':
                self.assertEqual(params['threadId'], child)
                return {'data': [{'id': failed_turn, 'status': 'failed',
                    'error': {'codexErrorInfo': 'contextWindowExceeded', 'message': 'PRIVATE_BODY'}}]}
            return original(method, params)
        self.client.call = call
        snapshot = monitor.capture(self.client, self.state, [TECH], parents=[TECH])
        self.assertEqual(monitor.worker_failures(snapshot),
                         [[TECH, child, failed_turn, 'contextWindowExceeded']])
        self.assertEqual(snapshot['worker_health'][TECH]['schema_status'], 'available')
        self.assertNotIn('PRIVATE_BODY', json.dumps(snapshot))
        def timeout(method, params):
            if method == 'thread/list':
                raise TimeoutError('PRIVATE_BODY')
            return original(method, params)
        self.client.call = timeout
        snapshot = monitor.capture(self.client, self.state, [TECH], parents=[TECH])
        self.assertEqual(snapshot['worker_health'][TECH]['status'], 'unavailable')
        self.assertEqual(snapshot['worker_health'][TECH]['schema_status'], 'unknown')
        self.assertEqual(monitor.worker_failures(snapshot), [])
        self.assertNotIn('PRIVATE_BODY', json.dumps(snapshot))

    def test_parent_scope_rejects_duplicates_noncanonical_and_unowned_before_native(self):
        for parents in ([TECH, TECH], [TECH.replace('00000000', 'ABCDEFAB', 1)],
                        ['00000000-0000-0000-0000-000000000099']):
            with self.subTest(parents=parents), self.assertRaises(ValueError):
                monitor.scoped_parents(parents)
        route = Path(os.environ['MONITOR_ROUTE_FILE'])
        data = json.loads(route.read_text())
        for change in ({'state': 'held'}, {'version': 99}):
            route.write_text(json.dumps(data | change))
            with self.assertRaises(ValueError):
                monitor.scoped_parents([TECH])
        with patch.dict(os.environ, {'MONITOR_ROUTE_FILE': ''}):
            with self.assertRaises(ValueError):
                monitor.scoped_parents([TECH])
        self.assertEqual(monitor.scoped_parents([]), [])

    def test_worker_collection_is_explicit_scoped_and_failure_is_unavailable(self):
        import types
        collector = types.SimpleNamespace(collect=__import__('unittest.mock').mock.Mock())
        collector.collect.return_value = {
            TECH: {'status': 'partial', 'complete': False, 'children': [], 'diagnostics': []},
            ART: {'status': 'complete', 'complete': True, 'children': [], 'diagnostics': []}}
        with patch.dict(sys.modules, {'child_health': collector}):
            plain = monitor.capture(self.client, self.state, [TECH, ART])
            collector.collect.assert_not_called()
            self.assertEqual(plain['worker_health'], {})
            scoped = monitor.capture(self.client, self.state, [ART], parents=[TECH])
            collector.collect.assert_called_once()
            self.assertIs(collector.collect.call_args.args[0].client, self.client)
            self.assertEqual(collector.collect.call_args.args[1], [TECH])
            self.assertEqual(list(scoped['worker_health']), [TECH])
            self.assertEqual(scoped['worker_health'][TECH]['status'], 'partial')
            collector.collect.side_effect = TimeoutError('PRIVATE_ERROR')
            unavailable = monitor.capture(self.client, self.state, [ART], parents=[TECH])
        self.assertEqual(unavailable['worker_health'][TECH]['status'], 'unavailable')
        self.assertFalse(unavailable['worker_health'][TECH]['complete'])
        self.assertNotIn('PRIVATE_ERROR', json.dumps(unavailable))
        self.assertFalse(unavailable['errors'])
        self.assertFalse(self.client.deletions())
        self.assertFalse(any(method.startswith('turn/') for method, _ in self.client.calls))

    def test_worker_diagnostics_never_age_queue_starvation(self):
        snapshot = dict(self.snapshot, queues={TECH: []}, worker_health={
            TECH: {'status': 'unavailable', 'complete': False, 'children': []}})
        with patch.object(monitor, 'health_event') as event:
            for slot in (100, 100, 200):
                health = monitor.record_health(self.state, TECH, slot, snapshot, {'status': 'accepted'})
                self.assertEqual(health['worker_health_status'], 'degraded')
                self.assertEqual(health['monitor_status'], 'degraded')
                self.assertEqual(health['history_status'], 'ok')
                self.assertIn('worker metadata', health['monitor_reason'])
                self.assertEqual(health['backlog_slots'], 0)
                self.assertEqual(health['deferral_slots'], 0)
            event.assert_not_called()

    def test_worker_failure_requires_exact_lineage_action_and_latest_failed_turn(self):
        row = {'parent_id': TECH, 'child_id': ART, 'turn_id': 'failed-turn',
               'turn_status': 'failed', 'error_code': 'contextWindowExceeded',
               'lineage_verified': True, 'requires_parent_action': True}
        def snapshot(changes):
            return {'worker_health': {TECH: {'children': [row | changes]}}}
        self.assertEqual(monitor.worker_failures(snapshot({})),
                         [[TECH, ART, 'failed-turn', 'contextWindowExceeded']])
        for name, changes in (
                ('invalid lineage', {'parent_id': ART}),
                ('unverified', {'lineage_verified': False}),
                ('retrying', {'turn_status': 'inProgress'}),
                ('waiting', {'requires_parent_action': False}),
                ('long busy', {'turn_status': 'inProgress', 'requires_parent_action': False}),
                ('recovered failure', {'turn_status': 'completed'}),
                ('untyped', {'error_code': None})):
            with self.subTest(name=name):
                self.assertEqual(monitor.worker_failures(snapshot(changes)), [])

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

    def test_history_failure_diagnostics_preserve_safe_prefix_without_private_bodies(self):
        prefix = {'turnId': 'known-turn', 'item': {'id': 'known-reply', 'type': 'userMessage', 'content': 'PRIVATE_BODY'}}
        def page_client(page):
            client = NativeFixture()
            original = client.call
            def call(method, params):
                if method == 'thread/items/list':
                    if isinstance(page, Exception):
                        raise page
                    return page
                return original(method, params)
            client.call = call
            return client
        malformed = monitor.history_refs(page_client({'data': [prefix, {'item': {'text': 'PRIVATE_BODY'}}]}), TECH)
        self.assertEqual(malformed['reason_code'], 'malformed_row')
        self.assertEqual(malformed['user_reply_refs'], [{'turn_id': 'known-turn', 'item_id': 'known-reply'}])
        unknown = monitor.history_refs(page_client({'data': [prefix, {'turnId': 'unknown-turn', 'item': {'id': 'unknown', 'type': 'PRIVATE_TYPE'}}], 'nextCursor': 'older'}), TECH)
        self.assertEqual(unknown['category'], 'unknown_item')
        self.assertEqual(unknown['status'], 'unavailable')
        self.assertEqual(unknown['nextCursor'], 'older')
        compacted = monitor.history_refs(page_client({'data': [{'turnId': 'compact-turn', 'item': {'id': 'compact', 'type': 'contextCompaction'}}]}), TECH)
        self.assertEqual(compacted['category'], 'context_compaction')
        self.assertEqual(compacted['status'], 'partial')
        self.assertFalse(compacted['complete'])
        failed = monitor.history_refs(page_client(TimeoutError('PRIVATE_TRANSPORT_BODY')), TECH)
        self.assertEqual(failed['reason_code'], 'transport_failure')
        self.assertNotIn('PRIVATE_', json.dumps([malformed, unknown, compacted, failed]))
        snap = monitor.capture(page_client(TimeoutError('PRIVATE_TRANSPORT_BODY')), self.state, [TECH])
        self.assertFalse(snap['errors'])
        self.assertEqual(snap['queues'][TECH], [entry('one'), entry('two')])

    def test_compaction_preserves_both_sides_and_pagination_without_clearance(self):
        original = self.client.call
        def call(method, params):
            if method == 'thread/items/list':
                return {'data': [
                    {'turnId': 'question', 'item': {'id': 'prompt', 'type': 'agentMessage', 'questions': [{}]}},
                    {'turnId': 'compact', 'item': {'id': 'compact', 'type': 'contextCompaction', 'text': 'PRIVATE_BODY'}},
                    {'turnId': 'answer', 'item': {'id': 'reply', 'type': 'userMessage', 'content': 'PRIVATE_BODY'}}],
                    'nextCursor': 'older'}
            return original(method, params)
        self.client.call = call
        guard = self.state / 'decisions' / (TECH + '.json')
        monitor.persist(guard, {'thread_id': TECH, 'state': 'pending'})
        before = guard.read_bytes()
        snapshot = monitor.capture(self.client, self.state, [TECH])
        history = snapshot['history'][TECH]
        self.assertEqual(history['status'], 'partial')
        self.assertFalse(history['complete'])
        self.assertEqual(history['reason_code'], 'context_compaction')
        self.assertEqual(history['category'], 'context_compaction')
        self.assertEqual(history['nextCursor'], 'older')
        self.assertEqual(history['question_refs'], [{'turn_id': 'question', 'item_id': 'prompt', 'kind': 'rendered_prompt'}])
        self.assertEqual(history['user_reply_refs'], [{'turn_id': 'answer', 'item_id': 'reply'}])
        self.assertNotIn('PRIVATE_BODY', json.dumps(snapshot))
        self.assertEqual(guard.read_bytes(), before)
        self.assertEqual(snapshot['queues'][TECH], [entry('one'), entry('two')])
        output = io.StringIO()
        argv = ['monitor.py', 'snapshot', '--recipient', TECH, '--state-dir', str(self.state),
                '--control-socket', '/fixture/control.sock']
        with patch.object(sys, 'argv', argv), patch('codex_adapter.control_socket_available', return_value=True), \
                patch.object(unblock, 'connect', return_value=self.client), contextlib.redirect_stdout(output):
            self.assertEqual(monitor.main(), 0)
        self.assertFalse(json.loads(output.getvalue())['history'][TECH]['complete'])
        self.assertEqual(guard.read_bytes(), before)

    def test_metadata_degradation_does_not_age_delivery_failures_or_hide_backlog(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['queues'] = {TECH: []}
        snapshot['history'] = {TECH: {'status': 'unavailable', 'reason_code': 'transport_failure'}}
        path = self.state / 'health' / (TECH + '.json')
        monitor.persist(path, {'seen_slots': [10, 20], 'deferral_slots': 8,
                               'monitor_status': 'failed', 'reported': True,
                               'monitor_reason': 'old failure', 'problem_signature': 'old'})
        with patch.object(monitor, 'health_event') as event:
            for slot in (100, 200):
                result = monitor.record_health(self.state, TECH, slot, snapshot, {'status': 'accepted'})
                self.assertEqual(result['monitor_status'], 'degraded')
                self.assertEqual(result['history_status'], 'degraded')
                self.assertEqual(result['deferral_slots'], 0)
                self.assertEqual(result['backlog_slots'], 0)
            self.assertFalse(json.loads(path.read_text())['reported'])
            for slot, reason in ((210, 'context_compaction'), (220, 'incomplete_page')):
                snapshot['history'][TECH] = {'status': 'partial', 'reason_code': reason}
                result = monitor.record_health(self.state, TECH, slot, snapshot, {'status': 'accepted'})
                self.assertEqual(result['monitor_status'], 'degraded')
                self.assertEqual(result['deferral_slots'], 0)
            snapshot['queues'][TECH] = [entry('one')]
            first = monitor.record_health(self.state, TECH, 300, snapshot, {'status': 'unchanged'})
            self.assertEqual(first['backlog_slots'], 1)
            failed = monitor.record_health(self.state, TECH, 400, snapshot, {'status': 'unchanged'})
            self.assertEqual(failed['monitor_status'], 'failed')
            self.assertEqual(failed['history_status'], 'degraded')
            self.assertIn('unacknowledged queue items', failed['monitor_reason'])
            self.assertNotIn('repeatedly deferred', failed['monitor_reason'])
            self.assertEqual(event.call_count, 1)
            snapshot['queues'][TECH] = []
            snapshot['history'][TECH] = {'status': 'partial', 'reason_code': 'more_history'}
            recovered = monitor.record_health(self.state, TECH, 500, snapshot, {'status': 'accepted'})
            self.assertEqual(recovered['monitor_status'], 'ok')
            self.assertEqual(recovered['history_status'], 'ok')
            self.assertNotIn('monitor_reason', json.loads(path.read_text()))

    def test_snapshot_exit_depends_on_queue_inventory_not_history_availability(self):
        original = self.client.call
        inventory_fails = False
        def call(method, params):
            if method == 'thread/items/list' or inventory_fails:
                raise TimeoutError('PRIVATE_TRANSPORT_BODY')
            return original(method, params)
        self.client.call = call
        argv = ['monitor.py', 'snapshot', '--recipient', TECH, '--state-dir', str(self.state),
                '--control-socket', '/fixture/control.sock']
        for inventory_fails in (False, True):
            output = io.StringIO()
            with patch.object(sys, 'argv', argv), patch('codex_adapter.control_socket_available', return_value=True), \
                    patch.object(unblock, 'connect', return_value=self.client), contextlib.redirect_stdout(output):
                self.assertEqual(monitor.main(), int(inventory_fails))
            public = json.loads(output.getvalue())
            self.assertEqual(public['complete'], not inventory_fails)
            self.assertEqual(public['history'][TECH]['status'], 'unavailable')
            self.assertEqual(public['queue_ids'], [] if inventory_fails else ['one', 'two'])
            self.assertNotIn('PRIVATE_TRANSPORT_BODY', output.getvalue())

    def test_queue_errors_and_delivery_deferrals_fail_even_with_degraded_history(self):
        for cause in ('inventory', 'delivery'):
            with self.subTest(cause=cause):
                snapshot = copy.deepcopy(self.snapshot)
                snapshot['queues'] = {}
                snapshot['history'] = {TECH: {'status': 'partial', 'reason_code': 'context_compaction'}}
                if cause == 'inventory':
                    snapshot['errors'] = {TECH: 'inventory incomplete'}
                outcome = {'status': 'deferred' if cause == 'delivery' else 'accepted'}
                recipient = TECH if cause == 'inventory' else ART
                with patch.object(monitor, 'health_event') as event:
                    first = monitor.record_health(self.state, recipient, 100, snapshot, outcome)
                    self.assertEqual(first['monitor_status'], 'degraded')
                    second = monitor.record_health(self.state, recipient, 200, snapshot, outcome)
                    self.assertEqual(second['monitor_status'], 'failed')
                    self.assertEqual(second['deferral_slots'], 2)
                    self.assertIn('inventory or reminder delivery', second['monitor_reason'])
                    self.assertEqual(event.call_count, 1)

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

    def test_retained_ack_confirms_absence_and_deactivates_matching_retention(self):
        monitor.acknowledge(self.client, self.state, TECH, self.identity, ['one'], 'retained', 'planned work')
        path = monitor.retention_path(self.state, TECH, 'one')
        before = json.loads(path.read_text())
        operation_before = self.receipt()
        self.client.queues[TECH] = [entry('two')]
        self.client.calls.clear()
        snapshots_before = sorted((self.state / 'snapshots').iterdir())

        result = monitor.acknowledge(self.client, self.state, TECH, self.identity, ['one'], 'retained', 'planned work')

        self.assertEqual(result, [{'queue_id': 'one', 'state': 'confirmed_absent'}])
        after = json.loads(path.read_text())
        self.assertEqual(after, before | {'active': False, 'history': before['history'] + [
            {'state': 'confirmed_absent', 'snapshot_id': self.identity}]})
        operation = self.receipt()
        self.assertEqual(operation['disposition'], 'retained')
        self.assertEqual(operation['attempts'], operation_before['attempts'])
        self.assertEqual(operation['history'][:-1], operation_before['history'])
        self.assertEqual(operation['history'][-1]['state'], 'confirmed_absent')
        self.assertEqual(self.client.deletions(), [])
        self.assertTrue(self.client.calls)
        self.assertTrue(all(method == 'thread/queue/list' for method, _ in self.client.calls))
        self.assertEqual(sorted((self.state / 'snapshots').iterdir()), snapshots_before)
        with self.assertRaises(ValueError):
            self.ack(disposition='handled')
        monitor.acknowledge(self.client, self.state, TECH, self.identity, ['one'], 'retained', 'planned work')
        self.assertEqual(json.loads(path.read_text()), after)

    def test_retained_absence_preserves_different_or_inactive_retention(self):
        original = entry('one')
        cases = (
            {'recipient': ART},
            {'queue_id': 'two'},
            {'payload_signature': monitor.payload_signature(original | {'input': []})},
            {'payload_signature': monitor.payload_signature(original | {'clientUserMessageId': 'changed'})},
            {'active': False},
        )
        self.client.queues[TECH] = [entry('two')]
        path = monitor.retention_path(self.state, TECH, 'one')
        for changes in cases:
            with self.subTest(changes=changes):
                snapshot = monitor.capture(NativeFixture(), self.state, [TECH])
                retention = {'active': True, 'recipient': TECH, 'queue_id': 'one',
                             'payload_signature': monitor.payload_signature(original),
                             'history': [{'state': 'retained', 'snapshot_id': self.identity}]} | changes
                monitor.persist(path, retention)
                result = monitor.acknowledge(self.client, self.state, TECH, snapshot['snapshot_id'],
                                             ['one'], 'retained', 'planned work')
                self.assertEqual(result[0]['state'], 'confirmed_absent')
                self.assertEqual(json.loads(path.read_text()), retention)
        self.assertEqual(self.client.deletions(), [])

    def test_retained_ack_with_present_unchanged_or_changed_identity(self):
        for changes in ({}, {'input': []}, {'clientUserMessageId': 'changed'}):
            with self.subTest(changes=changes):
                self.client.queues[TECH] = [entry('one')]
                snapshot = monitor.capture(self.client, self.state, [TECH])
                snapshot_id = snapshot['snapshot_id']
                monitor.acknowledge(self.client, self.state, TECH, snapshot_id, ['one'], 'retained', 'planned work')
                path = monitor.retention_path(self.state, TECH, 'one')
                before = json.loads(path.read_text())
                self.client.queues[TECH][0].update(changes)
                result = monitor.acknowledge(self.client, self.state, TECH, snapshot_id, ['one'], 'retained', 'planned work')
                self.assertEqual(result[0]['state'], 'changed_payload' if changes else 'retained')
                after = json.loads(path.read_text())
                self.assertTrue(after['active'])
                if changes:
                    self.assertEqual(after, before)
                self.assertNotIn('confirmed_absent', [row['state'] for row in after['history']])
        self.assertEqual(self.client.deletions(), [])

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
