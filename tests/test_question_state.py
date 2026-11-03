"""Offline exact question proof and bounded private-body exclusion fixtures."""
import copy
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec'))
import question_state as subject

P = '00000000-0000-0000-0000-000000000001'
OTHER = '00000000-0000-0000-0000-000000000002'
PRIVATE = 'PRIVATE_UNRELATED_BODY'
NOW = 1793682000


def question(item='question', turn='current', questions=None):
    return {'turnId': turn, 'item': {'id': item, 'type': 'agentMessage', 'text': PRIVATE,
        'questions': [{'title': 'Choose a licence', 'options': ['MIT', 'Apache']}] if questions is None else questions}}


def reply(item='reply', turn='current'):
    return {'turnId': turn, 'item': {'id': item, 'type': 'userMessage', 'content': [PRIVATE]}}


def attestation(**changes):
    stamp = datetime.fromtimestamp(NOW - 60, timezone.utc).isoformat()
    return {'question_turn_id': 'current', 'question_item_id': 'question', 'question_index': 0,
            'title': 'Choose a licence', 'options': ['MIT', 'Apache'],
            'confirmed_pending': True, 'confirmed_at': stamp} | changes


def record(*, state='pending', pending=True, **changes):
    value = {'thread_id': P, 'state': state, 'resolutions': []}
    if pending:
        value['pending_questions'] = [attestation()]
    return value | changes


def resolution(**changes):
    return {'question_turn_id': 'current', 'question_item_id': 'question',
            'answer_turn_id': 'current', 'answer_item_id': 'reply'} | changes


class Native:
    def __init__(self, entries=None):
        self.pages = [{'data': [question()] if entries is None else entries}]
        self.calls = []
        self.deadline = 200.0
        self.failure = None
        self.waiting = True
        self.latest = 'current'
        self.context_reads = 0
        self.fresh_latest = None
        self.latest_pages = None
        self.updated_at = 1

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if self.failure == method:
            raise RuntimeError(PRIVATE)
        if params['threadId'] != P:
            raise AssertionError('unscoped recipient')
        if method == 'thread/items/list':
            assert params['sortDirection'] == 'desc'
            index = int(params.get('cursor', '0'))
            pages = self.latest_pages if 'turnId' in params and self.latest_pages is not None else self.pages
            page = copy.deepcopy(pages[index])
            if 'turnId' in params and self.latest_pages is None:
                page['data'] = [entry for entry in page.get('data', [])
                                if 'turnId' not in entry or entry['turnId'] == params['turnId']]
            return page
        if method == 'thread/read':
            assert params['includeTurns'] is False
            self.context_reads += 1
            return {'thread': {'id': P, 'updatedAt': self.updated_at,
                'status': {'type': 'active', 'activeFlags': ['waitingOnUserInput'] if self.waiting else []}}}
        if method == 'thread/turns/list':
            latest = self.fresh_latest if self.context_reads > 1 and self.fresh_latest else self.latest
            return {'data': [{'id': latest, 'status': 'inProgress'}]}
        raise AssertionError('native mutation or unsupported call')


