"""Claude route v2, spool and channel consumer contracts with fake listings only."""
import io
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'libexec'))

import claude_adapter
import claude_channel
from codex_adapter import resolve_route

MONITOR = '00000000-0000-4000-8000-000000000001'
ARCHIE = '00000000-0000-4000-8000-000000000002'
CHIBI = '00000000-0000-4000-8000-000000000003'
SLOT = 1793556000
FAKE_AGENTS = '''import json,sys
mode=sys.argv[1]
other={'id':'x','sessionId':'%s','kind':'interactive','status':'idle','name':'other','cwd':'/','pid':1,'startedAt':0}
rows={'idle':[{'sessionId':'%s','kind':'interactive','status':'idle'}],
      'busy':[{'sessionId':'%s','kind':'interactive','status':'busy'}],
      'blocked':[{'sessionId':'%s','kind':'background','state':'blocked'}],
      'missing':[]}
if mode=='fail': sys.exit(3)
print(json.dumps([other,*rows[mode]]))
''' % (ARCHIE, MONITOR, MONITOR, MONITOR)


class Fixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'unblock'
        (self.state / 'decisions').mkdir(parents=True)
        self.clear()
        self.fake = self.root / 'fake_agents.py'
        self.fake.write_text(FAKE_AGENTS)
        self.route_path = self.root / 'route-claude.json'
        self.route = {'version': 2, 'harness': 'claude', 'host_project_root': str(self.root),
                      'state': 'active',
                      'monitor': {'session_id': MONITOR, 'name': 'monitor', 'ownership': 'active'},
                      'targets': [{'session_id': ARCHIE, 'name': 'Archie tech', 'ownership': 'active'},
                                  {'session_id': ARCHIE, 'name': 'Archie tech', 'ownership': 'active'},
                                  {'session_id': CHIBI, 'name': 'Chibi tech', 'ownership': 'held'}]}
        self.write_route(self.route)

    def clear(self):
        (self.state / 'decisions' / f'{MONITOR}.json').write_text(json.dumps({'thread_id': MONITOR, 'state': 'clear'}))

    def write_route(self, route):
        self.route_path.write_text(json.dumps(route))

    def env(self, mode):
        return {'CLAUDE_AGENTS_COMMAND': f'{sys.executable} {self.fake} {mode}'}

    def run_slot(self, mode='idle', slot=SLOT, parents=()):
        return claude_adapter.run(self.env(mode), self.state, str(self.route_path), str(self.root), slot, parents)

    def receipt(self, slot=SLOT):
        return json.loads((self.state / f'{MONITOR}-{slot}.json').read_text())

    def spooled(self):
        return sorted((self.state / claude_adapter.SPOOL).glob('*.json'))


