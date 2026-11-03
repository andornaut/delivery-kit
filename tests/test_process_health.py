"""Offline owner-attested health and exact closure provenance fixtures."""
import copy
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec'))
import process_health as subject

P = '00000000-0000-0000-0000-000000000001'
C = '00000000-0000-0000-0000-000000000002'
OTHER = '00000000-0000-0000-0000-000000000003'
NOW = 1793682000
PRIVATE = 'PRIVATE_COMMAND_OUTPUT_ENV_OR_LOG'


def timestamp(age=60):
    return datetime.fromtimestamp(NOW-age, timezone.utc).isoformat()


def invocation(thread=C, item='launch'):
    return {'thread_id': thread, 'turn_id': 'turn-one', 'item_id': item}


def evidence(**changes):
    return {'confirmed_by': P, 'confirmed_at': timestamp(), 'identity_verified': True,
            'provenance': 'owner_attested', 'state': 'running', 'episode_id': 'episode-1'} | changes


def progress(**changes):
    return {'contract_id': 'tasks-finished', 'epoch': 'epoch-1', 'counter': 10,
            'expected_to_advance': True} | changes


def blocked(**changes):
    return {'confirmed': True, 'code': 'deadlock', 'evidence_id': 'diagnostic-1'} | changes


def job(**changes):
    return {'owner_parent_id': P, 'worker_id': C, 'kind': 'process', 'job_id': 'job-1',
            'start_identity': 'owner-start-1', 'invocation': invocation(),
            'owner_evidence': evidence()} | changes


def receipt(state, **changes):
    value = {key: value for key, value in job().items()
             if key in ('owner_parent_id', 'kind', 'job_id', 'start_identity', 'invocation')}
    return value | {'confirmed_by': P, 'confirmed_at': timestamp(), 'provenance': 'owner_attested',
                    'state': state, 'evidence_id': 'closure-1'} | changes


class Native:
    def __init__(self):
        self.deadline = 200.0
        self.calls = []
        self.failure = None
        self.parent = P
        self.source_parent = P
        self.status = 'inProgress'
        self.exit_code = None
        self.verify_status = 'completed'
        self.verify_exit = 0
        self.missing = False
        self.wrong_item = False

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if self.failure == method:
            raise PermissionError(PRIVATE)
        if method == 'thread/read':
            assert params == {'threadId': C, 'includeTurns': False}
            return {'thread': {'id': C, 'parentThreadId': self.parent,
                'source': {'subAgent': {'thread_spawn': {'parent_thread_id': self.source_parent}}},
                'preview': PRIVATE}}
        if method == 'thread/items/read':
            assert params['threadId'] in (P, C)
            assert len(params['itemIds']) == 1
            if self.missing:
                return {'data': []}
            item_id = params['itemIds'][0]
            verification = item_id == 'verification'
            return {'data': [{'turnId': params['turnId'], 'startedAtMs': 1,
                'item': {'id': 'wrong' if self.wrong_item else item_id,
                'type': 'commandExecution',
                'status': self.verify_status if verification else self.status,
                'exitCode': self.verify_exit if verification else self.exit_code,
                'command': PRIVATE, 'cwd': PRIVATE, 'aggregatedOutput': PRIVATE,
                'processId': PRIVATE, 'env': PRIVATE}}]}
        raise AssertionError('unsupported or mutating native call')


