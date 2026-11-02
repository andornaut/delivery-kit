"""Optional Codex session metadata adapter; no native connections during resolution."""
import json
from pathlib import Path
import sys
import uuid


def control_socket_available(path):
    try:
        return path is not None and path.is_absolute() and path.is_socket()
    except OSError:
        return False


def resolve_peers(session_map, shared_targets, project_root, shared_roles, coordinator):
    roles = json.loads(Path(session_map).read_text())["codex"]
    coordinator = str(uuid.UUID(coordinator))
    if str(uuid.UUID(roles["tech"])) != coordinator:
        raise ValueError("coordinator mismatch")
    peers = [str(uuid.UUID(roles[role])) for role in ("art", "gameplay")]
    if len(set([coordinator, *peers])) != 3:
        raise ValueError("roles must be distinct")
    try:
        config = json.loads(Path(shared_targets).read_text())
        host_matches = (
            type(config.get("version")) is int and config["version"] == 1
            and config.get("harness") == "codex"
            and str(uuid.UUID(config["host_coordinator_thread_id"])) == coordinator
            and Path(config["host_project_root"]).resolve() == Path(project_root).resolve()
        )
        if host_matches and isinstance(config.get("targets"), list):
            for target in config["targets"]:
                if (not isinstance(target, dict) or target.get("ownership") != "active"
                        or target.get("role") not in shared_roles.split()):
                    continue
                try:
                    peer = str(uuid.UUID(target["thread_id"]))
                except (ValueError, TypeError, KeyError, AttributeError):
                    continue
                if peer != coordinator and peer not in peers:
                    peers.append(peer)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass
    return peers


def canonical_uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('canonical thread UUID required')
    return value


def resolve_route(route_file, project_root):
    if not Path(route_file).is_absolute() or not Path(project_root).is_absolute():
        raise ValueError('absolute monitor route and project root paths required')
    route = json.loads(Path(route_file).read_text())
    if (not isinstance(route, dict) or type(route.get('version')) is not int
            or route['version'] != 1 or route.get('harness') != 'codex'
            or route.get('state') not in ('active', 'held')
            or not isinstance(route.get('host_project_root'), str)
            or not Path(route['host_project_root']).is_absolute()
            or not isinstance(route.get('targets'), list)
            or 'monitor_thread_id' not in route):
        raise ValueError('invalid monitor route schema')
    coordinator = route['monitor_thread_id']
    if coordinator is not None:
        canonical_uuid(coordinator)
    identities = {}
    for target in route['targets']:
        if not isinstance(target, dict) or target.get('ownership') not in ('active', 'held'):
            raise ValueError('invalid target ownership')
        identity = canonical_uuid(target.get('thread_id'))
        if identity in identities and identities[identity] != target['ownership']:
            raise ValueError('conflicting target ownership')
        identities[identity] = target['ownership']
    if route['state'] == 'active' and coordinator in identities:
        raise ValueError('active monitor identity must be distinct from every target')
    peers = [identity for identity, ownership in identities.items() if ownership == 'active']
    if route['state'] == 'active' and (coordinator is None or not peers):
        raise ValueError('active route requires monitor identity and active targets')
    if Path(route['host_project_root']).resolve() != Path(project_root).resolve():
        return {'status': 'nonhost'}
    if route['state'] == 'held':
        return {'status': 'held'}
    return {'status': 'active', 'coordinator': coordinator, 'peers': peers}


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--monitor-route':
        try:
            route = resolve_route(sys.argv[2], sys.argv[3])
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return 1
        if route['status'] == 'active':
            print('\n'.join([route['coordinator'], *route['peers']]))
        return 0
    session_map, coordinator, shared_targets, project_root, shared_roles = sys.argv[1:]
    try:
        peers = resolve_peers(session_map, shared_targets, project_root, shared_roles, coordinator)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return 1
    print("\n".join(peers))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