class RouteTests(Fixture, unittest.TestCase):
    def test_active_route_deduplicates_and_excludes_held_targets(self):
        route = claude_adapter.resolve_route_v2(str(self.route_path), str(self.root))
        self.assertEqual(route['coordinator'], MONITOR)
        self.assertEqual(route['peers'], [ARCHIE])
        self.assertEqual(route['targets'], [{'session_id': ARCHIE, 'name': 'Archie tech'}])
        self.assertEqual(claude_adapter.resolve_route_v2(str(self.route_path), str(self.root / 'other')),
                         {'status': 'nonhost'})
        self.write_route(self.route | {'state': 'held', 'monitor': {'session_id': None, 'name': 'monitor', 'ownership': 'held'},
                                       'targets': []})
        self.assertEqual(claude_adapter.resolve_route_v2(str(self.route_path), str(self.root)), {'status': 'held'})

    def test_validation_errors(self):
        monitor = self.route['monitor']
        target = self.route['targets'][0]
        cases = {
            'version': self.route | {'version': True},
            'harness': self.route | {'harness': 'codex'},
            'state': self.route | {'state': 'paused'},
            'relative_root': self.route | {'host_project_root': 'relative'},
            'extra_key': self.route | {'monitor_thread_id': MONITOR},
            'noncanonical': self.route | {'targets': [target | {'session_id': 'AAAAAAAA-0000-4000-8000-000000000002'}]},
            'endpoint_key': self.route | {'targets': [target | {'thread_id': ARCHIE}]},
            'name': self.route | {'targets': [target | {'name': 'bad\nname'}]},
            'ownership': self.route | {'targets': [target | {'ownership': 'owned'}]},
            'conflict': self.route | {'targets': [target, target | {'ownership': 'held'}]},
            'monitor_target': self.route | {'targets': [target | {'session_id': MONITOR}]},
            'monitor_missing': self.route | {'monitor': monitor | {'session_id': None}},
            'monitor_held': self.route | {'monitor': monitor | {'ownership': 'held'}},
            'no_active_targets': self.route | {'targets': [target | {'ownership': 'held'}]},
        }
        for name, route in cases.items():
            with self.subTest(name=name):
                self.write_route(route)
                with self.assertRaises(ValueError):
                    claude_adapter.resolve_route_v2(str(self.route_path), str(self.root))
        self.write_route(self.route)
        with self.assertRaises(ValueError):
            claude_adapter.resolve_route_v2(str(self.route_path), '.')

    def test_harness_selection_keeps_resolvers_disjoint(self):
        v1 = {'version': 1, 'harness': 'codex', 'host_project_root': str(self.root), 'state': 'active',
              'monitor_thread_id': MONITOR, 'targets': [{'thread_id': ARCHIE, 'ownership': 'active'}]}
        self.assertEqual(claude_adapter.route_harness(v1), 'codex')
        self.assertEqual(claude_adapter.route_harness(self.route), 'claude')
        for route in (v1 | {'version': 2}, self.route | {'version': 1}, [], {'version': '2', 'harness': 'claude'}):
            with self.assertRaises(ValueError):
                claude_adapter.route_harness(route)
        with self.assertRaises(ValueError):
            resolve_route(str(self.route_path), str(self.root))
        v1_path = self.root / 'route.json'
        v1_path.write_text(json.dumps(v1))
        with self.assertRaises(ValueError):
            claude_adapter.resolve_route_v2(str(v1_path), str(self.root))
        command = [sys.executable, str(ROOT / 'libexec/claude_adapter.py')]
        self.assertEqual(subprocess.run(command + ['--route-harness', str(v1_path)], capture_output=True, text=True).stdout, 'codex\n')
        self.assertEqual(subprocess.run(command + ['--monitor-route', str(self.route_path), str(self.root)],
                                        capture_output=True, text=True).stdout, f'{MONITOR}\n{ARCHIE}\n')
        self.assertEqual(subprocess.run(command + ['--monitor-route', str(v1_path), str(self.root)]).returncode, 1)