class ProcessHealthTests(unittest.TestCase):
    def collect(self, jobs=None, native=None, prior=None, slot=NOW, manifest=None, now=NOW):
        native = native or Native()
        manifest = {'version': 1, 'jobs': [job()] if jobs is None else jobs} if manifest is None else manifest
        before = copy.deepcopy(manifest)
        with patch.object(subject.time, 'time', return_value=now), \
                patch.object(subject.time, 'monotonic', return_value=100.0):
            result = subject.collect(native, manifest, allowed_parents=[P], slot=slot,
                                     prior_observations=prior)[P]
        self.assertEqual(manifest, before)
        self.assertNotIn(PRIVATE, str(result))
        self.assertEqual(native.deadline, 200.0)
        return result

    def test_running_is_owner_attested_never_liveverified_and_only_scoped_metadata_read(self):
        native = Native()
        result = self.collect(native=native)
        row = result['jobs'][0]
        self.assertEqual(row['state'], 'running')
        self.assertEqual(row['identity_provenance'], 'owner_attested')
        self.assertEqual(row['progress_provenance'], 'owner_attested')
        self.assertTrue(row['lineage_verified'])
        self.assertTrue(row['invocation_verified'])
        self.assertFalse(row['requires_owner_action'])
        self.assertIn('live_process_getter_unavailable', result['diagnostics'])
        self.assertEqual([method for method, _ in native.calls], ['thread/read', 'thread/items/read'])

    def test_explicit_fresh_owner_stall_requests_exact_job_episode_only(self):
        for kind in ('process', 'container', 'browser_job'):
            with self.subTest(kind=kind):
                value = job(kind=kind, owner_evidence=evidence(confirmed_stalled=True))
                row = self.collect([value])['jobs'][0]
                self.assertEqual(row['state'], 'stalled')
                self.assertTrue(row['requires_owner_action'])
                self.assertEqual(row['stall_episode'], 'episode-1')
                self.assertEqual(row['start_identity'], 'owner-start-1')
                self.assertEqual(row['invocation'], invocation())

    def test_protected_service_question_wait_and_terminal_never_request_closure(self):
        cases = [job(protected=True, owner_evidence=evidence(confirmed_stalled=True))]
        cases += [job(owner_evidence=evidence(state=state, confirmed_stalled=True))
                  for state in ('service', 'waiting_on_user', 'terminal', 'unknown')]
        for value in cases:
            with self.subTest(value=value):
                row = self.collect([value])['jobs'][0]
                self.assertFalse(row['requires_owner_action'])
                self.assertNotEqual(row['state'], 'stalled')

    def test_same_owner_timestamp_across_slots_is_not_new_progress_evidence(self):
        value = job(owner_evidence=evidence(progress=progress(), blocked_condition=blocked()))
        first = self.collect([value], slot=NOW, now=NOW+5)
        second = self.collect([value], slot=NOW+60, now=NOW+65, prior=first['observations'])
        self.assertFalse(first['jobs'][0]['requires_owner_action'])
        self.assertFalse(second['jobs'][0]['requires_owner_action'])
        self.assertNotEqual(second['jobs'][0]['state'], 'stalled')

    def test_two_distinct_owner_observations_need_expected_progress_and_corroborated_block(self):
        old = job(owner_evidence=evidence(confirmed_at=timestamp(1860), progress=progress(),
                                          blocked_condition=blocked()))
        prior = self.collect([old], slot=NOW-1800, now=NOW-1795)['observations']
        current = job(owner_evidence=evidence(progress=progress(), blocked_condition=blocked()))
        row = self.collect([current], slot=NOW, now=NOW+5, prior=prior)['jobs'][0]
        self.assertTrue(row['requires_owner_action'])
        self.assertEqual(row['state'], 'stalled')
        changes = [
            {'progress': progress(counter=11)}, {'progress': progress(counter=9)},
            {'progress': progress(epoch='new')}, {'progress': progress(contract_id='new')},
            {'progress': progress(expected_to_advance=False)}, {'progress': progress(counter=True)},
            {'blocked_condition': None}, {'blocked_condition': blocked(confirmed=False)},
            {'blocked_condition': blocked(evidence_id='different')}, {'episode_id': 'new'},
            {'confirmed_at': timestamp(1900)}, {'confirmed_at': timestamp(1801)},
        ]
        for change in changes:
            with self.subTest(change=change):
                fields = {'progress': progress(), 'blocked_condition': blocked()} | change
                value = job(owner_evidence=evidence(**fields))
                self.assertFalse(self.collect([value], prior=prior)['jobs'][0]['requires_owner_action'])
        self.assertFalse(self.collect([current], slot=NOW-1800, now=NOW-1795, prior=prior)['jobs'][0]['requires_owner_action'])
        changed = copy.deepcopy(prior)
        changed[0]['start_identity'] = 'reused-handle-new-start'
        self.assertFalse(self.collect([current], prior=changed)['jobs'][0]['requires_owner_action'])

    def test_prior_owner_evidence_fresh_at_capture_survives_thirty_minute_jitter(self):
        old_slot = NOW - 1800
        old = job(owner_evidence=evidence(confirmed_at=timestamp(1900),
            progress=progress(), blocked_condition=blocked()))
        prior = self.collect([old], slot=old_slot, now=old_slot+10)['observations']
        self.assertEqual(len(prior), 1)
        self.assertGreater(NOW+15 - subject._stamp(prior[0]['owner_evidence']['confirmed_at']), 1800)
        current = job(owner_evidence=evidence(progress=progress(), blocked_condition=blocked()))
        result = self.collect([current], slot=NOW, now=NOW+15, prior=prior)
        self.assertTrue(result['jobs'][0]['requires_owner_action'])
        for changes in (
                {'collected_at': timestamp(1790+60)},
                {'collected_at': timestamp(-60)},
                {'slot': old_slot+1},
                {'provenance': 'native_verified'},
                {'owner_evidence': evidence(confirmed_at=timestamp(3701),
                    progress=progress(), blocked_condition=blocked())},
                {'owner_evidence': evidence(confirmed_at=timestamp(1700),
                    progress=progress(), blocked_condition=blocked())}):
            changed = [copy.deepcopy(prior[0]) | changes]
            with self.subTest(changes=changes):
                row = self.collect([current], slot=NOW, now=NOW+15, prior=changed)['jobs'][0]
                self.assertFalse(row['requires_owner_action'])
        changed = copy.deepcopy(prior)
        changed[0].pop('collected_at')
        self.assertFalse(self.collect([current], prior=changed)['jobs'][0]['requires_owner_action'])

    def test_public_observation_none_slot_does_not_synthesize_scheduled_samples(self):
        old = job(owner_evidence=evidence(confirmed_at=timestamp(1860), progress=progress(),
                                          blocked_condition=blocked()))
        prior = self.collect([old], slot=NOW-1800, now=NOW-1795)['observations']
        current = job(owner_evidence=evidence(progress=progress(), blocked_condition=blocked()))
        result = self.collect([current], slot=None, prior=prior)
        self.assertEqual(result['observations'], [])
        self.assertFalse(result['jobs'][0]['requires_owner_action'])
        result = self.collect([job(owner_evidence=evidence(confirmed_stalled=True))], slot=None)
        self.assertTrue(result['jobs'][0]['requires_owner_action'])
        self.assertEqual(result['observations'], [])

    def test_confirmation_references_do_not_depend_on_scheduled_sample_emission(self):
        value = job(owner_evidence=evidence(confirmed_stalled=True, progress=progress(),
                                           blocked_condition=blocked(), unrelated=PRIVATE))
        expected = {'confirmed_by': P, 'confirmed_at': timestamp(), 'episode_id': 'episode-1',
                    'blocked_condition': {'code': 'deadlock', 'evidence_id': 'diagnostic-1'}}
        for slot, now in ((None, NOW), (NOW, NOW+61)):
            with self.subTest(slot=slot):
                result = self.collect([value], slot=slot, now=now)
                self.assertEqual(result['observations'], [])
                row = result['jobs'][0]
                self.assertTrue(row['requires_owner_action'])
                self.assertEqual(row['owner_evidence_ref'], expected)
                self.assertNotIn('progress', row['owner_evidence_ref'])
        native = Native()
        native.parent = OTHER
        self.assertIsNone(self.collect([value], native)['jobs'][0]['owner_evidence_ref'])
        value['owner_evidence']['confirmed_at'] = timestamp(1801)
        self.assertIsNone(self.collect([value])['jobs'][0]['owner_evidence_ref'])

    def test_stasis_duration_native_status_and_exit_never_imply_stall_or_closed(self):
        native = Native()
        native.status, native.exit_code = 'completed', 0
        row = self.collect([job(owner_evidence=evidence(progress=progress()))], native)['jobs'][0]
        self.assertEqual(row['state'], 'running')
        self.assertFalse(row['requires_owner_action'])
        self.assertEqual(row['closure_status'], 'none')
        native.missing = True
        row = self.collect(native=native)['jobs'][0]
        self.assertEqual(row['state'], 'unknown')
        self.assertEqual(row['closure_status'], 'unknown')

    def test_wrong_scope_lineage_invocation_and_missing_identity_fail_closed(self):
        native = Native()
        self.collect([job(owner_parent_id=OTHER)], native)
        self.assertEqual(native.calls, [])
        for changes in ({'start_identity': ''}, {'worker_id': OTHER}, {'kind': []},
                        {'invocation': invocation(thread=OTHER)}):
            result = self.collect([job(**changes)])
            self.assertFalse(any(row['requires_owner_action'] for row in result['jobs']))
        for field in ('parent', 'source_parent'):
            native = Native()
            setattr(native, field, OTHER)
            row = self.collect(native=native)['jobs'][0]
            self.assertFalse(row['lineage_verified'])
            self.assertFalse(row['requires_owner_action'])
        native = Native()
        native.wrong_item = True
        self.assertFalse(self.collect(native=native)['jobs'][0]['invocation_verified'])

    def test_freshness_provenance_owner_and_identity_confirmation_are_mandatory(self):
        for change in ({'confirmed_at': timestamp(1801)}, {'confirmed_at': timestamp(-1)},
                       {'confirmed_by': OTHER}, {'identity_verified': False},
                       {'provenance': 'native_verified'}, {'state': []}):
            row = self.collect([job(owner_evidence=evidence(confirmed_stalled=True, **change))])['jobs'][0]
            self.assertEqual(row['state'], 'unknown')
            self.assertFalse(row['requires_owner_action'])
        for age in (0, 1800):
            value = job(owner_evidence=evidence(confirmed_at=timestamp(age), confirmed_stalled=True))
            self.assertTrue(self.collect([value])['jobs'][0]['requires_owner_action'])

    def test_closure_outcomes_separate_delivery_report_and_ownerverified_result(self):
        for state in ('requested', 'delivery_accepted', 'ambiguous', 'reported_closed'):
            value = job(owner_evidence=evidence(confirmed_stalled=True), closure=receipt(state))
            row = self.collect([value])['jobs'][0]
            self.assertEqual(row['closure_status'], state)
            self.assertEqual(row['closure_provenance'], 'owner_attested')
            self.assertEqual(row['closure_evidence_id'], 'closure-1')
            self.assertEqual(row['requires_owner_action'], state != 'reported_closed')
        value = job(closure=receipt('verified_closed', owner_verified=True, verification_succeeded=True,
                                    native_result_ref=invocation(thread=P, item='verification')))
        row = self.collect([value])['jobs'][0]
        self.assertEqual(row['closure_status'], 'verified_closed')
        self.assertEqual(row['closure_provenance'], 'owner_verified_native_result_corroborated')
        self.assertEqual(row['closure_result_ref']['item_id'], 'verification')
        for changes in ({'owner_verified': False}, {'verification_succeeded': False},
                        {'native_result_ref': invocation(thread=OTHER, item='verification')},
                        {'native_result_ref': invocation()}):
            changed = copy.deepcopy(value)
            changed['closure'].update(changes)
            self.assertEqual(self.collect([changed])['jobs'][0]['closure_status'], 'reported_closed')
        native = Native()
        native.verify_exit = 1
        self.assertEqual(self.collect([value], native)['jobs'][0]['closure_status'], 'reported_closed')

    def test_closure_receipts_bind_exact_identity_and_preserve_blocker_retention(self):
        for change in ({'start_identity': 'reused'}, {'job_id': 'other'}, {'confirmed_by': OTHER},
                       {'confirmed_at': timestamp(1801)}, {'invocation': invocation(item='other')}):
            row = self.collect([job(closure=receipt('reported_closed', **change))])['jobs'][0]
            self.assertEqual(row['closure_status'], 'unknown')
        for state in ('blocked', 'retained'):
            value = job(owner_evidence=evidence(confirmed_stalled=True), closure=receipt(
                state, reason_code='owner_question_pending', next_review_slot=300))
            row = self.collect([value])['jobs'][0]
            self.assertEqual(row['closure_status'], state)
            self.assertFalse(row['requires_owner_action'])
            self.assertEqual(row['closure_reason_code'], 'owner_question_pending')
            if state == 'retained':
                self.assertEqual(row['closure_next_review_slot'], 300)
            value['closure'].pop('reason_code')
            self.assertEqual(self.collect([value])['jobs'][0]['closure_status'], 'unknown')

    def test_bounds_duplicate_job_and_unsafe_extras_never_echo_raw_fields(self):
        value = job(owner_evidence=evidence(confirmed_stalled=True))
        value['command'] = PRIVATE
        value['owner_evidence']['output'] = PRIVATE
        result = self.collect([value, copy.deepcopy(value)])
        self.assertFalse(result['jobs'][0]['requires_owner_action'])
        self.assertEqual(result['observations'], [])
        oversized = {'version': 1, 'jobs': [], 'unknown': 'x' * subject.MAX_BYTES}
        self.assertEqual(self.collect(manifest=oversized)['status'], 'unavailable')
        values = [job(job_id=f'job-{index}') for index in range(101)]
        result = self.collect(values)
        self.assertEqual(len(result['jobs']), 100)
        self.assertEqual(result['omitted_jobs'], 1)
        self.assertFalse(result['complete'])

    def test_denied_visibility_deadline_and_shared_budget_never_bypass_or_mutate(self):
        native = Native()
        native.failure = 'thread/read'
        row = self.collect(native=native)['jobs'][0]
        self.assertEqual(row['state'], 'unknown')
        self.assertEqual(len(native.calls), 1)
        native = Native()
        native.deadline = 99.0
        with patch.object(subject.time, 'time', return_value=NOW), \
                patch.object(subject.time, 'monotonic', return_value=100.0):
            result = subject.collect(native, {'version': 1, 'jobs': [job()]},
                                     allowed_parents=[P], slot=200)[P]
        self.assertEqual(native.calls, [])
        self.assertEqual(native.deadline, 99.0)
        self.assertEqual(result['jobs'][0]['state'], 'unknown')
        with patch.object(subject, 'MAX_CALLS', 1):
            native = Native()
            result = self.collect(native=native)
        self.assertEqual(len(native.calls), 1)
        self.assertTrue(result['budget']['exhausted'])
        self.assertFalse(result['jobs'][0]['requires_owner_action'])

    def test_timeout_latches_budget_and_new_native_failure_never_leaks(self):
        native = Native()
        with patch.object(native, 'call', side_effect=TimeoutError(PRIVATE)) as calls:
            result = self.collect([job(), job(job_id='other')], native)
        self.assertEqual(calls.call_count, 1)
        self.assertEqual(result['budget']['reason_code'], 'native_timeout')
        self.assertTrue(all(row['state'] == 'unknown' for row in result['jobs']))
        self.assertEqual(result['observations'], [])

    def test_parent_owned_invocation_needs_no_child_scan_and_input_scope_validates_first(self):
        native = Native()
        value = job(worker_id=None, invocation=invocation(thread=P))
        self.assertTrue(self.collect([value], native)['jobs'][0]['invocation_verified'])
        self.assertEqual([method for method, _ in native.calls], ['thread/items/read'])
        for parents in ([P, P], ['invalid'], [None]):
            native = Native()
            with self.assertRaises(ValueError):
                subject.collect(native, {}, allowed_parents=parents, slot=200)
            self.assertEqual(native.calls, [])
        self.assertEqual(self.collect(manifest={'version': True, 'jobs': []})['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
