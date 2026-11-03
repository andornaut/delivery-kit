"""Bounded read-only question references and exact owner-attested pending proof.

Rendered questions expose title/options only. Tool arguments and outputs remain
opaque. History cannot establish exact unresolved requests, cancellation or UI
visibility. This collector never clears guards, answers or reissues questions.
"""
from datetime import datetime, timezone
import math
import time
import uuid


MAX_CALLS = 256
PAGE_SIZE = 100
MAX_QUESTIONS = 100
MAX_TITLE_BYTES = 4096
MAX_OPTIONS = 32
MAX_QUESTION_BYTES = 16384
ITEM_TYPES = {
    'agentMessage', 'collabAgentToolCall', 'commandExecution', 'contextCompaction',
    'dynamicToolCall', 'enteredReviewMode', 'exitedReviewMode', 'fileChange',
    'functionCallOutput', 'hookPrompt', 'imageGeneration', 'imageView', 'mcpToolCall',
    'plan', 'reasoning', 'sleep', 'subAgentActivity', 'userMessage', 'webSearch',
}
QUESTION_TOOLS = {'requestuserinput', 'requestuserinputasync', 'askuserquestion', 'elicitation'}
RESOLUTION_FIELDS = ('question_turn_id', 'question_item_id', 'answer_turn_id', 'answer_item_id')


class _BudgetExhausted(Exception):
    pass


class _Reader:
    def __init__(self, client):
        self.client = client
        self.calls = 0
        self.reason = None

    def call(self, params, method='thread/items/list'):
        deadline = getattr(self.client, 'deadline', None)
        if (type(deadline) in (int, float) and math.isfinite(deadline)
                and time.monotonic() >= deadline):
            self.reason = 'native_deadline_exhausted'
        if self.calls >= MAX_CALLS and self.reason is None:
            self.reason = 'native_call_budget_exhausted'
        if self.reason:
            raise _BudgetExhausted()
        self.calls += 1
        try:
            return self.client.call(method, params)
        except TimeoutError:
            self.reason = 'native_timeout'
            raise _BudgetExhausted() from None

    def metadata(self):
        return {'max_calls': MAX_CALLS, 'calls_used': self.calls,
                'exhausted': self.reason is not None, 'reason_code': self.reason}


def _identifier(value):
    return isinstance(value, str) and bool(value)


def _resolutions(records, recipient):
    record = records.get(recipient) if isinstance(records, dict) else None
    if (not isinstance(record, dict) or record.get('thread_id') != recipient
            or record.get('state') not in ('clear', 'pending')
            or not isinstance(record.get('resolutions', []), list)):
        return None
    seen = set()
    for resolution in record.get('resolutions', []):
        if (not isinstance(resolution, dict)
                or not all(_identifier(resolution.get(field)) for field in RESOLUTION_FIELDS)):
            return None
        identity = (resolution['question_turn_id'], resolution['question_item_id'])
        if identity in seen:
            return None
        seen.add(identity)
    return record.get('resolutions', [])



def _bounded_content(title, options):
    try:
        title_size = len(title.encode('utf-8'))
        return (title_size <= MAX_TITLE_BYTES
                and (options is None or (len(options) <= MAX_OPTIONS
                     and title_size + sum(len(option.encode('utf-8')) for option in options)
                     <= MAX_QUESTION_BYTES)))
    except UnicodeError:
        return False

def _questions(turn, item):
    base = {'turn_id': turn, 'item_id': item['id'], 'question_index': None,
            'kind': 'question_tool', 'title': None, 'options': None,
            'state': 'unknown', 'proof_refs': []}
    if item['type'] == 'agentMessage':
        questions = item.get('questions')
        if questions in (None, []):
            return [], []
        if not isinstance(questions, list):
            return [base | {'kind': 'rendered_prompt'}], ['question_schema_unavailable']
        rows, diagnostics = [], []
        if len(questions) > MAX_QUESTIONS:
            diagnostics.append('rendered_question_bound_exceeded')
        for index, question in enumerate(questions[:MAX_QUESTIONS]):
            row = base | {'kind': 'rendered_prompt', 'question_index': index}
            if isinstance(question, dict) and question.get('isSecret') is True:
                diagnostics.append('sensitive_question_omitted')
            elif (not isinstance(question, dict) or not isinstance(question.get('title'), str)
                    or set(question) - {'title', 'options'}
                    or (question.get('options') is not None
                        and (not isinstance(question['options'], list)
                             or not all(isinstance(option, str) for option in question['options'])))):
                diagnostics.append('question_schema_unavailable')
            elif not _bounded_content(question['title'], question.get('options')):
                diagnostics.append('question_content_bound_exceeded')
            else:
                row.update(title=question['title'], options=question.get('options'))
            rows.append(row)
        return rows, diagnostics
    if item['type'] in ('dynamicToolCall', 'functionCallOutput'):
        tool = item.get('tool') if item['type'] == 'dynamicToolCall' else item.get('name')
        if isinstance(tool, str) and tool.lower().replace('_', '') in QUESTION_TOOLS:
            return [base], ['question_tool_payload_untyped']
    return [], []


