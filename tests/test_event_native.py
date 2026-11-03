"""Offline monitor delivery, durable attempts and inherited configuration contracts."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec'))
import event_native as subject
from test_unblock import Fixture, TECH, ART

ROOT = Path(__file__).resolve().parents[1]


class EventNativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'unblock'
        (self.state / 'decisions').mkdir(parents=True)
        self.marker = self.state / 'decisions' / f'{TECH}.json'
        subject.persist(self.marker, {'thread_id': TECH, 'state': 'clear'})
        self.path = self.root / 'receipt.json'
        self.event = {'id': 'a' * 64}
        self.route = self.root / 'route.json'
        self.route.write_text(json.dumps({'version': 1, 'harness': 'codex', 'state': 'active',
            'host_project_root': '/different/dispatch/project', 'monitor_thread_id': TECH,
            'targets': [{'thread_id': ART, 'ownership': 'active'}]}))

    def deliver(self, client):
        return subject.deliver(client, self.state, self.path, TECH, self.event, 'PRIVATE_EVENT')

    def test_active_delivery_persists_attempt_before_mutation_and_deduplicates(self):
        client = Fixture()
        original = client.call
        def call(method, params):
            if method.startswith('turn/'):
                receipt = json.loads(self.path.read_text())
                self.assertEqual(receipt['status'], 'sending')
                self.assertEqual(receipt['attempts'][-1]['status'], 'sending')
                self.assertEqual(receipt['clientUserMessageId'], params['clientUserMessageId'])
                self.assertEqual(params['expectedTurnId'], 'turn-one')
            return original(method, params)
        client.call = call
        self.assertTrue(self.deliver(client))
        self.assertTrue(self.deliver(client))
        self.assertEqual(len(client.mutations()), 1)
        self.assertNotIn('PRIVATE_EVENT', self.path.read_text())
        self.assertEqual(json.loads(self.path.read_text())['recipient'], TECH)

    def test_completed_idle_starts_and_interrupted_idle_does_not(self):
        client = Fixture(status={'type': 'idle'}, turn={'id': 'old', 'status': 'completed'},
                         outcomes=[{'turn': {'id': 'new'}}])
        self.assertTrue(self.deliver(client))
        self.assertEqual(client.mutations()[0][0], 'turn/start')
        self.assertNotIn('expectedTurnId', client.mutations()[0][1])
        self.path.unlink()
        client = Fixture(status={'type': 'idle'}, turn={'id': 'old', 'status': 'interrupted'})
        self.assertFalse(self.deliver(client))
        self.assertEqual(client.mutations(), [])

    def test_pending_local_native_questions_and_guard_race_never_send(self):
        for mode in ('local', 'flags', 'question', 'race'):
            with self.subTest(mode=mode):
                subject.persist(self.marker, {'thread_id': TECH, 'state': 'clear'})
                client = Fixture()
                original = client.call
                def call(method, params):
                    if mode == 'question' and method == 'thread/items/list':
                        return {'data': [{'turnId': 'turn-one', 'item': {
                            'id': 'q', 'type': 'agentMessage', 'questions': [{}]}}]}
                    if mode == 'race' and method == 'thread/turns/list':
                        subject.persist(self.marker, {'thread_id': TECH, 'state': 'pending'})
                    return original(method, params)
                client.call = call
                if mode == 'local':
                    subject.persist(self.marker, {'thread_id': TECH, 'state': 'pending'})
                if mode == 'flags':
                    client.status['activeFlags'] = ['waitingOnUserInput']
                self.assertFalse(self.deliver(client))
                self.assertEqual(client.mutations(), [])

    def test_stale_rejection_refreshes_turn_once_with_same_request_identity(self):
        stale = subject.RpcError({'code': -32600, 'message': 'expectedTurnId mismatch'})
        client = Fixture(outcomes=[stale, {'turnId': 'fresh'}])
        original = client.call
        def call(method, params):
            if method == 'thread/read' and client.mutations():
                client.turn = {'id': 'fresh', 'status': 'inProgress'}
            return original(method, params)
        client.call = call
        self.assertTrue(self.deliver(client))
        requests = client.mutations()
        self.assertEqual([params['expectedTurnId'] for _, params in requests], ['turn-one', 'fresh'])
        self.assertEqual(requests[0][1]['clientUserMessageId'], requests[1][1]['clientUserMessageId'])
        self.path.unlink()
        client = Fixture(outcomes=[stale, stale])
        self.assertFalse(self.deliver(client))
        self.assertFalse(self.deliver(client))
        self.assertEqual(len(client.mutations()), 2)

    def test_ambiguous_and_rejected_outcomes_never_retry_even_after_restart(self):
        for outcome in (TimeoutError('PRIVATE_BODY'), {}, {'turnId': 'wrong'},
                        subject.RpcError({'code': 1, 'message': 'PRIVATE_BODY'})):
            with self.subTest(outcome=type(outcome)):
                if self.path.exists():
                    self.path.unlink()
                client = Fixture(outcomes=[outcome])
                self.assertFalse(self.deliver(client))
                self.assertFalse(self.deliver(client))
                self.assertEqual(len(client.mutations()), 1)
                self.assertNotIn('PRIVATE_BODY', self.path.read_text())
        receipt = json.loads(self.path.read_text())
        receipt['status'] = 'sending'
        subject.persist(self.path, receipt)
        client = Fixture()
        self.assertFalse(self.deliver(client))
        self.assertEqual(client.calls, [])
        self.assertEqual(json.loads(self.path.read_text())['status'], 'ambiguous')

    def test_monitor_route_validation_does_not_require_reporter_to_be_dispatch_host(self):
        env = {'MONITOR_ROUTE_FILE': str(self.route), 'REPO': '/nonhost/game'}
        self.assertTrue(subject.monitor_recipient(env, TECH))
        self.assertFalse(subject.monitor_recipient(env, ART))
        self.assertFalse(subject.monitor_recipient({}, TECH))
        for change in ({'state': 'held'}, {'version': 2}, {'targets': []}, {'harness': 'other'}):
            route = json.loads(self.route.read_text())
            with patch.object(subject, 'resolve_route', wraps=subject.resolve_route):
                self.route.write_text(json.dumps(route | change))
                self.assertFalse(subject.monitor_recipient(env, TECH))
            self.route.write_text(json.dumps(route))

    def test_subprocess_config_exports_selected_interpreter_and_unset_semantics(self):
        bus = self.root / 'bus'
        bus.mkdir()
        wrapper = self.root / 'native-python'
        log = self.root / 'environment.json'
        wrapper.write_text('#!/usr/bin/python3\nimport json,os,pathlib,sys\n'
            'pathlib.Path(os.environ["FIXTURE_LOG"]).write_text(json.dumps({"argv":sys.argv[1:],'
            '"env":{k:os.environ.get(k) for k in ("MONITOR_ROUTE_FILE","CODEX_CONTROL_SOCKET","CODEX_PYTHON")}}))\n')
        wrapper.chmod(0o755)
        conf = self.root / 'config'
        base = f'''REPO={self.root}
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
REPORT_THREAD={TECH}
'''
        env = {key: value for key, value in os.environ.items() if key not in (
            'MONITOR_ROUTE_FILE', 'CODEX_CONTROL_SOCKET', 'CODEX_PYTHON')}
        env.update(BUS_CONF=str(conf), BUS_STATE_DIR=str(bus), FIXTURE_LOG=str(log))
        conf.write_text(base + f'MONITOR_ROUTE_FILE={self.route}\nCODEX_CONTROL_SOCKET=/fixture/control.sock\nCODEX_PYTHON={wrapper}\n')
        command = 'S="$1/libexec"; . "$S/bus-common.sh"; bus_dispatch() { :; }; bus_event push fixture payload; /usr/bin/python3 "$S/event.py" "$BUS_DIR" flush'
        result = subprocess.run(['/bin/bash', '-c', command, 'fixture', str(ROOT)], env=env,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        captured = json.loads(log.read_text())
        self.assertTrue(captured['argv'][0].endswith('/event_native.py'))
        self.assertEqual(captured['env'], {'MONITOR_ROUTE_FILE': str(self.route),
            'CODEX_CONTROL_SOCKET': '/fixture/control.sock', 'CODEX_PYTHON': str(wrapper)})
        for extra, route_value, socket_value in (('', None, None),
                ("MONITOR_ROUTE_FILE=''\nCODEX_CONTROL_SOCKET=''\n", '', '')):
            conf.write_text(base + extra)
            command = 'S="$1/libexec"; . "$S/bus-common.sh"; /usr/bin/python3 -c \'import json,os; print(json.dumps({k:os.environ.get(k) for k in ("MONITOR_ROUTE_FILE","CODEX_CONTROL_SOCKET","CODEX_PYTHON")}))\''
            result = subprocess.run(['/bin/bash', '-c', command, 'fixture', str(ROOT)], env=env,
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'MONITOR_ROUTE_FILE': route_value,
                'CODEX_CONTROL_SOCKET': socket_value, 'CODEX_PYTHON': '/usr/bin/python3'})

    def test_nonmonitor_retains_codex_queue_contract(self):
        stub = self.root / 'codex'
        log = self.root / 'queue.json'
        stub.write_text('#!/usr/bin/python3\nimport json,os,pathlib,sys\npathlib.Path(os.environ["FIXTURE_LOG"]).write_text(json.dumps(sys.argv[1:]))\n')
        stub.chmod(0o755)
        env = os.environ | {'REPORT_THREAD': ART, 'MONITOR_ROUTE_FILE': str(self.route),
            'PATH': str(self.root) + ':' + os.environ['PATH'], 'FIXTURE_LOG': str(log)}
        for args in (('emit', 'push', 'key', 'message'), ('flush',)):
            subprocess.run(['/usr/bin/python3', str(ROOT / 'libexec/event.py'), str(self.root), *args],
                           env=env, check=True, timeout=5)
        self.assertEqual(json.loads(log.read_text())[:4], ['queue', '--thread', ART, '--message'])
        self.assertTrue(json.loads(next((self.root / 'events').glob('*.json')).read_text())['sent'])