class SpoolTests(Fixture, unittest.TestCase):
    def test_idle_and_busy_spool_once_with_slot_request_id(self):
        for slot, mode in ((SLOT, 'idle'), (SLOT + 1800, 'busy')):
            for pending in self.spooled():
                pending.replace(pending.with_suffix('.claimed'))
            state = self.run_slot(mode, slot)
            self.assertEqual(state['status'], 'sending')
            self.assertEqual(state['monitor_session_status'], mode)
            request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'hourly-unblock:{MONITOR}:{slot}'))
            self.assertEqual(self.receipt(slot)['requestId'], request_id)
            entry = json.loads((self.state / claude_adapter.SPOOL / f'{request_id}.json').read_text())
            self.assertEqual(entry['receipt'], f'unblock/{MONITOR}-{slot}.json')
            self.assertIn(f'Archie tech: {ARCHIE}', entry['text'])
            self.assertNotIn(CHIBI, entry['text'])
            self.assertIn('"queue_inventory", "status": "unavailable"', entry['text'])
            self.assertIn('"question_history", "status": "unavailable"', entry['text'])
        self.assertEqual(len(self.spooled()), 1)
        rerun = self.run_slot('idle', SLOT + 1800)
        self.assertEqual(rerun, {'status': 'deduplicated', 'previousStatus': 'sending', 'reason': None})
        self.assertEqual(len(self.spooled()), 1)

    def test_unclaimed_brief_bounds_spool_across_slots(self):
        self.assertEqual(self.run_slot()['status'], 'sending')
        for slot in range(SLOT + 1800, SLOT + 1800 * 6, 1800):
            state = self.run_slot(slot=slot)
            self.assertEqual(state['status'], 'deferred')
            self.assertIn('earlier monitor brief', state['reason'])
        self.assertEqual(len(self.spooled()), 1)
        self.assertEqual(self.receipt()['status'], 'sending')
        claude_channel.deliver_pending(io.StringIO(), self.state, MONITOR)
        self.assertEqual(self.receipt()['status'], 'accepted')
        self.assertEqual(self.run_slot(slot=SLOT + 1800 * 6)['status'], 'sending')

    def test_missing_blocked_unknown_and_unavailable_defer_without_spool(self):
        for slot, mode, reason in ((SLOT, 'missing', 'missing'), (SLOT + 1, 'blocked', 'blocked'),
                                   (SLOT + 2, 'fail', 'listing unavailable')):
            with self.subTest(mode=mode):
                state = self.run_slot(mode, slot)
                self.assertEqual(state['status'], 'deferred')
                self.assertIn(reason, state['reason'])
                self.assertEqual(self.receipt(slot)['status'], 'deferred')
                self.assertEqual(self.run_slot('idle', slot)['status'], 'deduplicated')
        self.assertEqual(claude_adapter.monitor_availability(
            [{'sessionId': MONITOR, 'status': 'waiting'}], MONITOR), (None, 'monitor session state unknown'))
        self.assertEqual(self.spooled(), [])

    def test_clearance_and_parent_scope_guard_delivery(self):
        (self.state / 'decisions' / f'{MONITOR}.json').write_text(json.dumps({'thread_id': MONITOR, 'state': 'pending'}))
        self.assertIn('clearance', self.run_slot()['reason'])
        self.clear()
        self.assertIn('parents', self.run_slot(slot=SLOT + 1, parents=[CHIBI])['reason'])
        state = self.run_slot(slot=SLOT + 2, parents=[ARCHIE])
        self.assertEqual(state['status'], 'sending')
        self.assertIn({'kind': 'worker_health', 'parent': ARCHIE, 'status': 'unavailable',
                       'reason_code': 'claude_no_native_api'}, state['diagnostics'])
        self.assertEqual(len(self.spooled()), 1)

    def test_interrupted_sending_becomes_ambiguous_without_resend(self):
        self.run_slot()
        self.spooled()[0].unlink()
        state = self.run_slot()
        self.assertEqual(state['previousStatus'], 'ambiguous')
        self.assertEqual(self.receipt()['status'], 'ambiguous')
        self.assertEqual(self.spooled(), [])

    def test_held_route_and_busy_lock(self):
        import fcntl
        with (self.state / 'unblock.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.run_slot(), {'status': 'busy'})
        self.write_route(self.route | {'state': 'held'})
        self.assertEqual(self.run_slot()['status'], 'unchanged')
        self.assertFalse((self.state / f'{MONITOR}-{SLOT}.json').exists())


class ChannelTests(Fixture, unittest.TestCase):
    def start(self):
        process = subprocess.Popen([sys.executable, str(ROOT / 'libexec/claude_channel.py'), '--state-dir', str(self.state),
                                    '--monitor', MONITOR, '--poll-seconds', '0.05'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        def stop():
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout):
                stream.close()
        self.addCleanup(stop)
        process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                        'params': {'protocolVersion': '2025-06-18', 'capabilities': {}}}).encode() + b'\n')
        process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        process.stdin.flush()
        return process

    def messages(self, process, seconds):
        lines = []
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            readable, _, _ = select.select([process.stdout], [], [], 0.05)
            if readable:
                lines.append(json.loads(process.stdout.readline()))
        return lines

    def test_consumer_emits_exactly_once_per_request_id_across_restarts(self):
        self.run_slot()
        output = io.StringIO()
        claude_channel.deliver_pending(output, self.state, MONITOR)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.run_slot(slot=SLOT + 1800)
        process = self.start()
        messages = self.messages(process, 1.0)
        initialize = messages[0]
        self.assertEqual(initialize['result']['capabilities'], {'experimental': {'claude/channel': {}}})
        self.assertEqual(initialize['result']['protocolVersion'], '2025-06-18')
        channel = [message for message in messages if message.get('method') == 'notifications/claude/channel']
        self.assertEqual([message['params']['meta']['slot'] for message in channel], [str(SLOT + 1800)])
        self.assertEqual(channel[0]['params']['meta']['kind'], 'monitor')
        for slot in (SLOT, SLOT + 1800):
            receipt = self.receipt(slot)
            self.assertEqual(receipt['status'], 'accepted')
            self.assertRegex(receipt['acceptedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(self.run_slot()['previousStatus'], 'accepted')
        process.stdin.close()
        process.wait(timeout=5)
        restarted = self.start()
        again = self.messages(restarted, 0.5)
        self.assertFalse(any(message.get('method') == 'notifications/claude/channel' for message in again))
        restarted.stdin.close()
        restarted.wait(timeout=5)

    def test_nothing_is_emitted_before_initialization_or_for_other_recipients(self):
        self.run_slot()
        output = io.StringIO()
        self.assertTrue(claude_channel.deliver_pending(output, self.state, ARCHIE))
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(self.receipt()['status'], 'sending')

    def test_write_failure_and_interrupted_claim_are_ambiguous_without_resend(self):
        class Broken:
            def write(self, text):
                raise BrokenPipeError('closed')
            def flush(self):
                pass
        self.run_slot()
        self.assertFalse(claude_channel.deliver_pending(Broken(), self.state, MONITOR))
        self.assertEqual(self.receipt()['status'], 'ambiguous')
        output = io.StringIO()
        self.assertTrue(claude_channel.deliver_pending(output, self.state, MONITOR))
        self.assertEqual(output.getvalue(), '')
        self.run_slot(slot=SLOT + 1)
        pending = self.spooled()[0]
        pending.replace(pending.with_suffix('.claimed'))
        self.assertTrue(claude_channel.deliver_pending(output, self.state, MONITOR))
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(self.receipt(SLOT + 1)['status'], 'ambiguous')


class EventTests(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.event = {'id': 'e' * 64}
        self.receipts = self.root / 'events' / 'native'
        self.receipts.mkdir(parents=True)
        self.path = self.receipts / f"{'e' * 64}-{MONITOR}.json"
        self.environment = self.env('idle') | {'MONITOR_ROUTE_FILE': str(self.route_path)}

    def spool_event(self, mode='idle'):
        return claude_adapter.spool_event(self.env(mode), self.root, self.path, MONITOR, self.event, 'PRIVATE_EVENT')

    def event_receipt(self):
        return json.loads(self.path.read_text())

    def test_monitor_recipient_selects_claude_only_for_active_monitor(self):
        import event_native
        self.assertEqual(event_native.monitor_recipient(self.environment, MONITOR), 'claude')
        self.assertIsNone(event_native.monitor_recipient(self.environment, ARCHIE))
        self.write_route(self.route | {'state': 'held'})
        self.assertIsNone(event_native.monitor_recipient(self.environment, MONITOR))

    def test_event_spooled_once_deduplicated_and_accepted_by_consumer(self):
        self.assertFalse(self.spool_event())
        request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"bus-event:{'e' * 64}:{MONITOR}"))
        receipt = self.event_receipt()
        self.assertEqual((receipt['status'], receipt['clientUserMessageId'], receipt['attempts']),
                         ('sending', request_id, [{'method': 'claude-channel', 'status': 'sending'}]))
        self.assertNotIn('PRIVATE_EVENT', self.path.read_text())
        self.assertEqual([path.name for path in self.spooled()], [f'{request_id}.json'])
        self.assertFalse(self.spool_event())
        self.assertEqual(len(self.spooled()), 1)
        output = io.StringIO()
        self.assertTrue(claude_channel.deliver_pending(output, self.state, MONITOR))
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]['params']['content'], 'PRIVATE_EVENT')
        self.assertEqual(lines[0]['params']['meta'], {'request_id': request_id, 'kind': 'event', 'event_id': 'e' * 64})
        receipt = self.event_receipt()
        self.assertEqual((receipt['status'], receipt['attempts'][-1]['status']), ('accepted', 'accepted'))
        self.assertTrue(self.spool_event())
        self.assertTrue(self.spool_event())
        self.assertEqual(self.spooled(), [])
        claude_channel.deliver_pending(output, self.state, MONITOR)
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_interrupted_event_send_becomes_ambiguous_without_resend(self):
        self.assertFalse(self.spool_event())
        self.spooled()[0].unlink()
        self.assertFalse(self.spool_event())
        receipt = self.event_receipt()
        self.assertEqual((receipt['status'], receipt['attempts'][-1]['status']), ('ambiguous', 'ambiguous'))
        self.assertFalse(self.spool_event())
        self.assertEqual(self.spooled(), [])

    def test_missing_monitor_or_clearance_defers_without_spool(self):
        self.assertFalse(self.spool_event('missing'))
        self.assertEqual(self.event_receipt()['status'], 'deferred')
        (self.state / 'decisions' / f'{MONITOR}.json').write_text(json.dumps({'thread_id': MONITOR, 'state': 'pending'}))
        self.assertFalse(self.spool_event())
        self.assertEqual(self.spooled(), [])
        self.clear()
        self.assertFalse(self.spool_event())
        self.assertEqual(len(self.spooled()), 1)

    def test_outbox_flush_routes_monitor_events_through_spool(self):
        environment = os.environ | self.environment | {'REPORT_THREAD': MONITOR, 'CLAUDE_PYTHON': sys.executable}
        event = [sys.executable, str(ROOT / 'libexec/event.py'), str(self.root)]
        subprocess.run(event + ['emit', 'attempt', 'fixture-key', 'fixture message'], env=environment, check=True)
        for _ in range(2):
            subprocess.run(event + ['flush'], env=environment, check=True, timeout=20)
        self.assertEqual(len(self.spooled()), 1)
        outbox = next((self.root / 'events').glob('*.json'))
        self.assertFalse(json.loads(outbox.read_text())['sent'])
        output = io.StringIO()
        claude_channel.deliver_pending(output, self.state, MONITOR)
        self.assertIn('fixture message', output.getvalue())
        subprocess.run(event + ['flush'], env=environment, check=True, timeout=20)
        self.assertTrue(json.loads(outbox.read_text())['sent'])
        self.assertEqual(len(output.getvalue().splitlines()), 1)