def _capture(reader, recipient, max_pages, turn_id=None):
    result = {'status': 'unavailable', 'complete': False, 'questions': [],
              'diagnostics': ['exact_unresolved_request_unavailable'],
              'pending_status': 'unavailable', 'cancelled_status': 'unavailable',
              'ui_visibility': 'unknown', 'omitted_questions': 0}
    positions, kinds = {}, {}
    cursor, cursors = None, set()
    pages = 0
    clean = True
    try:
        for _ in range(max_pages):
            params = {'threadId': recipient, 'limit': PAGE_SIZE, 'sortDirection': 'desc'}
            if turn_id is not None:
                params['turnId'] = turn_id
            if cursor is not None:
                params['cursor'] = cursor
            page = reader.call(params)
            if not isinstance(page, dict) or not isinstance(page.get('data'), list):
                raise ValueError('malformed_page')
            pages += 1
            if len(page['data']) > PAGE_SIZE:
                raise ValueError('page_bound_exceeded')
            for entry in page['data']:
                if (not isinstance(entry, dict) or not _identifier(entry.get('turnId'))
                        or (entry.get('threadId', recipient) != recipient)
                        or (turn_id is not None and entry['turnId'] != turn_id)):
                    raise ValueError('item_recipient_or_turn_mismatch')
                item = entry.get('item')
                if (not isinstance(item, dict) or not _identifier(item.get('id'))
                        or item.get('type') not in ITEM_TYPES):
                    raise ValueError('item_schema_unavailable')
                identity = (entry['turnId'], item['id'])
                if identity in positions:
                    raise ValueError('duplicate_item')
                positions[identity] = len(positions)
                kinds[identity] = item['type']
                if item['type'] == 'agentMessage' and isinstance(item.get('questions'), list):
                    result['omitted_questions'] += max(0, len(item['questions']) - MAX_QUESTIONS)
                rows, diagnostics = _questions(entry['turnId'], item)
                result['questions'].extend(rows)
                result['diagnostics'].extend(diagnostics)
                if diagnostics:
                    clean = False
                if item['type'] == 'contextCompaction':
                    result['diagnostics'].append('context_compaction')
                    clean = False
                if item['type'] == 'mcpToolCall' and item.get('status') != 'completed':
                    result['diagnostics'].append('native_tool_incomplete')
                    clean = False
            if page.get('truncated') or page.get('hasMore'):
                raise ValueError('incomplete_page')
            cursor = page.get('nextCursor')
            if cursor is None:
                result['complete'] = clean
                break
            if not _identifier(cursor) or cursor in cursors:
                raise ValueError('pagination_invalid')
            cursors.add(cursor)
        else:
            result['diagnostics'].append('page_bound_reached')
    except _BudgetExhausted:
        result['diagnostics'].append(reader.reason)
    except ValueError as error:
        # Only locally selected diagnostic codes are surfaced.
        result['diagnostics'].append(str(error) if str(error) in {
            'malformed_page', 'page_bound_exceeded', 'item_recipient_or_turn_mismatch',
            'item_schema_unavailable', 'duplicate_item', 'incomplete_page', 'pagination_invalid'
        } else 'native_history_unavailable')
    except Exception:
        result['diagnostics'].append('native_history_unavailable')
    result['status'] = 'complete' if result['complete'] else 'partial' if pages else 'unavailable'
    return result, positions, kinds



