"""Local queue inventory and explicitly authorised, snapshot-bound acknowledgements."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
import stat
from pathlib import Path
import subprocess
import sys
import time
import uuid


def persist(path, record):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / ('.' + path.name + '.' + str(uuid.uuid4()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(record, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    # Include newly created directory entries in the durability boundary.
    for directory in (path.parent, path.parent.parent):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def canonical_uuid(value):
    if str(uuid.UUID(value)) != value:
        raise ValueError('canonical UUID required')
    return value


@contextmanager
def locked(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'monitor.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def queue_entries(client, recipient):
    entries = {}
    cursor = None
    cursors = set()
    while True:
        params = {'threadId': recipient, 'limit': 100}
        if cursor is not None:
            params['cursor'] = cursor
        page = client.call('thread/queue/list', params)
        if (not isinstance(page, dict) or not isinstance(page.get('data'), list)
                or page.get('truncated') or page.get('hasMore')):
            raise ValueError('queue inventory incomplete')
        for entry in page['data']:
            if (not isinstance(entry, dict) or not isinstance(entry.get('id'), str)
                    or not entry['id'] or not isinstance(entry.get('clientUserMessageId'), str)
                    or not isinstance(entry.get('input'), list)):
                raise ValueError('unknown queued submission shape')
            identity = entry['id']
            if identity in entries and entries[identity] != entry:
                raise ValueError('queue changed during pagination')
            entries[identity] = entry
        cursor = page.get('nextCursor')
        if cursor is None:
            return list(entries.values())
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError('queue pagination did not advance')
        cursors.add(cursor)


def history_refs(client, recipient, cursor=None):
    params = {'threadId': recipient, 'limit': 100, 'sortDirection': 'desc'}
    if cursor is not None:
        params['cursor'] = cursor
    result = {'status': 'unavailable', 'complete': False, 'cursor': cursor,
              'nextCursor': None, 'question_refs': [], 'user_reply_refs': [],
              'reason_code': 'metadata_unavailable', 'category': 'metadata'}
    try:
        from unblock import NATIVE_ITEM_TYPES, RpcError, question_item
        page = client.call('thread/items/list', params)
        if not isinstance(page, dict) or not isinstance(page.get('data'), list):
            result.update(reason_code='malformed_page', category='page')
            return result
        next_cursor = page.get('nextCursor')
        if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor):
            result.update(reason_code='invalid_cursor', category='pagination')
            return result
        result['nextCursor'] = next_cursor
        compacted = False
        for entry in page['data']:
            if not isinstance(entry, dict) or not isinstance(entry.get('turnId'), str) or not entry['turnId']:
                result.update(reason_code='malformed_row', category='row')
                return result
            item = entry.get('item')
            if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                    or not item['id'] or not isinstance(item.get('type'), str)):
                result.update(reason_code='malformed_item', category='item')
                return result
            if item['type'] == 'contextCompaction':
                compacted = True
                continue
            if item['type'] not in NATIVE_ITEM_TYPES:
                result.update(reason_code='unsupported_item_type', category='unknown_item')
                return result
            reference = {'turn_id': entry['turnId'], 'item_id': item['id']}
            if question_item(item):
                reference['kind'] = 'rendered_prompt' if item['type'] == 'agentMessage' else 'question_tool'
                result['question_refs'].append(reference)
            elif item['type'] == 'userMessage':
                result['user_reply_refs'].append(reference)
        result['complete'] = not (compacted or next_cursor is not None or page.get('truncated') or page.get('hasMore'))
        result['status'] = 'complete' if result['complete'] else 'partial'
        if compacted:
            result.update(reason_code='context_compaction', category='context_compaction')
        elif page.get('truncated') or page.get('hasMore'):
            result.update(reason_code='incomplete_page', category='pagination')
        elif next_cursor is not None:
            result.update(reason_code='more_history', category='pagination')
        else:
            result.update(reason_code='complete', category='history')
        return result
    except json.JSONDecodeError:
        result.update(reason_code='json_parse_failure', category='json')
    except RpcError:
        result.update(reason_code='native_rpc_failure', category='native_rpc')
    except (OSError, TimeoutError):
        result.update(reason_code='transport_failure', category='transport')
    except Exception:
        result.update(reason_code='metadata_failure', category='metadata')
    return result


def scoped_parents(parents):
    parents = [canonical_uuid(parent) for parent in parents]
    if len(parents) != len(set(parents)):
        raise ValueError('duplicate parent UUID')
    if not parents:
        return parents
    try:
        from codex_adapter import resolve_route
        route_file = os.environ.get('MONITOR_ROUTE_FILE', '')
        if not Path(route_file).is_absolute():
            raise ValueError('absolute route required')
        declared = json.loads(Path(route_file).read_text())
        route = resolve_route(route_file, declared['host_project_root'])
        if route.get('status') != 'active':
            raise ValueError('active route required')
        allowed = {route['coordinator'], *route['peers']}
        if any(parent not in allowed for parent in parents):
            raise ValueError('parent outside active route')
    except Exception as error:
        raise ValueError('worker parents require membership in an active MONITOR_ROUTE_FILE') from error
    return parents


def worker_health(client, parents, *, reserve=True):
    parents = scoped_parents(parents)
    if not parents:
        return {}
    original_deadline = getattr(client, 'deadline', None)
    reason_code = 'collector_unavailable'
    try:
        if reserve and original_deadline is not None:
            client.deadline = original_deadline - 5
            if time.monotonic() >= client.deadline:
                raise TimeoutError('child collection budget exhausted')
        from child_health import collect
        result = collect(client, parents)
        if not isinstance(result, dict):
            raise ValueError('invalid collector result')
    except TimeoutError:
        reason_code = 'collector_budget_exhausted'
        result = {}
    except Exception:
        result = {}
    finally:
        if reserve and original_deadline is not None:
            client.deadline = original_deadline
    unavailable = {'status': 'unavailable', 'schema_status': 'unavailable',
                   'complete': False, 'children': [],
                   'diagnostics': [{'reason_code': reason_code}]}
    return {parent: (result[parent] if isinstance(result.get(parent), dict)
                     and result[parent].get('status') in ('complete', 'partial', 'unavailable')
                     and isinstance(result[parent].get('children'), list) else unavailable)
            for parent in parents}


class CollectionClient:
    """Share the connection's reserved deadline and 256 calls across collectors."""
    def __init__(self, client):
        self.client = client
        self.calls_used = 0
        self.reason_code = None

    @property
    def deadline(self):
        return getattr(self.client, 'deadline', None)

    def call(self, method, params):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            self.reason_code = 'collection_deadline_exhausted'
        if self.calls_used >= 256:
            self.reason_code = 'collection_call_budget_exhausted'
        if self.reason_code:
            raise TimeoutError('shared collection budget exhausted')
        self.calls_used += 1
        try:
            return self.client.call(method, params)
        except TimeoutError:
            self.reason_code = 'collection_timeout'
            raise


