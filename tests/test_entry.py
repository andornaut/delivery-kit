"""Explicit mechanism roots and project-owned state, without live services."""
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.state = self.root / 'state separate from repository'
        self.state.mkdir()
        self.conf = self.root / 'project.conf'
        self.conf.write_text('''REPO=/unread/project
MAIN=main
REMOTE=
GH_SLUG=
DEPARTURES=00
DEPLOY_SKIP_RE=
NODE_IMAGE=unused
CONTAINER_PREFIX=fixture
CPUS=4
MAX_WORKERS=4
LOAD_LIMIT=24
GATE_INSTALL=
GATE_STEPS=()
DEPLOY_MODE=none
''')

    def call(self, *args):
        return subprocess.run(['bash', str(ROOT / 'bin/delivery-kit'),
                               '--config', str(self.conf), '--state-dir', str(self.state), *args],
                              capture_output=True, text=True, timeout=3)

    def test_help_requires_no_configuration_state_or_runtime_writes(self):
        before = sorted(self.root.rglob('*'))
        for command in ('--help', 'help'):
            result = subprocess.run(['bash', str(ROOT / 'bin/delivery-kit'), command],
                                    cwd=self.root, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('request-once', result.stdout)
            self.assertEqual(result.stderr, '')
        self.assertEqual(sorted(self.root.rglob('*')), before)
        result = subprocess.run(['bash', str(ROOT / 'bin/delivery-kit'), 'invalid'],
                                cwd=self.root, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertIn('usage:', result.stderr)

        result = self.call('invalid')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertIn('usage:', result.stderr)

    def test_config_validation_has_no_runtime_side_effects(self):
        result = self.call('check-config')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_manual_and_unpinned_snapshot_commands_are_rejected(self):
        self.assertEqual(self.call('depart').returncode, 2)
        self.assertEqual(self.call('--revision', 'a' * 40, 'check-config').returncode, 2)

    def test_exported_snapshot_enforces_its_exact_revision_and_refuses_overwrite(self):
        source = self.root / 'source'
        source.mkdir()
        for name in ['bin', 'libexec', 'scripts']:
            shutil.copytree(ROOT / name, source / name)
        def git(*args):
            return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
        git('init', '-q', '-b', 'main')
        git('add', '--', 'bin', 'libexec', 'scripts')
        env = os.environ | {'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                            'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
        subprocess.run(['git', '-C', str(source), '-c', 'core.hooksPath=/dev/null',
                        'commit', '-q', '--no-verify', '-m', 'Fixture'], env=env, check=True)
        revision = git('rev-parse', 'HEAD')
        snapshot = self.root / 'snapshot'
        command = ['bash', str(source / 'scripts/export.sh'), revision, str(snapshot)]
        subprocess.run(command, check=True, capture_output=True)
        self.assertEqual((snapshot / 'SOURCE_COMMIT').read_text().strip(), revision)
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        command = ['bash', str(snapshot / 'bin/delivery-kit'), '--config', str(self.conf),
                   '--state-dir', str(self.state), '--revision', revision, 'check-config']
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        command[-2] = '0' * 40
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)

    def test_deployment_mode_requires_explicit_supported_configuration(self):
        original = self.conf.read_text()
        for mode in ('', 'DEPLOY_MODE=workers-builds', 'DEPLOY_MODE='):
            with self.subTest(mode=mode):
                self.conf.write_text(original.replace('DEPLOY_MODE=none', mode))
                self.assertEqual(self.call('check-config').returncode, 2)
        for mode in ('none', 'wrangler'):
            self.conf.write_text(original.replace('DEPLOY_MODE=none', 'DEPLOY_MODE=' + mode))
            self.assertEqual(self.call('check-config').returncode, 0)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_resource_caps_require_positive_bounded_integers_without_runtime_activity(self):
        original = self.conf.read_text()
        for key in ('CPUS', 'MAX_WORKERS'):
            for value in ('0', '-1', '5', '1.5', 'invalid', '2+2', '', '04'):
                with self.subTest(key=key, value=value):
                    self.conf.write_text(original.replace(key + '=4', key + "='" + value + "'"))
                    result = self.call('check-config')
                    self.assertEqual(result.returncode, 2, result.stderr)
            for value in ('1', '4'):
                with self.subTest(key=key, value=value):
                    self.conf.write_text(original.replace(key + '=4', key + '=' + value))
                    result = self.call('check-config')
                    self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_missing_adapter_configuration_defers_without_native_helper_call(self):
        original = self.conf.read_text()
        mechanism = self.root / 'mechanism'
        mechanism.mkdir()
        marker = self.root / 'unexpected-native-call'
        (mechanism / 'unblock.py').write_text(f'from pathlib import Path; Path({str(marker)!r}).touch()\n')
        command = (f'unset CODEX_CONTROL_SOCKET CODEX_SHARED_ROLES; S="{ROOT / "libexec"}"; '
                   f'. "$S/bus-common.sh"; S="{mechanism}"; bus_unblock_tick 1793556000')
        for configuration, missing in (("CODEX_SHARED_ROLES=''\n", 'CODEX_CONTROL_SOCKET'),
                                       ('CODEX_CONTROL_SOCKET=/fixture/control.sock\n', 'CODEX_SHARED_ROLES')):
            with self.subTest(missing=missing):
                self.conf.write_text(original + 'REPORT_THREAD=fixture\n' + configuration)
                result = subprocess.run(['bash', '-c', command],
                                        env=os.environ | {'BUS_CONF': str(self.conf), 'BUS_STATE_DIR': str(self.state)},
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(missing, result.stderr)
                self.assertFalse(marker.exists())
                self.assertEqual(list(self.state.iterdir()), [])

    def test_host_matching_library_targets_are_deduplicated(self):
        coordinator = '00000000-0000-0000-0000-000000000001'
        art = '00000000-0000-0000-0000-000000000002'
        gameplay = '00000000-0000-0000-0000-000000000003'
        library = '00000000-0000-0000-0000-000000000004'
        delivery = '00000000-0000-0000-0000-000000000005'
        held = '00000000-0000-0000-0000-000000000006'
        mapping = self.root / 'map.json'
        mapping.write_text(json.dumps({'codex': {'tech': coordinator, 'art': art, 'gameplay': gameplay}}))
        targets = self.root / 'targets.json'
        targets.write_text(json.dumps({'version': 1, 'harness': 'codex',
                                      'host_coordinator_thread_id': coordinator,
                                      'host_project_root': '/unread/project',
                                      'targets': [{'role': 'art-kit', 'ownership': 'active', 'thread_id': library},
                                                  {'role': 'game-kit', 'ownership': 'active', 'thread_id': library},
                                                  {'role': 'delivery-kit', 'ownership': 'active', 'thread_id': delivery},
                                                  {'role': 'delivery-kit', 'ownership': 'held', 'thread_id': held}]}))
        mechanism = self.root / 'mechanism'
        mechanism.mkdir()
        shutil.copyfile(ROOT / 'libexec/codex_adapter.py', mechanism / 'codex_adapter.py')
        (mechanism / 'unblock.py').write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n')
        with self.conf.open('a') as stream:
            stream.write('CODEX_CONTROL_SOCKET=/fixture/control.sock\nCODEX_SHARED_ROLES="art-kit delivery-kit game-kit"\n')
            stream.write(f'REPORT_THREAD={coordinator}\nSESSION_MAP_FILE="{mapping}"\nSHARED_TARGETS_FILE="{targets}"\n')
        command = f'S="{ROOT / "libexec"}"; . "$S/bus-common.sh"; S="{mechanism}"; bus_unblock_tick 1793556000'
        env = os.environ | {'BUS_CONF': str(self.conf), 'BUS_STATE_DIR': str(self.state)}
        result = subprocess.run(['bash', '-c', command], env=env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count(library), 1)
        self.assertEqual(result.stdout.count(delivery), 1)
        self.assertNotIn(held, result.stdout)
        self.assertIn(art, result.stdout)
        self.assertIn(gameplay, result.stdout)
        payload = json.loads(targets.read_text())
        payload['host_project_root'] = '/different/project'
        targets.write_text(json.dumps(payload))
        result = subprocess.run(['bash', '-c', command], env=env, capture_output=True, text=True, timeout=3)
        self.assertNotIn(library, result.stdout)
        self.assertNotIn(delivery, result.stdout)
        self.assertIn(gameplay, result.stdout)