def _pending_context(reader, recipient):
    try:
        response = reader.call({'threadId': recipient, 'includeTurns': False}, 'thread/read')
        thread = response.get('thread') if isinstance(response, dict) else None
        if (not isinstance(thread, dict) or thread.get('id') != recipient
                or type(thread.get('updatedAt')) is not int):
            return None
        status = thread.get('status')
        if (not isinstance(status, dict) or status.get('type') != 'active'
                or not isinstance(status.get('activeFlags'), list)
                or 'waitingOnUserInput' not in status['activeFlags']):
            return None
        response = reader.call({'threadId': recipient, 'limit': 1,
            'itemsView': 'notLoaded', 'sortDirection': 'desc'}, 'thread/turns/list')
        turns = response.get('data') if isinstance(response, dict) else None
        if (not isinstance(turns, list) or len(turns) != 1
                or not isinstance(turns[0], dict) or not _identifier(turns[0].get('id'))
                or turns[0].get('status') != 'inProgress'
                or response.get('truncated') or response.get('hasMore')):
            return None
        return (turns[0]['id'], thread.get('updatedAt'), status['activeFlags'])
    except Exception:
        return None


def _pending_attestations(records, recipient):
    record = records.get(recipient) if isinstance(records, dict) else None
    if (not isinstance(record, dict) or record.get('thread_id') != recipient
            or record.get('state') != 'pending'):
        return []
    return record.get('pending_questions', [])


def _fresh_attestation(attestation, now):
    if (not isinstance(attestation, dict) or attestation.get('confirmed_pending') is not True
            or not all(_identifier(attestation.get(field))
                       for field in ('question_turn_id', 'question_item_id', 'confirmed_at'))
            or type(attestation.get('question_index')) is not int
            or attestation['question_index'] < 0 or not isinstance(attestation.get('title'), str)
            or 'options' not in attestation
            or (attestation['options'] is not None
                and (not isinstance(attestation['options'], list)
                     or not all(isinstance(option, str) for option in attestation['options'])))):
        return False
    if not _bounded_content(attestation['title'], attestation['options']):
        return False
    value = attestation['confirmed_at']
    try:
        if not value.endswith(('Z', '+00:00')):
            return False
        confirmed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if confirmed.tzinfo is None or confirmed.utcoffset() != timezone.utc.utcoffset(confirmed):
            return False
        return 0 <= now - confirmed.timestamp() <= 1800
    except (ValueError, OverflowError):
        return False


def _apply_pending(result, positions, kinds, recipient, attestations, contexts, resolutions,
                   latest_proof, history_positions):
    if not attestations:
        return
    if not isinstance(attestations, list):
        result['diagnostics'].append('owner_pending_attestation_invalid')
        return
    now = time.time()
    seen = set()
    candidates = {}
    for attestation in attestations:
        if not _fresh_attestation(attestation, now):
            result['diagnostics'].append('owner_pending_attestation_stale_or_invalid')
            continue
        key = (attestation['question_turn_id'], attestation['question_item_id'], attestation['question_index'])
        if key in seen:
            result['diagnostics'].append('owner_pending_attestation_duplicate')
            candidates.pop(key, None)
            continue
        seen.add(key)
        candidates[key] = attestation
    if (not latest_proof['complete'] or resolutions is None or contexts[0] is None
            or contexts[0] != contexts[1]):
        result['diagnostics'].append('owner_pending_native_proof_unavailable')
        return
    matched = set()
    for question in result['questions']:
        key = (question['turn_id'], question['item_id'], question['question_index'])
        attestation = candidates.get(key)
        if attestation is None:
            continue
        matched.add(key)
        identity = key[:2]
        if (identity not in positions or question['kind'] != 'rendered_prompt' or question['title'] is None
                or attestation['title'] != question['title'] or attestation['options'] != question['options']
                or contexts[1][0] != question['turn_id']):
            result['diagnostics'].append('owner_pending_attestation_mismatch')
            continue
        if any((resolution['question_turn_id'], resolution['question_item_id']) == identity
               for resolution in resolutions):
            result['diagnostics'].append('owner_pending_resolution_conflict')
            continue
        if identity in history_positions and any(
                reference[0] != identity[0] and history_positions[reference] < history_positions[identity]
                for reference in history_positions):
            result['diagnostics'].append('owner_pending_newer_turn_ambiguity')
            continue
        if any(kind == 'userMessage' and positions[reference] < positions[identity]
               for reference, kind in kinds.items()):
            result['diagnostics'].append('owner_pending_later_reply')
            continue
        question.update(state='pending', proof_complete=True, proof_scope='latest_turn', proof_refs=[{
            'recipient': recipient, 'question_turn_id': identity[0], 'question_item_id': identity[1],
            'question_index': key[2], 'confirmed_at': attestation['confirmed_at'],
            'kind': 'owner_pending_attestation'}])
    if set(candidates) - matched:
        result['diagnostics'].append('owner_pending_attestation_mismatch')

