"""Bounded read-only child failure evidence for explicitly scoped parents.

The injected client implements call(method, params), returning decoded results.
This module performs no delivery, persistence, scheduling or lifecycle mutation.
"""
from collections import deque
from datetime import datetime, timezone
from uuid import UUID
import math
import time


ERROR_CLASSES = {
    'contextWindowExceeded': 'context_exhaustion',
    'sessionBudgetExceeded': 'session_budget_exhaustion',
    'usageLimitExceeded': 'usage_limit',
    'rateLimitExceeded': 'rate_limit',
    'flexUnavailable': 'flex_capacity',
    'serverOverloaded': 'server_capacity',
    'modelNotFound': 'model_unavailable',
    'policyCapacityUnavailable': 'model_capacity',
}
THREAD_STATUSES = {'active', 'idle', 'notLoaded', 'systemError'}
TURN_STATUSES = {'completed', 'interrupted', 'failed', 'inProgress'}
PAGE_SIZE = 50
MAX_CHILDREN = 100
MAX_CALLS = 256


class _BudgetExhausted(Exception):
    pass


class _Budget:
    def __init__(self, client):
        self.client = client
        self.calls_used = 0
        self.reason = None

    def check(self):
        deadline = getattr(self.client, 'deadline', None)
        if (type(deadline) in (int, float) and math.isfinite(deadline)
                and time.monotonic() >= deadline):
            self.reason = 'native_deadline_exhausted'
        if self.reason is None and self.calls_used >= MAX_CALLS:
            self.reason = 'native_call_budget_exhausted'
        if self.reason:
            raise _BudgetExhausted()

    def call(self, method, params):
        self.check()
        self.calls_used += 1
        try:
            return self.client.call(method, params)
        except TimeoutError:
            self.reason = 'native_timeout'
            raise _BudgetExhausted() from None
        except Exception:
            self.check()
            raise

    def metadata(self):
        return {'max_calls': MAX_CALLS, 'calls_used': self.calls_used,
                'exhausted': self.reason is not None, 'reason_code': self.reason}



def _uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def _lineage(parent, row):
    if not isinstance(row, dict) or row.get('parentThreadId') != parent:
        return False
    source = row.get('source')
    if isinstance(source, dict) and 'subAgent' in source:
        subagent = source['subAgent']
        if not isinstance(subagent, dict) or 'thread_spawn' not in subagent:
            return False
        spawn = subagent['thread_spawn']
        if not isinstance(spawn, dict) or spawn.get('parent_thread_id') != parent:
            return False
    return True


def _status(row):
    status = row.get('status')
    if isinstance(status, dict) and status.get('type') in THREAD_STATUSES:
        return status['type']
    return None


def _metadata(row):
    status = _status(row)
    stamp = row.get('updatedAt')
    if status is None or type(stamp) is not int:
        return None
    return {'status': {'type': status}, 'updatedAt': stamp}


def _read(client, parent, child):
    response = client.call('thread/read', {'threadId': child, 'includeTurns': False})
    row = response.get('thread') if isinstance(response, dict) else None
    if not isinstance(row, dict) or row.get('id') != child or not _lineage(parent, row):
        return None
    return _metadata(row)


def _latest(client, child):
    response = client.call('thread/turns/list', {
        'threadId': child, 'sortDirection': 'desc',
        'limit': 1, 'itemsView': 'notLoaded'})
    if not isinstance(response, dict) or not isinstance(response.get('data'), list):
        return None, 'turn_schema_unavailable'
    turns = response['data']
    if len(turns) > 1:
        return None, 'turn_bound_exceeded'
    if not turns:
        return (None, 'latest_turn_unavailable') if response.get('nextCursor') is not None else ({}, None)
    turn = turns[0]
    if (not isinstance(turn, dict) or not _uuid(turn.get('id'))
            or turn.get('status') not in TURN_STATUSES):
        return None, 'turn_schema_unavailable'
    error = turn.get('error')
    code = error.get('codexErrorInfo') if isinstance(error, dict) else None
    return {'id': turn['id'], 'status': turn['status'],
            'error_code': code if isinstance(code, str) and code in ERROR_CLASSES else None}, None