def question_state(client, state_dir, recipients):
    unavailable = lambda code: {'status': 'unavailable', 'complete': False, 'questions': [],
        'diagnostics': [code], 'pending_status': 'unavailable',
        'cancelled_status': 'unavailable', 'ui_visibility': 'unknown'}
    allowed = list(recipients)
    result = {}
    if 'MONITOR_ROUTE_FILE' in os.environ:
        for recipient in recipients:
            try:
                scoped_parents([recipient])
            except ValueError:
                result[recipient] = unavailable('question_recipient_outside_active_route')
        allowed = [recipient for recipient in recipients if recipient not in result]
    if not allowed:
        return result
    from unblock import decision_record
    decisions = {recipient: decision_record(state_dir, recipient) for recipient in allowed}
    try:
        deadline = getattr(client, 'deadline', None)
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError('question collection deadline')
        from question_state import collect
        collected = collect(client, allowed, decision_records=decisions)
        if not isinstance(collected, dict):
            raise ValueError('invalid question collector result')
    except TimeoutError:
        collected = {recipient: unavailable('question_collection_budget_exhausted') for recipient in allowed}
    except Exception:
        collected = {recipient: unavailable('question_collector_unavailable') for recipient in allowed}
    for recipient in allowed:
        value = collected.get(recipient)
        result[recipient] = (value if isinstance(value, dict)
            and value.get('status') in ('complete', 'partial', 'unavailable')
            and isinstance(value.get('questions'), list) else unavailable('question_collector_unavailable'))
        # Keep exact snapshot choices; never present truncated choices as originals.
        value = result[recipient]
        for question in value['questions']:
            content = json.dumps({'owner': recipient, 'level': 'escalation',
                **{key: question.get(key) for key in
                   ('turn_id', 'item_id', 'question_index', 'kind', 'title', 'options')}}, ensure_ascii=False)
            if len(content.encode('utf-8')) > 32768:
                question['state'] = 'unknown'
                value.update(status='partial', complete=False)
                value.setdefault('diagnostics', []).append('question_text_exceeds_reminder_bounds')
    return {recipient: result[recipient] for recipient in recipients}


def question_observations(snapshot):
    observations = {}
    for recipient, health in snapshot.get('question_state', {}).items():
        for question in health.get('questions', []):
            if not isinstance(question, dict) or question.get('state') not in ('pending', 'answered', 'unknown'):
                continue
            if (not all(isinstance(question.get(key), str) and question[key]
                        for key in ('turn_id', 'item_id', 'kind'))
                    or type(question.get('question_index')) is not int or question['question_index'] < 0):
                continue
            identity = digest([recipient, question['turn_id'], question['item_id'],
                               question['question_index'], question['kind']])
            signature = digest([identity, question['state'], question.get('title'), question.get('options')])
            observations[identity] = (signature, recipient, question)
    return observations


