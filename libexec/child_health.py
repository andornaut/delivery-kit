"""Bounded read-only child failure evidence for explicitly scoped parents.

The injected client implements call(method, params), returning decoded results.
This module performs no delivery, persistence, scheduling or lifecycle mutation.
"""
from datetime import datetime, timezone
from uuid import UUID


ERROR_CLASSES = {
    'contextWindowExceeded': 'context_exhaustion',
    'sessionBudgetExceeded': 'session_budget_exhaustion',
    'usageLimitExceeded': 'usage_limit',
    'modelNotFound': 'model_unavailable',
    'policyCapacityUnavailable': 'model_capacity',
}
THREAD_STATUSES = {'active', 'idle', 'notLoaded', 'systemError'}
TURN_STATUSES = {'completed', 'interrupted', 'failed', 'inProgress'}
PAGE_SIZE = 50
MAX_CHILDREN = 100


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


def _read(client, parent, child):
    response = client.call('thread/read', {'threadId': child, 'includeTurns': False})
    row = response.get('thread') if isinstance(response, dict) else None
    if not isinstance(row, dict) or row.get('id') != child or not _lineage(parent, row):
        return None
    stamp = row.get('updatedAt')
    return {'status': {'type': _status(row)},
            'updatedAt': stamp if type(stamp) is int else None}


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


def _child(client, parent, child, observed):
    result = dict(parent_id=parent, child_id=child, thread_status=None,
                  turn_id=None, turn_status=None, error_code=None,
                  classification='unknown', requires_parent_action=False,
                  observed_at=observed, provenance='native_protocol',
                  lineage_verified=False, status='unavailable', complete=False,
                  diagnostics=[])
    try:
        row = _read(client, parent, child)
        if row is None:
            result['diagnostics'].append('lineage_unverified')
            return result
        result['lineage_verified'] = True
        result['thread_status'] = _status(row)
        turn, diagnostic = _latest(client, child)
        if diagnostic:
            result['diagnostics'].append(diagnostic)
            return result
        if not turn:
            result.update(status='complete', complete=True)
            return result
        result.update(turn_id=turn['id'], turn_status=turn['status'],
                      error_code=turn['error_code'])
        # Re-read both metadata and the latest turn to reject concurrent resumption.
        fresh = _read(client, parent, child)
        latest, diagnostic = _latest(client, child)
        if fresh is None:
            result['lineage_verified'] = False
        if (fresh is None or _status(fresh) != result['thread_status']
                or fresh.get('updatedAt') != row.get('updatedAt')
                or diagnostic or latest != turn):
            result.update(status='partial', diagnostics=['observation_changed'])
            return result
        if result['thread_status'] is None:
            result['diagnostics'].append('thread_schema_unavailable')
            return result
        result.update(status='complete', complete=True)
        if turn['status'] == 'failed' and result['thread_status'] != 'active' and result['error_code']:
            result.update(classification=ERROR_CLASSES[result['error_code']],
                          requires_parent_action=True)
        return result
    except Exception:
        result['diagnostics'].append('native_read_unavailable')
        return result


def collect(client, parents, *, max_pages=10):
    """Return safe worker health keyed by canonical exact parent UUID.

    max_pages bounds each active/archived inventory (50 rows per page).
    At most 100 verified direct children are inspected per parent, with four
    read-only calls each. The caller bounds transport time and the parent list.
    Exhaustion requires an allowlisted code on a stable latest failed turn.
    Completeness covers the bounded latest-turn observation, not full history.
    Historical pagination is unnecessary: only the newest turn is evaluated.
    Slot and delivery deduplication belongs to the caller, keyed by parent_id,
    child_id, turn_id and error_code. Acceptance never means handling.
    """
    if type(max_pages) is not int or not 1 <= max_pages <= 100:
        raise ValueError('invalid_max_pages')
    if not isinstance(parents, (list, tuple)) or not all(_uuid(p) for p in parents):
        raise ValueError('invalid_parent_scope')
    observed = datetime.now(timezone.utc).isoformat()
    output = {}
    for parent in dict.fromkeys(parents):
        result = dict(status='complete', complete=True, children=[], diagnostics=[],
                      observed_at=observed, provenance='native_protocol',
                      schema_status='available', inventories={})
        output[parent] = result
        children = {}
        rejected = set()
        for archived in (False, True):
            inventory = dict(status='complete', complete=True, pages=0, diagnostics=[])
            result['inventories']['archived' if archived else 'active'] = inventory
            cursor = None
            seen = set()
            try:
                for _ in range(max_pages):
                    params = dict(parentThreadId=parent, sourceKinds=['subAgentThreadSpawn'],
                                  archived=archived, limit=PAGE_SIZE, useStateDbOnly=True)
                    if cursor is not None:
                        params['cursor'] = cursor
                    page = client.call('thread/list', params)
                    if not isinstance(page, dict) or not isinstance(page.get('data'), list):
                        raise ValueError('schema')
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
                        if child in children or len(children) < MAX_CHILDREN:
                            children[child] = True
                        else:
                            inventory['diagnostics'].append('child_bound_exceeded')
                    cursor = page.get('nextCursor')
                    if cursor is None:
                        break
                    if not isinstance(cursor, str) or not cursor or cursor in seen:
                        inventory['diagnostics'].append('pagination_invalid')
                        break
                    seen.add(cursor)
                else:
                    inventory['diagnostics'].append('page_bound_reached')
            except Exception:
                inventory['diagnostics'].append('native_inventory_unavailable')
            inventory['diagnostics'] = sorted(set(inventory['diagnostics']))
            if inventory['diagnostics']:
                inventory.update(status='partial' if inventory['pages'] else 'unavailable', complete=False)
        for child in sorted(children.keys() - rejected):
            result['children'].append(_child(client, parent, child, observed))
        parts = list(result['inventories'].values()) + result['children']
        result['complete'] = all(p['complete'] for p in parts)
        if not result['complete']:
            result['status'] = 'unavailable' if all(
                p['status'] == 'unavailable' for p in result['inventories'].values()) else 'partial'
            result['diagnostics'] = sorted({code for p in parts for code in p['diagnostics']})
            if any('schema' in code for code in result['diagnostics']):
                result['schema_status'] = 'unavailable'
        if any(p['status'] == 'unavailable' for p in result['inventories'].values()):
            result['schema_status'] = 'unknown'
    return output