def _child(client, observed, parent, child, row):
    result = dict(parent_id=parent, child_id=child, thread_status=None,
                  turn_id=None, turn_status=None, error_code=None,
                  classification='unknown', requires_parent_action=False,
                  observed_at=observed, provenance='native_protocol',
                  lineage_verified=True, status='unavailable', complete=False,
                  diagnostics=[])
    observed_turn = False
    try:
        if row is None:
            result['diagnostics'].append('thread_schema_unavailable')
            return result, observed_turn
        result['thread_status'] = _status(row)
        turn, diagnostic = _latest(client, child)
        if diagnostic:
            result['diagnostics'].append(diagnostic)
            return result, observed_turn
        observed_turn = True
        if turn:
            result.update(turn_id=turn['id'], turn_status=turn['status'],
                          error_code=turn['error_code'])
        # Noncandidates retain an observation, never a clearance or recovery claim.
        if (not turn or turn['status'] != 'failed' or not turn['error_code']
                or result['thread_status'] == 'active'):
            result.update(status='complete', complete=True)
            return result, observed_turn
        # Only a typed failed candidate needs fresh lineage and resumption checks.
        fresh = _read(client, parent, child)
        latest, diagnostic = _latest(client, child)
        if fresh is None:
            result['lineage_verified'] = False
        if fresh != row or diagnostic or latest != turn:
            result.update(status='partial', diagnostics=['observation_changed'], error_code=None)
            if fresh is not None:
                result['thread_status'] = _status(fresh)
            if latest:
                result.update(turn_id=latest['id'], turn_status=latest['status'],
                              error_code=latest['error_code'])
            return result, observed_turn
        result.update(status='complete', complete=True,
                      classification=ERROR_CLASSES[turn['error_code']],
                      requires_parent_action=True)
    except _BudgetExhausted:
        result.update(status='partial' if observed_turn else 'unavailable',
                      diagnostics=[client.reason])
    except Exception:
        result.update(status='partial' if observed_turn else 'unavailable',
                      diagnostics=['native_read_unavailable'])
    return result, observed_turn


def _inventory_page(client, parent, archived, inventory, children, rejected, cursors):
    params = dict(parentThreadId=parent, sourceKinds=['subAgentThreadSpawn'],
                  archived=archived, limit=PAGE_SIZE, useStateDbOnly=True)
    if inventory['cursor'] is not None:
        params['cursor'] = inventory['cursor']
    page = client.call('thread/list', params)
    if not isinstance(page, dict) or not isinstance(page.get('data'), list):
        inventory['diagnostics'].append('inventory_schema_unavailable')
        return False
    inventory['pages'] += 1
    rows = page['data']
    if len(rows) > PAGE_SIZE:
        inventory['diagnostics'].append('page_bound_exceeded')
    for row in rows[:PAGE_SIZE]:
        child = row.get('id') if isinstance(row, dict) else None
        if not _uuid(child) or child == parent or not _lineage(parent, row):
            inventory['diagnostics'].append('lineage_unverified')
            if _uuid(child):
                rejected.add(child)
            continue
        metadata = _metadata(row)
        if child in children and children[child] != metadata:
            inventory['diagnostics'].append('inventory_observation_changed')
            children[child] = None
        else:
            children[child] = metadata
    cursor = page.get('nextCursor')
    if cursor is None:
        return False
    if not isinstance(cursor, str) or not cursor or cursor in cursors:
        inventory['diagnostics'].append('pagination_invalid')
        return False
    cursors.add(cursor)
    inventory['cursor'] = cursor
    return True