def pending_proven(owner, question):
    proofs = question.get('proof_refs')
    return (question.get('state') == 'pending' and question.get('proof_complete') is True
            and question.get('proof_scope') == 'latest_turn' and isinstance(proofs, list)
            and any(isinstance(proof, dict) and proof.get('kind') == 'owner_pending_attestation'
                    and proof.get('recipient') == owner
                    and proof.get('question_turn_id') == question.get('turn_id')
                    and proof.get('question_item_id') == question.get('item_id')
                    and proof.get('question_index') == question.get('question_index') for proof in proofs))


def question_notices(state_dir, recipient, snapshot, slot=None):
    path = state_dir / 'health' / (recipient + '.json')
    record = json.loads(path.read_text()) if path.exists() else {}
    previous = record.get('question_observations', {})
    slot = snapshot.get('slot') if slot is None else slot
    notices = []
    for identity, (signature, owner, question) in question_observations(snapshot).items():
        if not pending_proven(owner, question):
            continue
        old = previous.get(identity, {})
        if (old.get('answered_seen') or (slot is not None and old.get('last_slot') is not None
                                        and slot < old['last_slot'])):
            continue
        matching = old.get('signature') == signature
        level = ('escalation' if matching and slot is not None
                 and old.get('first_slot') is not None and old['first_slot'] != slot else 'initial')
        if matching and level in old.get('accepted_levels', []):
            continue
        notices.append({'identity': identity, 'signature': signature, 'level': level,
                        'owner': owner, 'question': question})
    return notices


def question_brief(notices):
    rows = []
    keys = []
    for notice in notices:
        question = notice['question']
        row = {'owner': notice['owner'], 'level': notice['level'],
               **{key: question[key] for key in ('turn_id', 'item_id', 'question_index', 'kind', 'title', 'options')}}
        if len(json.dumps(rows + [row], ensure_ascii=False).encode('utf-8')) > 32768:
            break
        rows.append(row)
        keys.append({key: notice[key] for key in ('identity', 'signature', 'level')})
    return rows, keys


def record_questions(record, snapshot, slot, accepted_keys):
    previous = record.setdefault('question_observations', {})
    for identity, (signature, owner, question) in question_observations(snapshot).items():
        old = previous.get(identity, {})
        if old.get('last_slot') is not None and slot < old['last_slot']:
            continue
        answered_seen = old.get('answered_seen', False) or question['state'] == 'answered'
        if old.get('signature') != signature:
            old = {'signature': signature, 'state': question['state'],
                   'first_slot': slot, 'accepted_levels': []}
        old.update(last_slot=slot, answered_seen=answered_seen)
        for notice in accepted_keys:
            if (notice.get('identity') == identity and notice.get('signature') == signature
                    and notice.get('level') in ('initial', 'escalation')):
                old['accepted_levels'] = sorted(set(old['accepted_levels']) | {notice['level']})
        previous[identity] = old


def process_key(job):
    return [job.get(key) for key in ('owner_parent_id', 'kind', 'job_id', 'start_identity', 'stall_episode')]


def process_sample(sample, allowed_parents):
    """Validate the collector's exact safe sample shape without manufacturing proof."""
    keys = {'slot', 'collected_at', 'provenance', 'owner_parent_id', 'worker_id', 'kind', 'job_id', 'start_identity',
            'invocation', 'protected', 'owner_evidence'}
    evidence_keys = {'confirmed_by', 'confirmed_at', 'identity_verified', 'provenance', 'state',
                     'confirmed_stalled', 'episode_id', 'blocked_condition', 'progress'}
    return (isinstance(sample, dict) and set(sample) == keys
            and sample.get('owner_parent_id') in allowed_parents
            and type(sample.get('slot')) is int
            and sample.get('provenance') == 'owner_attested'
            and isinstance(sample.get('owner_evidence'), dict)
            and not set(sample['owner_evidence']) - evidence_keys
            and sample['owner_evidence'].get('provenance') == 'owner_attested'
            and len(json.dumps(sample).encode('utf-8')) <= 8192)


def prior_process_observations(state_dir, coordinator):
    if 'PROCESS_HEALTH_FILE' not in os.environ:
        return None
    try:
        record = json.loads((state_dir / 'health' / (coordinator + '.json')).read_text())
        values = record.get('process_observations', [])
        return values if isinstance(values, list) else None
    except (OSError, ValueError, TypeError):
        return None


