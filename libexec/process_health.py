"""Read-only health for optional, nonsecret, exact owner-registered jobs.

The owner manifest supplies runtime identity and progress attestations. Scoped
native command metadata corroborates invocation references, never host liveness.
Only owners close resources. No process getter, host probe or lifecycle mutation
is used. All identifiers and evidence codes must be nonsecret tokens.
"""
from datetime import datetime, timezone
import json
import math
import re
import time
import uuid


MAX_BYTES = 1048576
MAX_JOBS = 100
MAX_CALLS = 256
MAX_AGE = 1800
KINDS = {'process', 'container', 'browser_job'}
STATES = {'running', 'blocked', 'terminal', 'waiting_on_user', 'service', 'unknown'}
CLOSURES = {'requested', 'delivery_accepted', 'ambiguous', 'reported_closed',
            'verified_closed', 'blocked', 'retained'}
BLOCKS = {'deadlock', 'dependency_failure', 'unresponsive', 'owner_confirmed_block'}
IDENTITY = ('owner_parent_id', 'worker_id', 'kind', 'job_id', 'start_identity', 'invocation')
TOKEN = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z')


def _token(value):
    return isinstance(value, str) and TOKEN.fullmatch(value) is not None



def _choice(value, choices):
    return isinstance(value, str) and value in choices

def _uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _stamp(value):
    try:
        if not isinstance(value, str) or not value.endswith(('Z', '+00:00')):
            return None
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
            return None
        return parsed.timestamp()
    except (ValueError, OverflowError):
        return None


def _fresh(now, value):
    stamp = _stamp(value)
    return stamp is not None and 0 <= now - stamp <= MAX_AGE


def _reference(value):
    if (not isinstance(value, dict) or not _uuid(value.get('thread_id'))
            or not _token(value.get('turn_id')) or not _token(value.get('item_id'))):
        return None
    return {key: value[key] for key in ('thread_id', 'turn_id', 'item_id')}


def _identity(value):
    if not isinstance(value, dict):
        return None
    parent, worker = value.get('owner_parent_id'), value.get('worker_id')
    invocation = _reference(value.get('invocation'))
    if (not _uuid(parent) or (worker is not None and (not _uuid(worker) or worker == parent))
            or not _choice(value.get('kind'), KINDS) or not _token(value.get('job_id'))
            or not _token(value.get('start_identity')) or invocation is None
            or invocation['thread_id'] != (worker or parent)):
        return None
    return {'owner_parent_id': parent, 'worker_id': worker, 'kind': value['kind'],
            'job_id': value['job_id'], 'start_identity': value['start_identity'],
            'invocation': invocation}


def _progress(value):
    if (not isinstance(value, dict) or not _token(value.get('contract_id'))
            or not _token(value.get('epoch')) or type(value.get('counter')) is not int
            or not 0 <= value['counter'] <= 2**63 - 1
            or type(value.get('expected_to_advance')) is not bool):
        return None
    return {key: value[key] for key in ('contract_id', 'epoch', 'counter', 'expected_to_advance')}


def _blocked(value):
    if (not isinstance(value, dict) or value.get('confirmed') is not True
            or not _choice(value.get('code'), BLOCKS) or not _token(value.get('evidence_id'))):
        return None
    return {key: value[key] for key in ('confirmed', 'code', 'evidence_id')}


def _evidence(now, parent, value):
    if (not isinstance(value, dict) or value.get('confirmed_by') != parent
            or value.get('identity_verified') is not True
            or value.get('provenance') != 'owner_attested' or not _choice(value.get('state'), STATES)
            or not _fresh(now, value.get('confirmed_at'))):
        return None
    result = {key: value[key] for key in ('confirmed_by', 'confirmed_at', 'identity_verified',
                                         'provenance', 'state')}
    if type(value.get('confirmed_stalled')) is bool:
        result['confirmed_stalled'] = value['confirmed_stalled']
    if _token(value.get('episode_id')):
        result['episode_id'] = value['episode_id']
    progress, blocked = _progress(value.get('progress')), _blocked(value.get('blocked_condition'))
    if progress is not None:
        result['progress'] = progress
    if blocked is not None:
        result['blocked_condition'] = blocked
    return result


