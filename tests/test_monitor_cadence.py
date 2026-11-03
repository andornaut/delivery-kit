"""Wall-clock monitoring is routed independently from release ticks and active gates."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TECH = '00000000-0000-0000-0000-000000000001'
MONITOR = '00000000-0000-0000-0000-000000000002'
TARGET = '00000000-0000-0000-0000-000000000003'
HELD = '00000000-0000-0000-0000-000000000004'


class CadenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.mechanism = self.root / 'mechanism'
        self.mechanism.mkdir()
        for name in ('bus-common.sh', 'codex_adapter.py'):
            (self.mechanism / name).symlink_to(ROOT / 'libexec' / name)
        # Stub only the native boundary. No socket, thread or queue operations occur.
        (self.mechanism / 'unblock.py').write_text('''import json,os,pathlib,sys
with open(os.environ['CALLS'],'a') as stream: stream.write(json.dumps(sys.argv[1:])+'\\n')
print(json.dumps({'status':'accepted'}))
''')
        self.calls = self.root / 'calls'
        self.events = self.root / 'events'
        self.route_path = self.root / 'route.json'
        self.route = {'version': 1, 'harness': 'codex', 'host_project_root': str(self.root),
                      'state': 'active', 'monitor_thread_id': MONITOR,
                      'targets': [{'thread_id': TARGET, 'ownership': 'active'},
                                  {'thread_id': TARGET, 'ownership': 'active'},
                                  {'thread_id': HELD, 'ownership': 'held'}]}
        self.route_path.write_text(json.dumps(self.route))
        self.conf = self.root / 'project.conf'
        self.original = f'''REPO={self.root}
MAIN=main
REMOTE=
GH_SLUG=
DEPARTURES='00 10'
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
REPORT_THREAD={TECH}
REPORT_SCHEDULED_TICKS=1
CODEX_CONTROL_SOCKET=/fixture/control.sock
MONITOR_ROUTE_FILE={self.route_path}
'''
        self.conf.write_text(self.original)
        self.env = os.environ | {'BUS_CONF': str(self.conf), 'BUS_STATE_DIR': str(self.state),
                                 'CALLS': str(self.calls), 'EVENTS': str(self.events)}

    def shell(self, body):
        script = f'S="{self.mechanism}"; . "$S/bus-common.sh"; bus_event() {{ printf "%s\\n" "$*" >> "$EVENTS"; }}; ' + body
        return subprocess.run(['bash', '-c', script], env=self.env, capture_output=True, text=True, timeout=3)

    def invocations(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def epoch(self, local):
        return int(subprocess.check_output(['date', '-d', local, '+%s'], text=True,
                                          env=os.environ | {'TZ': 'America/Toronto'}))

    def test_current_wall_minutes_only_startup_missed_slots_and_release_reporting(self):
        twenty = self.epoch('2026-11-02 14:20:00')
        fifty = self.epoch('2026-11-02 14:50:00')
        release = self.epoch('2026-11-02 14:00:00')
        # A gate marker never suppresses the independent observer's monitoring.
        (self.state / 'active-departure').write_text('active fixture')
        body = (f'bus_monitor_due_ticks {twenty+30} {twenty+30}; '
                f'bus_monitor_due_ticks {twenty-1} {twenty+60}; '
                f'bus_monitor_due_ticks {twenty-1} {twenty+59}; '
                f'bus_monitor_due_ticks {twenty+59} {fifty+30}; '
                f'bus_monitor_due_ticks {fifty+30} {fifty+90}; '
                f'bus_unblock_tick {release}; '
                f'bus_report_due_ticks {release-1} {release+600}; '
                'printf "%s" "$DEPARTURES"')
        result = self.shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.invocations()
        self.assertEqual([row[row.index('--slot')+1] for row in calls], [str(twenty), str(fifty)])
        for row in calls:
            self.assertEqual(row[row.index('--coordinator')+1], MONITOR)
            self.assertEqual(row.count(TARGET), 1)
            self.assertNotIn(TECH, row)
            self.assertNotIn(HELD, row)
        reports = self.events.read_text()
        self.assertIn(f'scheduled-status {release}', reports)
        self.assertIn(f'scheduled-status {release+600}', reports)
        self.assertIn('still checking', reports)
        self.assertTrue(result.stdout.endswith('00 10'))

    def test_route_guards_and_monitor_disabled_reports_do_not_depend_on_reporting_flag(self):
        due = self.epoch('2026-11-02 14:20:00')
        self.conf.write_text(self.original + 'REPORT_SCHEDULED_TICKS=0\n')
        self.assertEqual(self.shell(f'bus_monitor_due_ticks {due-1} {due}').returncode, 0)
        self.assertEqual(len(self.invocations()), 1)
        for update in ({'host_project_root': str(self.root / 'nonhost')},
                       {'state': 'held', 'monitor_thread_id': None},
                       {'monitor_thread_id': 'invalid'}, {'monitor_thread_id': None},
                       {'harness': 'other'}, {'targets': []},
                       {'targets': [{'thread_id': MONITOR, 'ownership': 'active'}, {'thread_id': TARGET, 'ownership': 'active'}]}):
            with self.subTest(update=update):
                self.route_path.write_text(json.dumps(self.route | update))
                result = self.shell(f'bus_monitor_due_ticks {due-1} {due}; bus_unblock_tick {due}')
                self.assertEqual(result.returncode, 0)
                self.assertEqual(len(self.invocations()), 1)
        self.route_path.write_text(json.dumps(self.route | {'targets': [{'thread_id': 'invalid', 'ownership': 'active'}]}))
        self.shell(f'bus_monitor_due_ticks {due-1} {due}')
        self.assertEqual(len(self.invocations()), 1)

    def test_monitor_report_sink_and_route_preserve_distinct_tech_role(self):
        session_map = self.root / 'sessions.json'
        roles = {'codex': {'tech': TECH, 'art': TARGET, 'gameplay': HELD}}
        session_map.write_text(json.dumps(roles))
        original_map = session_map.read_bytes()
        self.conf.write_text(self.original + f'REPORT_THREAD={MONITOR}\nSESSION_MAP_FILE={session_map}\n')
        (self.mechanism / 'event.py').symlink_to(ROOT / 'libexec' / 'event.py')
        fake_bin = self.root / 'bin'
        fake_bin.mkdir()
        report_calls = self.root / 'report-calls'
        fake_codex = fake_bin / 'codex'
        fake_codex.write_text('''#!/usr/bin/python3
import json,os,sys
with open(os.environ['REPORT_CALLS'], 'a') as stream:
    stream.write(json.dumps(sys.argv[1:])+'\\n')
''')
        fake_codex.chmod(0o755)
        env = self.env | {'PATH': str(fake_bin) + os.pathsep + self.env['PATH'],
                          'REPORT_CALLS': str(report_calls)}
        due = self.epoch('2026-11-02 14:20:00')
        for host in (True, False):
            with self.subTest(host=host):
                self.route_path.write_text(json.dumps(self.route | {
                    'host_project_root': str(self.root if host else self.root / 'other-project')}))
                checked = subprocess.run(
                    ['bash', str(ROOT / 'bin' / 'delivery-kit'), '--config', str(self.conf),
                     '--state-dir', str(self.state), 'check-config'],
                    env=env, capture_output=True, text=True, timeout=3)
                self.assertEqual(checked.returncode, 0, checked.stderr)
                self.assertIn('configuration accepted', checked.stdout)
                self.assertEqual(len(self.invocations()), int(not host))
                script = (f'S="{self.mechanism}"; . "$S/bus-common.sh"; '
                          'bus_dispatch() { python3 "$S/event.py" "$BUS_DIR" flush; }; '
                          f'bus_monitor_due_ticks {due-1} {due}; '
                          f'bus_report_scheduled_tick {due + int(not host)} "fixture release report"')
                result = subprocess.run(['bash', '-c', script], env=env,
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.invocations()), 1)
                native = self.invocations()[0]
                self.assertEqual(native[native.index('--coordinator')+1], MONITOR)
                self.assertNotIn(TECH, native)
                reports = [json.loads(line) for line in report_calls.read_text().splitlines()]
                self.assertEqual(len(reports), 1 if host else 2)
                self.assertTrue(all(row[:3] == ['queue', '--thread', MONITOR] for row in reports))
                self.assertTrue(all('fixture release report' in row[row.index('--message')+1]
                                    for row in reports))
                self.assertEqual(session_map.read_bytes(), original_map)
                self.assertEqual(json.loads(session_map.read_text())['codex']['tech'], TECH)
                self.assertNotEqual(TECH, MONITOR)

    def test_monitor_minutes_validate_without_config_load_activity_or_release_coupling(self):
        due = self.epoch('2026-11-02 14:20:00')
        self.assertEqual(self.shell(':').returncode, 0)
        self.assertEqual(self.invocations(), [])
        for value in ('', '60', '20+1'):
            self.conf.write_text(self.original + f"MONITOR_MINUTES='{value}'\n")
            result = self.shell(f'bus_monitor_due_ticks {due-1} {due}')
            self.assertEqual(result.returncode, 0)
            self.assertIn('MONITOR_MINUTES', result.stderr)
            self.assertEqual(self.invocations(), [])
        self.conf.write_text(self.original + "MONITOR_MINUTES='10'\n")
        ten = due - 600
        self.shell(f'bus_monitor_due_ticks {ten-1} {ten}')
        self.assertEqual(len(self.invocations()), 1)

    def test_dst_fold_slots_have_distinct_epoch_identity_at_same_wall_minute(self):
        first = self.epoch('2026-11-01 01:20:00 EDT')
        second = self.epoch('2026-11-01 01:20:00 EST')
        self.assertEqual(second - first, 3600)
        self.shell(f'bus_monitor_due_ticks {first-1} {first}; bus_monitor_due_ticks {second-1} {second}')
        self.assertEqual([row[row.index('--slot')+1] for row in self.invocations()], [str(first), str(second)])