def process_health(client, recipients, parents, slot, prior_observations):
    source = {'status': 'disabled', 'diagnostics': []}
    if 'PROCESS_HEALTH_FILE' not in os.environ:
        return {}, source
    unavailable = lambda code: {'status': 'unavailable', 'complete': False, 'jobs': [],
                               'observations': [], 'diagnostics': [code], 'omitted_jobs': 0}
    allowed = []
    try:
        # Manifest registration never expands the explicitly requested route scope.
        candidates = list(dict.fromkeys([*recipients, *parents]))
        for parent in candidates:
            try:
                scoped_parents([parent])
                allowed.append(parent)
            except ValueError:
                pass
        if not allowed:
            raise ValueError('process_route_unavailable')
        path = Path(os.environ['PROCESS_HEALTH_FILE'])
        if not path.is_absolute():
            raise ValueError('process_manifest_path_invalid')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('process_manifest_not_regular')
            if info.st_size > 1048576:
                raise ValueError('process_manifest_size_exceeded')
            data = stream.read(1048577)
            if len(data) > 1048576:
                raise ValueError('process_manifest_size_exceeded')
        registrations = json.loads(data)
        if (not isinstance(registrations, dict) or registrations.get('version') != 1
                or type(registrations.get('version')) is not int
                or not isinstance(registrations.get('jobs'), list) or len(registrations['jobs']) > 100):
            raise ValueError('process_manifest_schema_unavailable')
    except ValueError as error:
        code = str(error)
        if code not in {'process_route_unavailable', 'process_manifest_path_invalid',
                        'process_manifest_not_regular', 'process_manifest_size_exceeded',
                        'process_manifest_schema_unavailable'}:
            code = 'process_manifest_unavailable'
        source.update(status='unavailable', diagnostics=[code])
        return {parent: unavailable(code) for parent in allowed}, source
    except OSError:
        source.update(status='unavailable', diagnostics=['process_manifest_unavailable'])
        return {parent: unavailable('process_manifest_unavailable') for parent in allowed}, source
    prior = ([sample for sample in prior_observations if process_sample(sample, allowed)]
             if type(slot) is int and isinstance(prior_observations, list) else None)
    try:
        from process_health import collect
        collected = collect(client, registrations, allowed_parents=allowed, slot=slot,
                            prior_observations=prior)
        if not isinstance(collected, dict):
            raise ValueError('process collector shape')
        result = {}
        for parent in allowed:
            value = collected.get(parent)
            if (not isinstance(value, dict) or value.get('status') not in ('complete', 'partial', 'unavailable')
                    or not isinstance(value.get('jobs'), list) or not isinstance(value.get('observations'), list)):
                value = unavailable('process_collector_unavailable')
            result[parent] = value
        source.update(status='available')
        return result, source
    except Exception:
        source.update(status='unavailable', diagnostics=['process_collector_unavailable'])
        return {parent: unavailable('process_collector_unavailable') for parent in allowed}, source


def process_notices(state_dir, coordinator, snapshot):
    path = state_dir / 'health' / (coordinator + '.json')
    record = json.loads(path.read_text()) if path.exists() else {}
    accepted = record.get('accepted_process_requests', [])
    unresolved = [item.get('request_key') for item in record.get('process_request_delivery', {}).values()
                  if item.get('status') in ('sending', 'ambiguous', 'accepted')]
    notices = []
    for parent, health in snapshot.get('process_health', {}).items():
        for job in health.get('jobs', []):
            key = process_key(job)
            if (job.get('owner_parent_id') != parent or job.get('state') != 'stalled'
                    or job.get('requires_owner_action') is not True or job.get('protected') is not False
                    or job.get('kind') not in ('process', 'container', 'browser_job')
                    or job.get('identity_provenance') != 'owner_attested'
                    or job.get('progress_provenance') != 'owner_attested'
                    or job.get('lineage_verified') is not True or job.get('invocation_verified') is not True
                    or any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', value)
                           for value in key) or key in accepted or key in unresolved
                    or job.get('closure_status') != 'none'):
                continue
            evidence = []
            for sample in health.get('observations', []):
                if (process_sample(sample, [parent])
                        and all(sample.get(field) == job.get(field) for field in
                                ('owner_parent_id', 'kind', 'job_id', 'start_identity', 'invocation'))):
                    owner = sample['owner_evidence']
                    evidence.append({field: owner[field] for field in
                        ('confirmed_by', 'confirmed_at', 'episode_id', 'blocked_condition') if field in owner})
            if not evidence and isinstance(job.get('owner_evidence_ref'), dict):
                reference = job['owner_evidence_ref']
                if reference.get('confirmed_by') == parent and reference.get('episode_id') == job['stall_episode']:
                    evidence.append(reference)
            if not evidence:
                continue
            notice = {field: job.get(field) for field in
                      ('owner_parent_id', 'worker_id', 'kind', 'job_id', 'start_identity',
                       'invocation', 'stall_episode', 'identity_provenance', 'progress_provenance')}
            notice.update(evidence_refs=evidence, request_key=key)
            if len(json.dumps(notices + [notice]).encode('utf-8')) > 16384:
                break
            notices.append(notice)
    return notices


def process_request_started(state_dir, coordinator, keys, request_id):
    if not keys:
        return True
    path = state_dir / 'health' / (coordinator + '.json')
    record = json.loads(path.read_text()) if path.exists() else {'seen_slots': []}
    deliveries = record.setdefault('process_request_delivery', {})
    for key in keys:
        old = deliveries.get(digest(key), {})
        if old.get('status') in ('sending', 'ambiguous', 'accepted') and old.get('request_id') != request_id:
            return False
    for key in keys:
        deliveries[digest(key)] = {'request_key': key, 'request_id': request_id, 'status': 'sending'}
    persist(path, record)
    return True