def collect(client, parents, *, max_pages=10):
    """Return safe worker health keyed by canonical exact parent UUID.

    Round-robin inventory pages cover active and archived direct children only.
    Validated inventory metadata supplies each child's initial observation.
    One newest-turn read observes a child; only typed failed candidates receive
    a fresh metadata read and newest-turn reread before becoming actionable.
    Round-robin child visits inspect at most 100 children per parent. max_pages
    bounds each inventory stream (50 rows/page), with 256 calls overall and an
    optional monotonic client.deadline. The caller bounds transport time.

    counts.discovered counts unique verified listed IDs, excluding conflicting
    lineage; it never counts unknown unlisted children. counts.observed counts
    successful newest-turn observations, including empty turns. counts.validated
    counts actionable matched candidates only. omitted = discovered - observed.
    Completeness covers these bounded observations, never full historical turns,
    decision clearance, recovery or handling. The caller owns slot/delivery dedup
    by parent_id, child_id, turn_id and error_code. No state is persisted here.
    """
    if type(max_pages) is not int or not 1 <= max_pages <= 100:
        raise ValueError('invalid_max_pages')
    if not isinstance(parents, (list, tuple)) or not all(_uuid(p) for p in parents):
        raise ValueError('invalid_parent_scope')
    observed = datetime.now(timezone.utc).isoformat()
    output = {}
    scoped_children = {}
    rejected = {}
    streams = deque()
    cursors = {}
    client = _Budget(client)
    for parent in dict.fromkeys(parents):
        output[parent] = dict(status='complete', complete=True, children=[], diagnostics=[],
                              observed_at=observed, provenance='native_protocol',
                              schema_status='available', inventories={},
                              counts=dict(discovered=0, observed=0, validated=0, omitted=0))
        scoped_children[parent] = {}
        rejected[parent] = set()
    for archived in (False, True):
        for parent, result in output.items():
            inventory = dict(status='complete', complete=True, pages=0, diagnostics=[], cursor=None)
            result['inventories']['archived' if archived else 'active'] = inventory
            streams.append((parent, archived))
            cursors[parent, archived] = set()
    while streams:
        parent, archived = streams.popleft()
        inventory = output[parent]['inventories']['archived' if archived else 'active']
        try:
            more = _inventory_page(client, parent, archived, inventory,
                                   scoped_children[parent], rejected[parent], cursors[parent, archived])
            if more:
                if inventory['pages'] < max_pages:
                    streams.append((parent, archived))
                else:
                    inventory['diagnostics'].append('page_bound_reached')
        except _BudgetExhausted:
            inventory['diagnostics'].append(client.reason)
        except Exception:
            inventory['diagnostics'].append('native_inventory_unavailable')
    visits = deque()
    for parent, result in output.items():
        for child in rejected[parent]:
            scoped_children[parent].pop(child, None)
        children = sorted(scoped_children[parent])
        result['counts']['discovered'] = len(children)
        if len(children) > MAX_CHILDREN:
            result['diagnostics'].append('child_bound_exceeded')
        if children:
            visits.append((parent, iter(children[:MAX_CHILDREN])))
    while visits:
        parent, children = visits.popleft()
        child = next(children, None)
        if child is None:
            continue
        result = output[parent]
        health, observed_turn = _child(client, observed, parent, child, scoped_children[parent][child])
        result['children'].append(health)
        result['counts']['observed'] += int(observed_turn)
        result['counts']['validated'] += int(health['requires_parent_action'])
        visits.append((parent, children))
    for result in output.values():
        for inventory in result['inventories'].values():
            inventory.pop('cursor')
            inventory['diagnostics'] = sorted(set(inventory['diagnostics']))
            if inventory['diagnostics']:
                inventory.update(status='partial' if inventory['pages'] else 'unavailable', complete=False)
        counts = result['counts']
        counts['omitted'] = counts['discovered'] - counts['observed']
        parts = list(result['inventories'].values()) + result['children']
        result['complete'] = not result['diagnostics'] and all(p['complete'] for p in parts)
        if not result['complete']:
            result['status'] = 'unavailable' if all(
                p['status'] == 'unavailable' for p in result['inventories'].values()) else 'partial'
            result['diagnostics'] = sorted(set(result['diagnostics']) |
                                           {code for p in parts for code in p['diagnostics']})
            if any('schema' in code for code in result['diagnostics']):
                result['schema_status'] = 'unavailable'
        if any(p['status'] == 'unavailable' for p in result['inventories'].values()):
            result['schema_status'] = 'unknown'
        result['budget'] = client.metadata()
    return output