class BusWiringTests(Fixture, unittest.TestCase):
    def shell(self, route, slot, mechanism=ROOT / 'libexec'):
        conf = self.root / 'project.conf'
        conf.write_text(f'''REPO={self.root}
MAIN=main
REMOTE=
GH_SLUG=
DEPARTURES=00
BUS_TIMEZONE=America/Toronto
DEPLOY_SKIP_RE=
NODE_IMAGE=unused
CONTAINER_PREFIX=fixture
CPUS=4
MAX_WORKERS=4
LOAD_LIMIT=24
GATE_INSTALL=
GATE_STEPS=()
DEPLOY_MODE=none
CODEX_CONTROL_SOCKET=/fixture/control.sock
CLAUDE_PYTHON={sys.executable}
CLAUDE_AGENTS_COMMAND="{sys.executable} {self.fake} idle"
MONITOR_ROUTE_FILE={route}
''')
        bus = self.root / 'bus'
        bus.mkdir(exist_ok=True)
        if not (bus / 'unblock').exists():
            (bus / 'unblock').symlink_to(self.state)
        command = f'S="{mechanism}"; . "$S/bus-common.sh"; bus_monitor_due_ticks {slot - 1} {slot + 15}'
        return subprocess.run(['bash', '-c', command], capture_output=True, text=True, timeout=10,
                              env=os.environ | {'BUS_CONF': str(conf), 'BUS_STATE_DIR': str(bus)})

    def test_claude_route_spools_from_existing_observer(self):
        slot = int(subprocess.check_output(['date', '-d', '2026-11-02T14:20:00-05:00', '+%s'], text=True))
        first = self.shell(self.route_path, slot)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn('"status": "sending"', first.stdout)
        self.assertIn('"monitor_session_status": "idle"', first.stdout)
        duplicate = self.shell(self.route_path, slot)
        self.assertIn('deduplicated', duplicate.stdout)
        self.assertEqual(len(self.spooled()), 1)
        self.write_route(self.route | {'targets': []})
        invalid = self.shell(self.route_path, slot + 1800)
        self.assertIn('MONITOR_ROUTE_FILE is unavailable or invalid', invalid.stderr)
        self.assertEqual(len(self.spooled()), 1)


    def test_v1_route_output_is_identical_with_claude_adapter_installed(self):
        slot = int(subprocess.check_output(['date', '-d', '2026-11-02T14:20:00-05:00', '+%s'], text=True))
        v1 = self.root / 'route.json'
        v1.write_text(json.dumps({'version': 1, 'harness': 'codex', 'host_project_root': str(self.root),
                                  'state': 'active', 'monitor_thread_id': MONITOR,
                                  'targets': [{'thread_id': ARCHIE, 'ownership': 'active'}]}))
        results = []
        for installed in (False, True):
            mechanism = self.root / f'mechanism-{installed}'
            mechanism.mkdir()
            names = ['bus-common.sh', 'codex_adapter.py'] + (['claude_adapter.py'] if installed else [])
            for name in names:
                (mechanism / name).symlink_to(ROOT / 'libexec' / name)
            calls = self.root / f'calls-{installed}'
            (mechanism / 'unblock.py').write_text(
                'import json,sys\nopen(%r,"a").write(json.dumps(sys.argv[1:])+"\\n")\n'
                'print(json.dumps({"status":"accepted"}))\n' % str(calls))
            result = self.shell(v1, slot, mechanism)
            results.append((result.returncode, result.stdout, result.stderr, calls.read_text()))
        self.assertEqual(results[0], results[1])
        self.assertIn(f'"--coordinator", "{MONITOR}", "--peer", "{ARCHIE}"', results[0][3])
        self.assertEqual(self.spooled(), [])

if __name__ == '__main__':
    unittest.main()