class _Reader:
    def __init__(self, client):
        self.client, self.calls, self.reason = client, 0, None

    def call(self, method, params):
        deadline = getattr(self.client, 'deadline', None)
        if (type(deadline) in (int, float) and math.isfinite(deadline)
                and time.monotonic() >= deadline):
            self.reason = 'native_deadline_exhausted'
        if self.calls >= MAX_CALLS and self.reason is None:
            self.reason = 'native_call_budget_exhausted'
        if self.reason:
            raise TimeoutError('native budget unavailable')
        self.calls += 1
        try:
            return self.client.call(method, params)
        except TimeoutError:
            self.reason = 'native_timeout'
            raise

    def metadata(self):
        return {'max_calls': MAX_CALLS, 'calls_used': self.calls,
                'exhausted': self.reason is not None, 'reason_code': self.reason}


def _lineage(reader, parent, worker):
    if worker is None:
        return True
    response = reader.call('thread/read', {'threadId': worker, 'includeTurns': False})
    thread = response.get('thread') if isinstance(response, dict) else None
    if (not isinstance(thread, dict) or thread.get('id') != worker
            or thread.get('parentThreadId') != parent):
        return False
    source = thread.get('source')
    if isinstance(source, dict) and 'subAgent' in source:
        subagent = source['subAgent']
        if not isinstance(subagent, dict):
            return False
        spawn = subagent.get('thread_spawn')
        if not isinstance(spawn, dict) or spawn.get('parent_thread_id') != parent:
            return False
    return True


def _command(reader, reference):
    response = reader.call('thread/items/read', {
        'threadId': reference['thread_id'], 'turnId': reference['turn_id'],
        'itemIds': [reference['item_id']]})
    entries = response.get('data') if isinstance(response, dict) else None
    if not isinstance(entries, list) or len(entries) != 1:
        return None
    entry = entries[0]
    if (not isinstance(entry, dict) or entry.get('turnId') != reference['turn_id']
            or entry.get('threadId', reference['thread_id']) != reference['thread_id']):
        return None
    item = entry.get('item')
    if (not isinstance(item, dict) or item.get('id') != reference['item_id']
            or item.get('type') != 'commandExecution'
            or not _choice(item.get('status'), ('inProgress', 'completed', 'failed', 'declined'))):
        return None
    exit_code = item.get('exitCode')
    return {'native_status': item['status'],
            'exit_code': exit_code if type(exit_code) is int and -2**31 <= exit_code < 2**31 else None}


def _closure(reader, now, identity, value):
    if value is None:
        return 'none', None, None, []
    if (not isinstance(value, dict) or any(value.get(key) != identity[key] for key in IDENTITY
                                           if key != 'worker_id')
            or value.get('confirmed_by') != identity['owner_parent_id']
            or value.get('provenance') != 'owner_attested'
            or not _choice(value.get('state'), CLOSURES) or not _token(value.get('evidence_id'))
            or not _fresh(now, value.get('confirmed_at'))):
        return 'unknown', None, None, ['closure_receipt_unavailable']
    state = value['state']
    if state in ('blocked', 'retained') and not _token(value.get('reason_code')):
        return 'unknown', None, None, ['closure_receipt_unavailable']
    if state == 'retained' and (type(value.get('next_review_slot')) is not int
                                or value['next_review_slot'] < 0):
        return 'unknown', None, None, ['closure_receipt_unavailable']
    if state != 'verified_closed':
        return state, 'owner_attested', None, []
    reference = _reference(value.get('native_result_ref'))
    if (value.get('owner_verified') is not True or value.get('verification_succeeded') is not True
            or reference is None or reference == identity['invocation']
            or reference['thread_id'] not in {
                identity['owner_parent_id'], identity['worker_id']}):
        return 'reported_closed', 'owner_attested', None, ['closure_verification_unavailable']
    try:
        command = _command(reader, reference)
    except Exception:
        command = None
    if command is None or command['native_status'] != 'completed' or command['exit_code'] != 0:
        return 'reported_closed', 'owner_attested', None, ['closure_verification_unavailable']
    return 'verified_closed', 'owner_verified_native_result_corroborated', reference, []



