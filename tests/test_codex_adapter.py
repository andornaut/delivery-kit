"""Caller-defined shared roles retain host, ownership and identity guards."""
import json
from pathlib import Path
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "libexec"))

from codex_adapter import resolve_peers, resolve_route


class AdapterTests(unittest.TestCase):
    def test_shared_role_configuration_and_host_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mapping = root / 'sessions.json'
            shared = root / 'shared.json'
            tech, art, gameplay, library, inactive = [
                f'00000000-0000-0000-0000-{number:012d}' for number in range(1, 6)]
            mapping.write_text(json.dumps({'codex': {'tech': tech, 'art': art, 'gameplay': gameplay}}))
            config = {'version': 1, 'harness': 'codex', 'host_coordinator_thread_id': tech,
                      'host_project_root': str(root), 'targets': [
                          {'role': 'custom-library', 'ownership': 'active', 'thread_id': library},
                          {'role': 'custom-library', 'ownership': 'active', 'thread_id': library},
                          {'role': 'custom-library', 'ownership': 'held', 'thread_id': inactive},
                          {'role': 'custom-library', 'ownership': 'active', 'thread_id': 'invalid'},
                          {'role': 'custom-library', 'ownership': 'active', 'thread_id': tech},
                          {'role': 'unselected', 'ownership': 'active', 'thread_id': inactive}]}
            shared.write_text(json.dumps(config))
            def resolve(roles='custom-library', targets=str(shared)):
                return resolve_peers(str(mapping), targets, str(root), roles, tech)
            self.assertEqual(resolve(), [art, gameplay, library])
            self.assertEqual(resolve(roles=''), [art, gameplay])
            self.assertEqual(resolve(targets=''), [art, gameplay])
            for field, value in (('harness', 'other'), ('host_project_root', str(root / 'other')),
                                 ('host_coordinator_thread_id', art), ('version', True)):
                with self.subTest(field=field):
                    shared.write_text(json.dumps(config | {field: value}))
                    self.assertEqual(resolve(), [art, gameplay])
            for roles in ({'tech': art, 'art': art, 'gameplay': gameplay},
                          {'tech': tech, 'art': art, 'gameplay': art}):
                mapping.write_text(json.dumps({'codex': roles}))
                with self.assertRaises(ValueError):
                    resolve()

    def test_monitor_route_rejects_relative_project_root_even_while_held(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            route = root / 'route.json'
            route.write_text(json.dumps({'version': 1, 'harness': 'codex',
                                         'host_project_root': str(root), 'state': 'held',
                                         'monitor_thread_id': None, 'targets': []}))
            with self.assertRaises(ValueError):
                resolve_route(str(route), '.')
            self.assertEqual(resolve_route(str(route), str(root)), {'status': 'held'})