def process_request_result(state_dir, coordinator, keys, request_id, status):
    if not keys:
        return
    path = state_dir / 'health' / (coordinator + '.json')
    record = json.loads(path.read_text())
    deliveries = record.get('process_request_delivery', {})
    for key in keys:
        item = deliveries.get(digest(key))
        if item is not None and item.get('request_id') == request_id:
            item['status'] = status
    persist(path, record)


def record_processes(record, snapshot, slot, outcome):
    samples = []
    for parent, health in snapshot.get('process_health', {}).items():
        for sample in health.get('observations', []):
            if process_sample(sample, [parent]) and sample['slot'] == slot:
                samples.append(sample)
    if snapshot.get('process_health'):
        # The collector's exact samples remain owner evidence, never monitor attestations.
        previous = record.get('process_observations', [])
        merged = {digest([sample.get(key) for key in
                  ('owner_parent_id', 'kind', 'job_id', 'start_identity', 'invocation')]): sample
                  for sample in previous if process_sample(sample, snapshot.get('process_health', {}))}
        for sample in samples:
            identity = digest([sample.get(key) for key in
                       ('owner_parent_id', 'kind', 'job_id', 'start_identity', 'invocation')])
            old = merged.get(identity)
            if old is None or sample['slot'] >= old.get('slot', -1):
                merged[identity] = sample
        record['process_observations'] = list(merged.values())[-100:]
    request_keys = outcome.get('process_request_keys', [])
    accepted_keys = request_keys if outcome['status'] == 'accepted' else []
    deliveries = record.setdefault('process_request_delivery', {})
    if outcome['status'] in ('accepted', 'ambiguous', 'rejected'):
        for key in request_keys:
            old = deliveries.get(digest(key), {})
            deliveries[digest(key)] = old | {'request_key': key, 'status': outcome['status']}
    record['accepted_process_requests'] = [list(key) for key in sorted({
        tuple(key) for key in record.get('accepted_process_requests', [])
    } | {tuple(key) for key in accepted_keys})]


def worker_failures(snapshot):
    references = set()
    for parent, health in snapshot.get('worker_health', {}).items():
        for child in health.get('children', []):
            if (child.get('parent_id') == parent and child.get('lineage_verified') is True
                    and child.get('requires_parent_action') is True
                    and child.get('turn_status') == 'failed'
                    and all(isinstance(child.get(field), str) and child[field]
                            for field in ('child_id', 'turn_id', 'error_code'))):
                references.add((parent, child['child_id'], child['turn_id'], child['error_code']))
    return [list(reference) for reference in sorted(references)]


def pending_worker_failures(state_dir, recipient, snapshot):
    path = state_dir / 'health' / (recipient + '.json')
    record = json.loads(path.read_text()) if path.exists() else {}
    accepted = record.get('accepted_worker_failures', [])
    return [reference for reference in worker_failures(snapshot) if reference not in accepted]


def capture(client, state_dir, recipients, slot=None, history_cursor=None, *, parents=(), process_prior=None):
    parents = scoped_parents(parents)
    recipients = list(dict.fromkeys(canonical_uuid(recipient) for recipient in recipients))
    record = {'snapshot_id': str(uuid.uuid4()), 'queues': {}, 'errors': {}, 'history': {}}
    if slot is not None:
        record['slot'] = slot
    for recipient in dict.fromkeys(recipients):
        canonical_uuid(recipient)
        try:
            record['queues'][recipient] = queue_entries(client, recipient)
        except Exception:
            record['errors'][recipient] = 'queue inventory unavailable or incomplete; retry snapshot before reconciliation'
        record['history'][recipient] = history_refs(client, recipient, history_cursor)
    original_deadline = getattr(client, 'deadline', None)
    shared = CollectionClient(client)
    try:
        if original_deadline is not None:
            client.deadline = original_deadline - 5
        record['question_state'] = question_state(shared, state_dir, recipients)
        record['worker_health'] = worker_health(shared, parents, reserve=False)
        record['process_health'], record['process_health_source'] = process_health(
            shared, recipients, parents, slot, process_prior)
    finally:
        if original_deadline is not None:
            client.deadline = original_deadline
    record['collection_budget'] = {'max_calls': 256, 'calls_used': shared.calls_used,
                                   'reason_code': shared.reason_code}
    path = state_dir / 'snapshots' / (record['snapshot_id'] + '.json')
    persist(path, record)
    return record


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def retention_path(state_dir, recipient, identity):
    return state_dir / 'retentions' / (digest([recipient, identity]) + '.json')


def payload_signature(entry):
    return digest([entry['clientUserMessageId'], entry['input']])


def unacknowledged(state_dir, snapshot):
    queues = {}
    retained = 0
    for recipient, entries in snapshot['queues'].items():
        queues[recipient] = []
        for entry in entries:
            path = retention_path(state_dir, recipient, entry['id'])
            try:
                record = json.loads(path.read_text())
                matches = (record.get('active') is True and record.get('recipient') == recipient
                           and record.get('queue_id') == entry['id']
                           and record.get('payload_signature') == payload_signature(entry))
            except (OSError, ValueError, AttributeError):
                matches = False
            if matches:
                retained += 1
            else:
                queues[recipient].append(entry)
    return queues, retained


