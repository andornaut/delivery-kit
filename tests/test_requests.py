"""One-off requests use real scratch Git refs and fake departure/time boundaries."""
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.state = self.root / 'state'
        self.state.mkdir()
        self.mechanisms = self.root / 'mechanisms'
        self.mechanisms.mkdir()
        for name in ['bus.sh', 'bus-common.sh', 'departure.sh', 'request.py']:
            (self.mechanisms / name).symlink_to(ROOT / 'libexec' / name)
        self.env = os.environ | {'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                                'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid',
                                'BUS_STATE_DIR': str(self.state), 'FIXTURE': str(self.root)}
        self.git('init', '-q', '-b', 'main')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '--allow-empty', '-qm', 'fixture')
        self.tip = self.git('rev-parse', 'HEAD')
        self.git('branch', 'bus/feature')
        self.queue = self.state / 'bus-queue'
        self.queue.write_text('bus/feature\nbus/feature\n')
        conf = self.root / 'conf'
        conf.write_text(f'''REPO={self.repo}
MAIN=main
REMOTE=
GH_SLUG=
DEPARTURES=00
DEPLOY_SKIP_RE=
NODE_IMAGE=unused
CONTAINER_PREFIX=fixture
CPUS=4
MAX_WORKERS=4
LOAD_LIMIT=1000000
GATE_INSTALL=
GATE_STEPS=()
''')
        self.env['BUS_CONF'] = str(conf)
        self.calls = self.root / 'calls'
        (self.mechanisms / 'batch.sh').write_text('''#!/bin/bash
printf '%s|%s|%s\\n' "${BUS_ATTEMPT:-}" "${BUS_REQUEST_RECORD:-}" "$*" >> "$FIXTURE/calls"
exit "${FAIL_BATCH:-0}"
''')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], env=self.env, text=True).strip()

    def helper(self, action, *args, expected=0):
        result = subprocess.run(['python3', str(ROOT / 'libexec/request.py'), str(self.state),
                                 str(self.repo), action, *args], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result.stdout.strip()

    def record(self, identity='one'):
        return json.loads((self.state / 'requests' / (identity + '.json')).read_text())

    def shell(self, body, extra=None):
        script = f'S="{self.mechanisms}"; . "$S/bus-common.sh"; . "$S/departure.sh"; Q="$BUS_DIR/bus-queue"; ' + body
        return subprocess.run(['bash', '-c', script], env=self.env | (extra or {}),
                              capture_output=True, text=True, timeout=8)

    def test_concurrent_idempotent_capture_and_single_claim(self):
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            captures = list(pool.map(lambda _: self.helper('capture', 'one'), range(8)))
            claims = list(pool.map(lambda _: self.helper('claim'), range(8)))
        self.assertEqual(len(set(captures)), 1)
        self.assertEqual(claims.count('one'), 1)
        self.assertEqual(self.record()['entries'], [['bus/feature', self.tip]])
        self.helper('recover')
        self.assertEqual(self.record()['state'], 'interrupted')
        self.assertEqual(self.helper('claim'), '')
        self.assertEqual(json.loads(self.helper('capture', 'one'))['state'], 'interrupted')

    def test_queue_then_receipt_lock_order_does_not_deadlock_capture(self):
        self.helper('capture', 'one')
        with (self.state / 'bus-queue.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                capture = pool.submit(self.helper, 'capture', 'two')
                time.sleep(0.1)
                # Validation takes requests.lock while this process holds the queue lock.
                self.helper('validate', 'one')
                fcntl.flock(lock, fcntl.LOCK_UN)
                capture.result(timeout=5)

    def test_stale_queue_and_tip_reject_without_consumption(self):
        for change in ('queue', 'tip'):
            with self.subTest(change=change):
                self.queue.write_text('bus/feature\n')
                self.helper('capture', change)
                self.helper('claim')
                if change == 'queue':
                    self.queue.write_text('bus/feature\nmain\n')
                else:
                    self.git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '--allow-empty', '-qm', 'next')
                    self.git('branch', '-f', 'bus/feature', 'HEAD')
                before = self.queue.read_bytes()
                result = self.shell('depart', {'BUS_REQUEST_ID': change})
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(self.record(change)['state'], 'rejected')
                self.assertEqual(self.queue.read_bytes(), before)
                self.assertFalse(self.calls.exists())

    def test_change_between_queue_reads_rejected(self):
        self.helper('capture', 'one')
        self.helper('claim')
        # load_ok occurs after the first queue read and before the final queue read.
        result = self.shell('load_ok() { printf "main\\n" >> "$Q"; }; depart', {'BUS_REQUEST_ID': 'one'})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.queue.read_text(), 'bus/feature\nbus/feature\nmain\n')
        self.assertEqual(self.record()['state'], 'rejected')
        self.assertFalse(self.calls.exists())

    def test_failed_request_once_and_later_schedule_has_no_leaked_context(self):
        self.helper('capture', 'one')
        self.helper('claim')
        result = self.shell('''BUS_REQUEST_ID=one FAIL_BATCH=1 depart
result=$?
python3 "$S/request.py" "$BUS_DIR" "$REPO" finish one "$result"
printf 'main\\n' > "$Q"
depart
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = self.calls.read_text().splitlines()
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0].startswith('request-one|'))
        self.assertIn('/requests/one.json|', rows[0])
        self.assertEqual(rows[1].split('|')[1:], ['', 'main'])
        self.assertEqual(self.record()['departure_exit'], 1)
        self.helper('recover')
        self.assertEqual(self.helper('claim'), '')
        self.assertNotIn('scheduled attempt', result.stdout.split('bus departs with:')[0])

    def test_resident_keeps_hourly_deadline_and_skips_crossed_slot(self):
        for duration in (0, 20, 120):
            with self.subTest(duration=duration):
                if (self.state / 'requests').exists():
                    shutil.rmtree(self.state / 'requests')
                self.queue.write_text('bus/feature\n')
                self.helper('capture', 'one')
                clock = self.root / 'clock'
                # 2026-10-31 10:59:50 UTC, ten seconds before the next hourly slot.
                start = 1793444390
                clock.write_text(str(start))
                tools = self.root / 'tools'
                tools.mkdir(exist_ok=True)
                (tools / 'date').write_text('''#!/bin/sh
if [ "$*" = +%s ]; then cat "$FIXTURE/clock"; else exec /usr/bin/date "$@"; fi
''')
                (tools / 'sleep').write_text('''#!/usr/bin/env python3
import os, pathlib, signal, sys
p=pathlib.Path(os.environ['FIXTURE'])/'clock'
n=int(p.read_text())+int(sys.argv[1]); p.write_text(str(n))
if n >= int(os.environ['STOP_AT']): os.kill(os.getppid(), signal.SIGTERM)
''')
                for tool in tools.iterdir():
                    tool.chmod(0o755)
                (self.mechanisms / 'batch.sh').write_text(f'''#!/bin/bash
printf '%s\\n' "$BUS_ATTEMPT" >> "$FIXTURE/loop-calls"
echo $(( $(cat "$FIXTURE/clock") + {duration} )) > "$FIXTURE/clock"
''')
                common = self.mechanisms / 'bus-common.sh'
                if common.is_symlink():
                    common.unlink()
                common.write_text((ROOT / 'libexec/bus-common.sh').read_text() + '\nbus_report_scheduled_tick() { date +%s >> "$FIXTURE/ticks"; }\n')
                (self.root / 'ticks').write_text('')
                loop_calls = self.root / 'loop-calls' 
                loop_calls.write_text('')
                env = self.env | {'PATH': str(tools) + ':' + self.env['PATH'], 'STOP_AT': str(start + 140),
                                  'TZ': 'UTC'}
                # Set the configured timezone explicitly; the production default is Toronto.
                with Path(self.env['BUS_CONF']).open('a') as stream:
                    stream.write('BUS_TIMEZONE=UTC\n')
                result = subprocess.run(['bash', str(self.mechanisms / 'bus.sh')], env=env,
                                        capture_output=True, text=True, timeout=8)
                self.assertEqual(result.returncode, -15, result.stderr)
                self.assertEqual(loop_calls.read_text().splitlines(), ['request-one'])
                self.assertEqual(self.record()['state'], 'finished')
                ticks = (self.root / 'ticks').read_text().splitlines()
                self.assertEqual(ticks, [str(start + 10)] if duration == 0 else [])
                self.assertGreaterEqual(int(clock.read_text()), start + 140)

    def test_batch_integrates_captured_tip_and_retains_advanced_branch(self):
        self.git('checkout', '-q', 'bus/feature')
        (self.repo / 'value').write_text('captured')
        self.git('add', 'value')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-qm', 'feature')
        self.helper('capture', 'one')
        (self.repo / 'value').write_text('advanced')
        self.git('add', 'value')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-qm', 'later')
        advanced = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', 'main')
        (self.mechanisms / 'batch.sh').write_text((ROOT / 'libexec/batch.sh').read_text())
        (self.mechanisms / 'merge.sh').write_text('''#!/bin/bash
cat "$1/value" > "$FIXTURE/integrated"
''')
        result = subprocess.run(['bash', str(self.mechanisms / 'batch.sh'), 'bus/feature'],
                                env=self.env | {'BUS_REQUEST_RECORD': str(self.state / 'requests/one.json')},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'integrated').read_text(), 'captured')
        self.assertEqual(self.git('rev-parse', 'bus/feature'), advanced)

    def test_public_cli_captures_only_and_refuses_invalid_or_empty_requests(self):
        command = ['bash', str(ROOT / 'bin/delivery-kit'), '--config', self.env['BUS_CONF'],
                   '--state-dir', str(self.state), 'request-once', '--request-id']
        for identity in ('../escape', '-option', 'a' * 65):
            result = subprocess.run(command + [identity], capture_output=True, text=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(command + ['one'], capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['state'], 'pending')
        self.assertFalse(self.calls.exists())
        self.queue.write_text('')
        result = subprocess.run(command + ['one'], capture_output=True, text=True, timeout=3)
        self.assertEqual(json.loads(result.stdout)['state'], 'pending')
        result = subprocess.run(command + ['empty'], capture_output=True, text=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
