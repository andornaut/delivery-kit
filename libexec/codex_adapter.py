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


def main():
    session_map, coordinator, shared_targets, project_root, shared_roles = sys.argv[1:]
    try:
        peers = resolve_peers(session_map, shared_targets, project_root, shared_roles, coordinator)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return 1
    print("\n".join(peers))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