def inventory_signature(state_dir, snapshot):
    queues, _ = unacknowledged(state_dir, snapshot)
    return digest({'queues': queues, 'errors': snapshot['errors']})


def accepted_inventory(state_dir, recipient, snapshot):
    if (pending_worker_failures(state_dir, recipient, snapshot)
            or question_notices(state_dir, recipient, snapshot)
            or process_notices(state_dir, recipient, snapshot)):
        return False
    queues, retained = unacknowledged(state_dir, snapshot)
    if retained and not any(queues.values()) and not snapshot['errors']:
        return True
    path = state_dir / 'health' / (recipient + '.json')
    if snapshot['errors'] or not path.exists():
        return False
    return json.loads(path.read_text()).get('accepted_signature') == inventory_signature(state_dir, snapshot)


def health_event(state_dir, recipient, slot, snapshot_id, signature):
    snapshot_path = state_dir / 'snapshots' / (snapshot_id + '.json')
    message = (f'Monitor needs owner reconciliation for {recipient} after two distinct slots: '
               f'inspect local snapshot {snapshot_path}; classify queued work, preserve independent work, '
               'and explicitly monitor-ack handled, superseded or retained IDs. Check recipient clearance/native '
               'question state for deferred reminders. Accepted reminders do not acknowledge queue work.')
    subprocess.run([sys.executable, str(Path(__file__).with_name('event.py')), str(state_dir.parent),
                    'emit', 'monitor-stuck', f'{recipient}-{slot}-{signature}', message], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def record_health(state_dir, recipient, slot, snapshot, outcome):
    path = state_dir / 'health' / (recipient + '.json')
    record = json.loads(path.read_text()) if path.exists() else {'seen_slots': []}
    queues, retained = unacknowledged(state_dir, snapshot)
    previous_items = record.get('backlog_items', {})
    items = {thread: entries for thread, entries in previous_items.items()
             if thread in snapshot['errors']}
    for thread, entries in queues.items():
        items[thread] = {}
        for entry in entries:
            identity = entry['id']
            signature = payload_signature(entry)
            previous = previous_items.get(thread, {}).get(identity, {})
            slots = (list(previous.get('slots', []))
                     if previous.get('payload_signature') == signature else [])
            if slot not in slots:
                slots.append(slot)
            items[thread][identity] = {'payload_signature': signature, 'slots': slots, 'age': len(slots)}
    record['backlog_items'] = items
    record['backlog_slots'] = max((item['age'] for entries in items.values()
                                   for item in entries.values()), default=0)
    status = outcome.get('previousStatus', outcome['status'])
    user_wait = outcome.get('waiting_on_user') is True
    deferred = (status in ('deferred', 'blocked') and not user_wait) or bool(snapshot['errors'])
    degraded = any(history['status'] == 'unavailable'
                   or history.get('reason_code') in ('context_compaction', 'incomplete_page')
                   for history in snapshot.get('history', {}).values())
    if slot not in record['seen_slots']:
        record['seen_slots'].append(slot)
        record['deferral_slots'] = record.get('deferral_slots', 0) + 1 if deferred else 0
    if not deferred:
        record['deferral_slots'] = 0
    if outcome['status'] == 'accepted':
        record['accepted_signature'] = inventory_signature(state_dir, snapshot)
        # Delivery acceptance deduplicates reminders, never recovery or queue handling.
        record['accepted_worker_failures'] = sorted({
            tuple(reference) for reference in record.get('accepted_worker_failures', [])
        } | {tuple(reference) for reference in worker_failures(snapshot)})
    record_questions(record, snapshot, slot, outcome.get('question_notice_keys', [])
                     if outcome['status'] == 'accepted' else [])
    record_processes(record, snapshot, slot, outcome)
    failed = max(record.get('backlog_slots', 0), record.get('deferral_slots', 0)) >= 2
    workers_degraded = any(health.get('status') != 'complete' or health.get('complete') is not True
                           or health.get('schema_status') in ('unknown', 'unavailable')
                           for health in snapshot.get('worker_health', {}).values())
    questions_degraded = any(value.get('status') != 'complete' or value.get('complete') is not True
                             or any(q.get('state') == 'unknown' for q in value.get('questions', []))
                             for value in snapshot.get('question_state', {}).values())
    processes_degraded = snapshot.get('process_health_source', {}).get('status') == 'unavailable' or any(
        value.get('status') != 'complete' or value.get('complete') is not True
        or any(job.get('state') in ('stalled', 'unknown') for job in value.get('jobs', []))
        for value in snapshot.get('process_health', {}).values())
    health = {'process_health_status': ('degraded' if processes_degraded else
              'disabled' if snapshot.get('process_health_source', {}).get('status') == 'disabled' else 'ok'),
              'question_state_status': 'degraded' if questions_degraded else 'ok',
              'worker_health_status': 'degraded' if workers_degraded else 'ok',
              'monitor_status': 'failed' if failed else 'degraded' if degraded or workers_degraded or questions_degraded or processes_degraded else 'ok',
              'history_status': 'degraded' if degraded else 'ok', 'recipient': recipient,
              'snapshot_id': snapshot['snapshot_id'],
              'backlog_slots': record.get('backlog_slots', 0),
              'deferral_slots': record.get('deferral_slots', 0)}
    if failed:
        reasons = []
        if record.get('backlog_slots', 0) >= 2:
            reasons.append('unacknowledged queue items observed in two distinct slots; inspect snapshot and explicitly reconcile IDs')
        if record.get('deferral_slots', 0) >= 2:
            reasons.append('queue inventory or reminder delivery repeatedly deferred; inspect inventory errors and recipient clearance')
        health['monitor_reason'] = '; '.join(reasons)
    elif degraded or workers_degraded or questions_degraded or processes_degraded:
        reasons = []
        if degraded:
            reasons.append('history metadata incomplete or unavailable; inspect history diagnostics without inferring question clearance')
        if workers_degraded:
            reasons.append('worker metadata incomplete or unavailable; inspect worker health diagnostics without inferring recovery')
        if questions_degraded:
            reasons.append('question lifecycle or visibility unavailable; inspect question state diagnostics without inferring pending decisions or clearance')
        if processes_degraded:
            reasons.append('process metadata unavailable or owner action needed; inspect scoped process evidence without inferring resource closure')
        health['monitor_reason'] = '; '.join(reasons)
    record.pop('monitor_reason', None)
    record.update(health, last_delivery_status=outcome['status'])
    if not failed:
        record['reported'] = False
        record.pop('problem_signature', None)
        record.pop('episode_first_slot', None)
    elif not record.get('reported', False):
        problem_signature = digest({'items': {thread: sorted(identity for identity, item in entries.items()
                                                                    if item['age'] >= 2)
                                             for thread, entries in items.items()},
                                    'deferred': record.get('deferral_slots', 0) >= 2})
        record.update(problem_signature=problem_signature, episode_first_slot=slot)
        health_event(state_dir, recipient, slot, snapshot['snapshot_id'], problem_signature)
        record['reported'] = True
    persist(path, record)
    return health


def acknowledge(client, state_dir, recipient, snapshot_id, queue_ids, disposition, reason=None):
    canonical_uuid(recipient)
    canonical_uuid(snapshot_id)
    if disposition not in ('handled', 'superseded', 'retained') or not queue_ids:
        raise ValueError('explicit disposition and queue IDs required')
    if disposition == 'retained' and (not isinstance(reason, str) or not reason.strip()):
        raise ValueError('retention requires a nonempty reason')
    with locked(state_dir):
        snapshot = json.loads((state_dir / 'snapshots' / (snapshot_id + '.json')).read_text())
        if snapshot.get('snapshot_id') != snapshot_id or recipient not in snapshot.get('queues', {}):
            raise ValueError('snapshot recipient mismatch')
        originals = {entry['id']: entry for entry in snapshot['queues'][recipient]}
        if any(identity not in originals for identity in queue_ids):
            raise ValueError('queue ID not present in recipient snapshot')
        results = []
        for identity in dict.fromkeys(queue_ids):
            path = state_dir / 'acks' / (digest([recipient, snapshot_id, identity]) + '.json')
            operation = json.loads(path.read_text()) if path.exists() else {
                'recipient': recipient, 'snapshot_id': snapshot_id, 'queue_id': identity,
                'disposition': disposition, 'attempt': 0, 'attempts': []}
            retained_path = retention_path(state_dir, recipient, identity)
            if operation.get('state') == 'deleting':
                operation['state'] = 'ambiguous'
                if operation['attempts']:
                    operation['attempts'][-1]['state'] = 'ambiguous'
                operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': 'ambiguous'})
                persist(path, operation)
            if operation['disposition'] != disposition:
                raise ValueError('acknowledgement disposition differs from durable operation')
            if disposition in ('handled', 'superseded') and retained_path.exists():
                retention = json.loads(retained_path.read_text())
                retention['active'] = False
                retention.setdefault('history', []).append({'state': 'invalidated', 'snapshot_id': snapshot_id})
                persist(retained_path, retention)
            if operation.get('state') in ('deleted', 'confirmed_absent'):
                results.append({'queue_id': identity, 'state': operation['state']})
                continue
            # Every explicit invocation re-lists, including interrupted/ambiguous operations.
            try:
                current = {entry['id']: entry for entry in queue_entries(client, recipient)}
            except Exception:
                operation['state'] = 'unavailable'
                operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': 'unavailable'})
                persist(path, operation)
                results.append({'queue_id': identity, 'state': 'unavailable'})
                continue
            if identity not in current:
                operation['state'] = 'confirmed_absent'
                if disposition == 'retained' and retained_path.exists():
                    retention = json.loads(retained_path.read_text())
                    if (retention.get('active') is True and retention.get('recipient') == recipient
                            and retention.get('queue_id') == identity
                            and retention.get('payload_signature') == payload_signature(originals[identity])):
                        retention['active'] = False
                        retention.setdefault('history', []).append({
                            'state': 'confirmed_absent', 'snapshot_id': snapshot_id})
                        persist(retained_path, retention)
            elif payload_signature(current[identity]) != payload_signature(originals[identity]):
                operation['state'] = 'changed_payload'
            elif disposition == 'retained':
                retention = json.loads(retained_path.read_text()) if retained_path.exists() else {'history': []}
                retention.update(recipient=recipient, queue_id=identity, snapshot_id=snapshot_id,
                                 reason=reason, payload_signature=payload_signature(current[identity]), active=True)
                retention['history'].append({'state': 'retained', 'snapshot_id': snapshot_id})
                persist(retained_path, retention)
                operation.update(state='retained', reason=reason)
            else:
                if operation.get('state') == 'deleting' and operation['attempts']:
                    operation['attempts'][-1]['state'] = 'ambiguous'
                operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': operation.get('state', 'acknowledged')})
                operation.update(state='deleting', attempt=operation['attempt'] + 1)
                operation['attempts'].append({'attempt': operation['attempt'], 'state': 'deleting'})
                persist(path, operation)
                try:
                    response = client.call('thread/queue/delete', {
                        'threadId': recipient, 'queuedSubmissionId': identity})
                    if not isinstance(response, dict) or type(response.get('deleted')) is not bool:
                        raise ValueError('unknown deletion response')
                    if response['deleted']:
                        operation['state'] = 'deleted'
                    else:
                        after = {entry['id']: entry for entry in queue_entries(client, recipient)}
                        operation['state'] = 'confirmed_absent' if identity not in after else 'not_deleted'
                except Exception:
                    operation['state'] = 'ambiguous'
                    try:
                        after = {entry['id']: entry for entry in queue_entries(client, recipient)}
                        if identity not in after:
                            operation['state'] = 'confirmed_absent'
                    except Exception:
                        pass
            if operation.get('attempts') and operation['attempts'][-1]['state'] == 'deleting':
                operation['attempts'][-1]['state'] = operation['state']
            operation.setdefault('history', []).append({'attempt': operation['attempt'], 'state': operation['state']})
            persist(path, operation)
            results.append({'queue_id': identity, 'state': operation['state']})
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('snapshot', 'ack'))
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--control-socket', type=Path)
    parser.add_argument('--recipient', type=canonical_uuid, required=True)
    parser.add_argument('--snapshot', type=canonical_uuid)
    parser.add_argument('--history-cursor')
    parser.add_argument('--parent', type=canonical_uuid, action='append', default=[])
    parser.add_argument('--queue-id', action='append', default=[])
    parser.add_argument('--disposition', choices=('handled', 'superseded', 'retained'))
    parser.add_argument('--reason')
    args = parser.parse_args()
    try:
        args.parent = scoped_parents(args.parent)
    except ValueError as error:
        parser.error(str(error))
    if args.command == 'ack' and (not args.snapshot or not args.queue_id or not args.disposition):
        parser.error('ack requires --snapshot, --queue-id and --disposition')
    if args.disposition == 'retained' and not (args.reason and args.reason.strip()):
        parser.error('retained requires --reason')
    from codex_adapter import control_socket_available
    from unblock import CapabilityError, connect
    if not control_socket_available(args.control_socket):
        print(json.dumps({'status': 'unavailable', 'reason': 'configure an available absolute CODEX_CONTROL_SOCKET'}))
        return 1
    client = None
    try:
        client = connect(time.monotonic() + 25, args.control_socket)
        if args.command == 'snapshot':
            with locked(args.state_dir):
                snapshot = capture(client, args.state_dir, [args.recipient], history_cursor=args.history_cursor, parents=args.parent)
            print(json.dumps({'snapshot_id': snapshot['snapshot_id'],
                              'path': str(args.state_dir / 'snapshots' / (snapshot['snapshot_id'] + '.json')),
                              'queue_ids': [entry['id'] for entry in snapshot['queues'].get(args.recipient, [])],
                              'complete': not snapshot['errors'], 'history': snapshot['history'],
                              'worker_health': snapshot['worker_health'],
                              'question_state_status': {owner: value['status'] for owner, value in snapshot['question_state'].items()},
                              'collection_budget': snapshot['collection_budget'],
                              'process_health_source': snapshot['process_health_source'],
                              'process_health_status': {owner: value['status'] for owner, value in snapshot['process_health'].items()}}))
            return int(bool(snapshot['errors']))
        results = acknowledge(client, args.state_dir, args.recipient, args.snapshot, args.queue_id, args.disposition, args.reason)
        print(json.dumps({'results': results}))
        return int(any(row['state'] not in ('deleted', 'confirmed_absent', 'retained') for row in results))
    except CapabilityError as error:
        print(json.dumps({'status': 'unavailable', 'reason': str(error)}))
        return 1
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason': 'inspect local monitor state and retry explicit reconciliation'}))
        return 1
    finally:
        if client is not None:
            client.connection.close()


if __name__ == '__main__':
    raise SystemExit(main())