def _scheduled_capture(slot, collected_at):
    return (type(slot) is int and slot >= 0 and slot % 60 == 0
            and collected_at is not None and 0 <= collected_at - slot < 60)

def _two_samples(now, slot, identity, evidence, prior):
    if not _scheduled_capture(slot, now):
        return False
    progress, blocked = evidence.get('progress'), evidence.get('blocked_condition')
    if (progress is None or progress['expected_to_advance'] is not True or blocked is None
            or 'episode_id' not in evidence):
        return False
    for sample in prior:
        if (not isinstance(sample, dict) or any(sample.get(key) != identity[key] for key in IDENTITY)
                or sample.get('protected') is not False or sample.get('provenance') != 'owner_attested'
                or type(sample.get('slot')) is not int or not 0 <= sample['slot'] < slot):
            continue
        collected_at = _stamp(sample.get('collected_at'))
        if (not _scheduled_capture(sample['slot'], collected_at) or collected_at > now):
            continue
        # Prior evidence is evaluated at its original scheduled observation.
        # The caller supplies trusted typed snapshots; this is not native proof.
        old = _evidence(collected_at, identity['owner_parent_id'], sample.get('owner_evidence'))
        if (old is None or old['state'] not in ('running', 'blocked')
                or old.get('episode_id') != evidence['episode_id']
                or old.get('progress') != progress or old.get('blocked_condition') != blocked
                or _stamp(old['confirmed_at']) >= _stamp(evidence['confirmed_at'])):
            continue
        return True
    return False


def _manifest(value):
    if (not isinstance(value, dict) or type(value.get('version')) is not int
            or value['version'] != 1 or not isinstance(value.get('jobs'), list)):
        return None
    try:
        size = 0
        for chunk in json.JSONEncoder(ensure_ascii=False).iterencode(value):
            size += len(chunk.encode('utf-8'))
            if size > MAX_BYTES:
                return None
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return None
    return value['jobs']