class QuestionStateTests(unittest.TestCase):
    def collect(self, native=None, owner=None, **kwargs):
        native = native or Native()
        owner = record() if owner is None else owner
        with patch.object(subject.time, 'time', return_value=NOW), \
                patch.object(subject.time, 'monotonic', return_value=100.0):
            result = subject.collect(native, [P], decision_records={P: owner}, **kwargs)[P]
        self.assertNotIn(PRIVATE, str(result))
        self.assertEqual(native.deadline, 200.0)
        return result

    def test_exact_fresh_owner_confirmation_and_current_native_proof_pending(self):
        native = Native()
        result = self.collect(native)
        self.assertEqual(result['status'], 'complete')
        self.assertTrue(result['complete'])
        q = result['questions'][0]
        self.assertEqual(q['state'], 'pending')
        self.assertEqual(q['title'], 'Choose a licence')
        self.assertEqual(q['options'], ['MIT', 'Apache'])
        self.assertEqual(q['question_index'], 0)
        self.assertEqual(q['proof_refs'][0]['recipient'], P)
        self.assertEqual(result['pending_status'], 'owner_attested')
        self.assertEqual(result['ui_visibility'], 'unknown')
        self.assertEqual(result['cancelled_status'], 'unavailable')
        self.assertEqual(len(native.calls), 6)
        self.assertIn('exact_unresolved_request_unavailable', result['diagnostics'])

    def test_generic_pending_waitflag_and_absent_reply_never_prove_pending(self):
        for owner in (record(pending=False), record(state='clear'), {}, None):
            with self.subTest(owner=owner):
                native = Native()
                if owner is None:
                    with patch.object(subject.time, 'monotonic', return_value=100):
                        result = subject.collect(native, [P], decision_records={})[P]
                else:
                    result = self.collect(native, owner)
                self.assertEqual(result['questions'][0]['state'], 'unknown')
                self.assertEqual(result['pending_status'], 'unavailable')
                self.assertEqual([method for method, _ in native.calls], ['thread/items/list'])

    def test_stale_future_non_utc_and_missing_attestations_are_unknown(self):
        stamps = [datetime.fromtimestamp(NOW - 1801, timezone.utc).isoformat(),
                  datetime.fromtimestamp(NOW + 1, timezone.utc).isoformat(),
                  '2026-11-03T00:00:00', '2026-11-03T00:00:00-04:00', '', PRIVATE]
        for stamp in stamps:
            with self.subTest(stamp=stamp):
                result = self.collect(owner=record(pending_questions=[attestation(confirmed_at=stamp)]))
                self.assertEqual(result['questions'][0]['state'], 'unknown')
                self.assertIn('owner_pending_attestation_stale_or_invalid', result['diagnostics'])
        for age in (0, 1800):
            stamp = datetime.fromtimestamp(NOW-age, timezone.utc).isoformat().replace('+00:00', 'Z')
            self.assertEqual(self.collect(owner=record(pending_questions=[attestation(confirmed_at=stamp)]))
                             ['questions'][0]['state'], 'pending')

    def test_wrong_recipient_mismatch_index_options_title_and_duplicate_attestation(self):
        variants = [record(thread_id=OTHER), record(pending_questions='invalid'),
                    record(pending_questions=[attestation(question_index=True)]),
                    record(pending_questions=[attestation(question_index=1)]),
                    record(pending_questions=[attestation(title='Other')]),
                    record(pending_questions=[attestation(options=['Apache', 'MIT'])]),
                    record(pending_questions=[attestation(question_item_id='other')]),
                    record(pending_questions=[attestation(), attestation()])]
        for owner in variants:
            with self.subTest(owner=owner):
                result = self.collect(owner=owner)
                self.assertEqual(result['questions'][0]['state'], 'unknown')

    def test_newer_turn_changed_turn_missing_waitflag_and_later_reply_unknown(self):
        for field, value in (('latest', 'newer'), ('fresh_latest', 'newer'), ('waiting', False)):
            native = Native()
            setattr(native, field, value)
            with self.subTest(field=field):
                self.assertEqual(self.collect(native)['questions'][0]['state'], 'unknown')
        result = self.collect(Native([reply(), question()]))
        self.assertEqual(result['questions'][0]['state'], 'unknown')
        self.assertIn('owner_pending_later_reply', result['diagnostics'])

    def test_visible_newer_turn_and_partial_exact_answer_proof_remain_unknown(self):
        native = Native([question(item='new-question', turn='newer'), question()])
        result = self.collect(native)
        self.assertTrue(all(q['state'] == 'unknown' for q in result['questions']))
        self.assertIn('owner_pending_newer_turn_ambiguity', result['diagnostics'])
        native = Native([reply(), question()])
        native.pages[0]['truncated'] = True
        owner = record(state='clear', pending=False, resolutions=[resolution()])
        self.assertEqual(self.collect(native, owner)['questions'][0]['state'], 'unknown')

    def test_complete_paginated_history_can_prove_pending_without_body_capture(self):
        native = Native()
        native.pages = [{'data': [question()], 'nextCursor': '1'},
                        {'data': [reply(turn='older')]}]
        result = self.collect(native)
        self.assertEqual(result['questions'][0]['state'], 'pending')
        self.assertTrue(result['complete'])
        self.assertEqual(result['budget']['calls_used'], 8)

    def test_compaction_unknown_malformed_and_partial_pages_never_establish_pending_or_answered(self):
        cases = [
            {'data': [question(), {'turnId': 'current', 'item': {'id': 'compact', 'type': 'contextCompaction'}}]},
            {'data': [question(), {'turnId': 'current', 'item': {'id': 'unknown', 'type': 'futureKind'}}]},
            {'data': [question(), {'item': {}}]},
            {'data': [question()], 'truncated': True},
            {'data': [question()], 'nextCursor': '1'},
        ]
        for page in cases:
            for owner in (record(), record(resolutions=[resolution()])):
                with self.subTest(page=page, owner=owner):
                    native = Native()
                    native.pages = [page]
                    result = self.collect(native, owner, max_pages=1)
                    self.assertFalse(result['complete'])
                    self.assertEqual(result['questions'][0]['state'], 'unknown')

    def test_answered_requires_exact_attestation_reply_type_and_native_order(self):
        owner = record(state='clear', pending=False, resolutions=[resolution()])
        result = self.collect(Native([reply(), question()]), owner)
        self.assertEqual(result['questions'][0]['state'], 'answered')
        self.assertEqual(result['questions'][0]['proof_refs'][0]['answer_item_id'], 'reply')
        for entries, changed in (([question(), reply()], {}),
                                 ([reply(), question()], {'answer_item_id': 'missing'}),
                                 ([reply(), question()], {'answer_turn_id': 'other'})):
            native = Native(entries)
            result = self.collect(native, record(state='clear', pending=False,
                                                 resolutions=[resolution(**changed)]))
            self.assertEqual(result['questions'][0]['state'], 'unknown')
        native = Native([{'turnId': 'current', 'item': {'id': 'reply', 'type': 'agentMessage', 'text': PRIVATE}}, question()])
        self.assertEqual(self.collect(native, owner)['questions'][0]['state'], 'unknown')

    def test_cross_turn_resolution_pagination_proves_order_and_recipient_binding(self):
        native = Native()
        native.pages = [{'data': [reply(turn='later')], 'nextCursor': '1'},
                        {'data': [question(turn='older')]}]
        owner = record(state='clear', pending=False, resolutions=[resolution(
            question_turn_id='older', answer_turn_id='later')])
        self.assertEqual(self.collect(native, owner)['questions'][0]['state'], 'answered')
        self.assertEqual(self.collect(native, owner | {'thread_id': OTHER})['questions'][0]['state'], 'unknown')

    def test_verified_resolution_conflicts_with_pending_and_user_prose_never_answers(self):
        owner = record(resolutions=[resolution()])
        result = self.collect(Native([reply(), question()]), owner)
        self.assertEqual(result['questions'][0]['state'], 'answered')
        self.assertIn('owner_pending_resolution_conflict', result['diagnostics'])
        result = self.collect(Native([reply(), question()]), record(state='clear', pending=False))
        self.assertEqual(result['questions'][0]['state'], 'unknown')

    def test_only_titles_options_rendered_and_sensitive_tool_payloads_stay_opaque(self):
        native = Native([question(questions=[{'title': 'Free text', 'options': None},
                                            {'title': 'Bare title'}])])
        owner = record(state='clear', pending=False)
        result = self.collect(native, owner)
        self.assertEqual([q['options'] for q in result['questions']], [None, None])
        sensitive = {'title': PRIVATE, 'options': [PRIVATE], 'isSecret': True}
        for item in (
                question(questions=[sensitive]),
                {'turnId': 'current', 'item': {'id': 'tool', 'type': 'dynamicToolCall',
                    'tool': 'request_user_input', 'status': 'completed',
                    'arguments': {'questions': [{'isSecret': True, 'question': PRIVATE}]},
                    'contentItems': [{'type': 'inputText', 'text': PRIVATE}], 'success': True}},
                {'turnId': 'current', 'item': {'id': 'tool', 'type': 'functionCallOutput',
                    'name': 'request_user_input', 'output': PRIVATE}}):
            result = self.collect(Native([item]), owner)
            self.assertEqual(result['questions'][0]['state'], 'unknown')
            self.assertIsNone(result['questions'][0]['title'])
            self.assertIsNone(result['questions'][0]['options'])

    def test_cancellation_request_id_or_tool_acceptance_never_prove_lifecycle(self):
        owner = record(pending=False, cancelled=True, request_id='unverified')
        result = self.collect(owner=owner)
        self.assertEqual(result['questions'][0]['state'], 'unknown')
        self.assertEqual(result['cancelled_status'], 'unavailable')

    def test_unknown_capability_timeout_deadline_and_budget_are_safe_and_read_only(self):
        native = Native()
        native.failure = 'thread/items/list'
        result = self.collect(native, record(state='clear', pending=False))
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('native_history_unavailable', result['diagnostics'])
        native = Native()
        native.deadline = 99.0
        with patch.object(subject.time, 'monotonic', return_value=100.0):
            result = subject.collect(native, [P], decision_records={})[P]
        self.assertEqual(native.calls, [])
        self.assertEqual(native.deadline, 99.0)
        self.assertIn('native_deadline_exhausted', result['diagnostics'])
        native = Native()
        with patch.object(subject, 'MAX_CALLS', 1):
            result = self.collect(native)
        self.assertEqual(len(native.calls), 1)
        self.assertTrue(result['budget']['exhausted'])
        self.assertNotEqual(result['pending_status'], 'owner_attested')
        native = Native()
        with patch.object(native, 'call', side_effect=TimeoutError(PRIVATE)):
            result = self.collect(native, record(state='clear', pending=False))
        self.assertIn('native_timeout', result['diagnostics'])

    def test_old_compaction_or_partial_history_does_not_taint_complete_current_proof(self):
        for history in (
                {'data': [question(), {'turnId': 'older', 'item': {'id': 'old-compact', 'type': 'contextCompaction'}}]},
                {'data': [question()], 'nextCursor': '1'}):
            native = Native()
            native.pages = [history]
            native.latest_pages = [{'data': [question()]}]
            result = self.collect(native, max_pages=1)
            self.assertFalse(result['complete'])
            self.assertEqual(result['status'], 'partial')
            self.assertTrue(result['latest_turn_proof']['complete'])
            self.assertEqual(result['questions'][0]['state'], 'pending')
            self.assertTrue(result['questions'][0]['proof_complete'])
            self.assertEqual(result['questions'][0]['proof_scope'], 'latest_turn')
        for current in (
                {'data': [question(), {'turnId': 'current', 'item': {'id': 'compact', 'type': 'contextCompaction'}}]},
                {'data': [question()], 'truncated': True},
                {'data': [question()], 'nextCursor': '1'}):
            native = Native()
            native.latest_pages = [current]
            result = self.collect(native, max_pages=1)
            self.assertFalse(result['latest_turn_proof']['complete'])
            self.assertEqual(result['questions'][0]['state'], 'unknown')

    def test_stable_context_requires_integer_updated_at(self):
        for value in (None, True, '1', 1.5):
            native = Native()
            native.updated_at = value
            with self.subTest(updated_at=value):
                result = self.collect(native)
                self.assertEqual(result['questions'][0]['state'], 'unknown')
                self.assertFalse(result['latest_turn_proof']['complete'])

    def test_content_limits_omit_exact_fields_without_truncating_options(self):
        oversized = [
            {'title': 'x' * 4097, 'options': ['small']},
            {'title': 'é' * 2049, 'options': None},
            {'title': 'small', 'options': ['x'] * 33},
            {'title': 'small', 'options': ['x' * 16384]},
            {'title': 'bad-surrogate-\ud800', 'options': None},
        ]
        for native_question in oversized:
            native = Native([question(questions=[native_question])])
            owner = record(pending_questions=[attestation(
                title=native_question['title'], options=native_question['options'])])
            with self.subTest(title_length=len(native_question['title'])):
                result = self.collect(native, owner)
                self.assertFalse(result['complete'])
                self.assertIn('question_content_bound_exceeded', result['diagnostics'])
                self.assertEqual(result['questions'][0]['state'], 'unknown')
                self.assertIsNone(result['questions'][0]['title'])
                self.assertIsNone(result['questions'][0]['options'])
        limits = {'title': 'é' * 2048, 'options': ['x' * 384] * 32}
        result = self.collect(Native([question(questions=[limits])]),
            record(pending_questions=[attestation(**limits)]))
        self.assertEqual(result['questions'][0]['state'], 'pending')
        self.assertEqual(result['questions'][0]['title'], limits['title'])
        self.assertEqual(result['questions'][0]['options'], limits['options'])

    def test_rendered_question_count_is_bounded_with_explicit_omission(self):
        native = Native([question(questions=[{'title': 'Choose', 'options': ['A', 'B']}] * 101)])
        result = self.collect(native, record(pending=False))
        self.assertEqual(len(result['questions']), 100)
        self.assertEqual(result['omitted_questions'], 1)
        self.assertFalse(result['complete'])
        self.assertIn('rendered_question_bound_exceeded', result['diagnostics'])
        self.assertTrue(all(q['state'] == 'unknown' for q in result['questions']))

    def test_input_bounds_and_malformed_resolution_records_fail_closed(self):
        for recipients in ([P, P], [P.upper().replace('00000000', 'ABCDEFAB', 1)], ['invalid']):
            native = Native()
            with self.assertRaises(ValueError):
                subject.collect(native, recipients, decision_records={})
            self.assertEqual(native.calls, [])
        for max_pages in (0, True, 101):
            with self.assertRaises(ValueError):
                subject.collect(Native(), [P], decision_records={}, max_pages=max_pages)
        for resolutions in ([resolution(), resolution()], [{}], 'invalid'):
            result = self.collect(owner=record(resolutions=resolutions))
            self.assertEqual(result['questions'][0]['state'], 'unknown')


if __name__ == '__main__':
    unittest.main()