def collect(client, recipients, *, decision_records, max_pages=10):
    """Collect exact-recipient safe references and explicitly attested lifecycle states.

    Native pending and cancelled lifecycle is unavailable. Optional exact owner
    pending_questions attestations require fresh UTC confirmation, matching
    rendered title/options/index, stable current waitingOnUserInput/latest turn,
    complete latest-turn proof and no later reply or resolution conflict. Owner
    resolution attestations must
    identify exact question/reply items on the recipient, with native descending
    history proving the reply follows the question. Partial, compacted or unknown
    history cannot establish an answered state. Tool results remain opaque.

    max_pages bounds each recipient's thread history and separate latest-turn proof. All recipients share 256 calls
    and the provided client.deadline, without changing or extending that deadline.
    Uses thread/items/list, and thread/read plus thread/turns/list only when exact
    owner pending attestations are supplied. No persistence or mutation occurs.
    """
    if type(max_pages) is not int or not 1 <= max_pages <= 100:
        raise ValueError('invalid_max_pages')
    if not isinstance(recipients, (list, tuple)):
        raise ValueError('invalid_recipient_scope')
    for recipient in recipients:
        if not isinstance(recipient, str) or str(uuid.UUID(recipient)) != recipient:
            raise ValueError('canonical_recipient_required')
    if len(recipients) != len(set(recipients)):
        raise ValueError('duplicate_recipient')
    reader, output = _Reader(client), {}
    for recipient in recipients:
        attestations = _pending_attestations(decision_records, recipient)
        fresh = (isinstance(attestations, list)
                 and any(_fresh_attestation(attestation, time.time()) for attestation in attestations))
        before = _pending_context(reader, recipient) if fresh else None
        latest = {'status': 'unavailable', 'complete': False, 'questions': [],
                  'diagnostics': ['latest_turn_proof_unavailable'], 'omitted_questions': 0}
        latest_positions, latest_kinds = {}, {}
        if before is not None:
            latest, latest_positions, latest_kinds = _capture(reader, recipient, max_pages, before[0])
        result, positions, kinds = _capture(reader, recipient, max_pages)
        after = _pending_context(reader, recipient) if fresh else None
        result['latest_turn_proof'] = {key: latest[key]
            for key in ('status', 'complete', 'diagnostics', 'omitted_questions')}
        result['latest_turn_proof']['turn_id'] = before[0] if before else None
        resolutions = _resolutions(decision_records, recipient)
        if resolutions is None:
            result['diagnostics'].append('owner_resolution_record_unavailable')
        elif result['complete']:
            for question in result['questions']:
                if question['kind'] != 'rendered_prompt' or question['title'] is None:
                    continue
                identity = (question['turn_id'], question['item_id'])
                for resolution in resolutions:
                    qref = (resolution['question_turn_id'], resolution['question_item_id'])
                    aref = (resolution['answer_turn_id'], resolution['answer_item_id'])
                    if qref != identity:
                        continue
                    if (aref in positions and kinds[aref] == 'userMessage'
                            and positions[aref] < positions[qref]):
                        question.update(state='answered', proof_refs=[{
                            'recipient': recipient, **{field: resolution[field] for field in RESOLUTION_FIELDS}}])
                    else:
                        result['diagnostics'].append('owner_resolution_proof_unavailable')
        current = {(q['turn_id'], q['item_id'], q['question_index']): q for q in latest['questions']}
        for index, question in enumerate(result['questions']):
            key = (question['turn_id'], question['item_id'], question['question_index'])
            if key in current:
                replacement = current.pop(key)
                if (question['state'] == 'answered' and question['title'] == replacement['title']
                        and question['options'] == replacement['options']):
                    replacement.update(state='answered', proof_refs=question['proof_refs'])
                result['questions'][index] = replacement
        result['questions'].extend(current.values())
        _apply_pending(result, latest_positions, latest_kinds, recipient, attestations,
                       (before, after), resolutions, latest, positions)
        result['pending_status'] = ('owner_attested' if any(q['state'] == 'pending'
                                   for q in result['questions']) else 'unavailable')
        result['diagnostics'] = sorted(set(result['diagnostics']))
        result['budget'] = reader.metadata()
        output[recipient] = result
    return output
