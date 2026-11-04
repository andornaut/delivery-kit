"""Runner identity and the read-only status report, using lock files only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / 'libexec' / 'status.py'


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        (self.state / 'ci').mkdir(parents=True)
        (self.state / 'events').mkdir()
        self.tool = self.root / 'tool'
        self.tool.mkdir()
        (self.tool / 'VERSION').write_text('0.9.0\n')
        (self.tool / 'SOURCE_COMMIT').write_text('c' * 40 + '\n')
        (self.state / 'runner.lock').touch()
        (self.state / 'loop.lock').touch()
        (self.state / 'active-departure').write_text('')

    def report(self, ci='0'):
        result = subprocess.run([sys.executable, str(STATUS), 'report', str(self.state), ci],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def record(self, pid=4242):
        subprocess.run([sys.executable, str(STATUS), 'record', str(self.state), str(self.tool),
                        '/abs/bus.conf', str(pid)], check=True)
        return json.loads((self.state / 'runner.identity.json').read_text())

    def hold(self, name, opener='5<>'):
        """Hold a lock the way a runner does, from another process."""
        holder = subprocess.Popen(['bash', '-c', f'exec {opener}"$1"; flock -n 5 || exit 9; echo held; read -r _',
                                   'holder', str(self.state / name)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.assertEqual(holder.stdout.readline().strip(), 'held')
        def release():
            holder.stdin.close()
            holder.wait(timeout=5)
            holder.stdout.close()
        self.addCleanup(release)
        return holder

    def test_stale_record_with_free_lock_is_not_running(self):
        self.record()
        report = self.report()
        self.assertEqual((report['status'], report['runner_lock_held'], report['identity_status']),
                         ('not running', False, 'stale'))
        self.assertTrue(report['idle'] and report['drained'])

    def test_held_lock_with_matching_token_is_running_with_record(self):
        self.hold('runner.lock')
        identity = self.record()
        self.assertEqual((identity['pid'], identity['version'], identity['source_commit'], identity['config']),
                         (4242, '0.9.0', 'c' * 40, '/abs/bus.conf'))
        self.assertRegex(identity['started_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        report = self.report()
        self.assertEqual((report['status'], report['identity_status']), ('running', 'current'))
        self.assertEqual(report['identity'], identity)
        self.assertEqual((self.state / 'runner.lock').read_text().strip(), identity['token'])

    def test_older_runner_lock_holder_is_running_but_unattested(self):
        self.record()
        self.hold('runner.lock', opener='5>')
        report = self.report()
        self.assertEqual((report['status'], report['identity_status']), ('running', 'unattested'))
        self.assertEqual(self.report()['status'], 'running')

    def test_missing_lock_and_record_are_not_created(self):
        (self.state / 'runner.lock').unlink()
        report = self.report()
        self.assertEqual((report['status'], report['identity_status']), ('not running', 'absent'))
        self.assertFalse((self.state / 'runner.lock').exists())

    def test_active_departure_and_pending_work_are_not_idle(self):
        self.hold('loop.lock')
        (self.state / 'active-departure').write_text('1793556000\n')
        (self.state / 'deploy-pending').write_text('a' * 40 + '\n')
        (self.state / 'ci' / ('b' * 40 + '.status')).write_text('running\n')
        (self.state / 'last-push.sha').write_text('d' * 40 + '\n')
        (self.state / 'requests').mkdir()
        (self.state / 'requests' / 'one.json').write_text(json.dumps({'state': 'started'}))
        report = self.report(ci='1')
        self.assertTrue(report['loop_lock_held'])
        self.assertFalse(report['idle'])
        self.assertEqual(report['idle_blockers'], ['active_departure', 'deploy_retry_pending', f"ci_watch:{'b' * 40}",
                                                   f"ci_watch_unrecorded:{'d' * 40}", 'request_started:one'])
        self.assertFalse(report['drained'])
        self.assertEqual(self.report(ci='0')['idle_blockers'][:3], ['active_departure', 'deploy_retry_pending', f"ci_watch:{'b' * 40}"])

    def test_unsent_events_and_running_flush_are_not_drained(self):
        (self.state / 'events' / 'one.json').write_text(json.dumps({'sent': False}))
        (self.state / 'events' / 'two.json').write_text(json.dumps({'sent': False, 'suppressed': True}))
        (self.state / 'events' / 'dispatch.lock').touch()
        self.hold('events/dispatch.lock')
        report = self.report()
        self.assertTrue(report['idle'])
        self.assertFalse(report['drained'])
        self.assertEqual(report['reporter_blockers'], ['event_flush_running', 'unsent_events:1'])

    def test_runner_records_identity_after_lock_without_truncation(self):
        text = (ROOT / 'libexec' / 'runner.sh').read_text()
        lock = text.index('exec 5<>"$BUS_DIR/runner.lock"')
        self.assertLess(lock, text.index('flock -n 5'))
        self.assertLess(text.index('flock -n 5'), text.index('status.py" record'))
        self.assertNotIn('exec 5>"$BUS_DIR/runner.lock"', text)

    def test_public_status_command(self):
        conf = self.root / 'project.conf'
        conf.write_text(f'''REPO={self.root}
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
        self.hold('runner.lock')
        self.record()
        result = subprocess.run(['bash', str(ROOT / 'bin/delivery-kit'), '--config', str(conf), '--state-dir',
                                 str(self.state), 'status'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['identity_status'], 'current')


if __name__ == '__main__':
    unittest.main()