def collect(client, registrations, *, allowed_parents, slot, prior_observations=None):
    """Return exact allowed-parent metadata for an optional owner-record backend.

    registrations is {version: 1, jobs: [...]}, at most 1 MiB and 100 inspected
    jobs. All tokens are declared nonsecret. Only exact scoped thread/read and
    thread/items/read calls are made, bounded by 256 calls and client.deadline.
    The caller reserves delivery time; this module never changes the deadline.

    Runtime identity, state and progress remain owner_attested. A native exit
    result alone proves neither runtime identity nor closure. verified_closed
    means explicit owner verification corroborated by its successful native
    result reference, never direct host verification. Collector output is data
    for closure requests to the owner, never authority to mutate resources.

    slot=None is observational: it neither infers two-sample stalls nor emits
    scheduled observations. Prior observations are trusted typed owner-attested
    snapshots, not native liveness proof. Their evidence must have been fresh at
    collected_at, within the original slot's existing 60-second minute window.
    No particular interval between distinct scheduled slots is assumed.
    """
    if (not isinstance(allowed_parents, (list, tuple)) or not all(_uuid(p) for p in allowed_parents)
            or len(allowed_parents) != len(set(allowed_parents))):
        raise ValueError('invalid_parent_scope')
    if slot is not None and (type(slot) is not int or slot < 0):
        raise ValueError('invalid_slot')
    reader, now = _Reader(client), time.time()
    output = {parent: {'status': 'complete', 'complete': True, 'jobs': [], 'observations': [],
                      'diagnostics': ['live_process_getter_unavailable'], 'omitted_jobs': 0}
              for parent in allowed_parents}
    jobs = _manifest(registrations)
    if jobs is None:
        for result in output.values():
            result.update(status='unavailable', complete=False, budget=reader.metadata())
            result['diagnostics'].append('owner_manifest_unavailable')
        return output
    prior = prior_observations if isinstance(prior_observations, list) else []
    prior = prior[:MAX_JOBS * 2]
    seen = {}
    for registration in jobs[:MAX_JOBS]:
        identity = _identity(registration)
        if identity is None or identity['owner_parent_id'] not in output:
            for result in output.values():
                result['complete'] = False
                result['diagnostics'].append('registration_invalid_or_out_of_scope')
            continue
        result = output[identity['owner_parent_id']]
        key = tuple(identity[field] for field in IDENTITY[:-1])
        if key in seen:
            result['complete'] = False
            result['diagnostics'].append('duplicate_job_identity')
            previous = seen[key]
            previous.update(state='unknown', requires_owner_action=False, stall_episode=None)
            previous['diagnostics'].append('duplicate_job_identity')
            result['observations'] = [sample for sample in result['observations']
                                      if any(sample[field] != identity[field] for field in IDENTITY[:-1])]
            continue
        row = identity | {'protected': registration.get('protected', False),
            'identity_provenance': 'owner_attested', 'progress_provenance': 'owner_attested',
            'lineage_verified': False, 'invocation_verified': False,
            'native_status': None, 'exit_code': None, 'state': 'unknown', 'stall_episode': None,
            'requires_owner_action': False, 'closure_status': 'unknown',
            'closure_provenance': None, 'closure_result_ref': None,
            'closure_evidence_id': None, 'closure_reason_code': None,
            'closure_next_review_slot': None, 'diagnostics': []}
        seen[key] = row
        result['jobs'].append(row)
        evidence = _evidence(now, identity['owner_parent_id'], registration.get('owner_evidence'))
        if evidence is None or type(row['protected']) is not bool:
            row['protected'] = True
            row['diagnostics'].append('owner_identity_or_evidence_unavailable')
            continue
        try:
            row['lineage_verified'] = _lineage(reader, identity['owner_parent_id'], identity['worker_id'])
            if not row['lineage_verified']:
                row['diagnostics'].append('worker_lineage_unverified')
                continue
            command = _command(reader, identity['invocation'])
            if command is None:
                row['diagnostics'].append('native_invocation_unavailable')
                continue
            row.update(command, invocation_verified=True)
            closure, provenance, reference, diagnostics = _closure(reader, now, identity,
                                                                  registration.get('closure'))
            row.update(closure_status=closure, closure_provenance=provenance,
                       closure_result_ref=reference)
            row['diagnostics'].extend(diagnostics)
            if closure not in ('none', 'unknown'):
                receipt = registration['closure']
                row['closure_evidence_id'] = receipt['evidence_id']
                if closure in ('blocked', 'retained'):
                    row['closure_reason_code'] = receipt['reason_code']
                if closure == 'retained':
                    row['closure_next_review_slot'] = receipt['next_review_slot']
        except Exception:
            row['diagnostics'].append(reader.reason or 'native_metadata_unavailable')
            continue
        state = evidence['state']
        row['state'] = {'waiting_on_user': 'blocked', 'service': 'running'}.get(state, state)
        if state in ('waiting_on_user', 'service'):
            row['protected'] = True
        if (state in ('running', 'blocked') and not row['protected']
                and 'episode_id' in evidence
                and (evidence.get('confirmed_stalled') is True
                     or _two_samples(now, slot, identity, evidence, prior))):
            row.update(state='stalled', stall_episode=evidence['episode_id'],
                       requires_owner_action=closure in
                       ('none', 'requested', 'delivery_accepted', 'ambiguous'))
        if _scheduled_capture(slot, now):
            result['observations'].append(identity | {
                'slot': slot, 'collected_at': datetime.fromtimestamp(now, timezone.utc).isoformat(),
                'provenance': 'owner_attested', 'protected': row['protected'],
                'owner_evidence': evidence})
        elif slot is not None:
            result['diagnostics'].append('scheduled_sample_time_unavailable')
    for result in output.values():
        if len(jobs) > MAX_JOBS:
            result.update(complete=False, omitted_jobs=len(jobs) - MAX_JOBS)
            result['diagnostics'].append('job_bound_exceeded')
        if any(job['state'] == 'unknown' or job['diagnostics'] for job in result['jobs']):
            result['complete'] = False
        result['status'] = 'complete' if result['complete'] else 'partial'
        result['diagnostics'] = sorted(set(result['diagnostics']))
        result['budget'] = reader.metadata()
    return output
