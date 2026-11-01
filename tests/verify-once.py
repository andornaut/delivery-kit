"""Isolated entry-point checks with a stub batch and no real gate or push."""
import fcntl
import os
import pathlib
import subprocess
import tempfile

source=pathlib.Path(__file__).resolve().parents[1] / "libexec"
root=pathlib.Path(tempfile.mkdtemp(dir='/tmp'))
bus=root/'.claude/bus';bus.mkdir(parents=True)
bin=root/'bin';bin.mkdir()
for name in ['scheduled-once.sh','bus-common.sh','departure.sh']:(bus/name).symlink_to(source/name)
(bus/'batch.sh').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nexit "${FAIL_BATCH:-0}"\n')
(bin/'date').write_text('#!/bin/sh\nif [ "$*" = +%s ]; then printf "%s\\n" "$MOCK_NOW"; else exec /usr/bin/date "$@"; fi\n');(bin/'date').chmod(0o755)
(bus/'bus.conf').write_text(f'''REPO={root}
MAIN=main
REMOTE=
GH_SLUG=
DEPARTURES="00 20 40"
DEPLOY_SKIP_RE=
NODE_IMAGE=unused
CONTAINER_PREFIX=test
CPUS=4
MAX_WORKERS=4
LOAD_LIMIT=1000000
GATE_INSTALL=
GATE_STEPS=()
REPORT_THREAD=
''')
slot=1793422800
assert subprocess.check_output(['/usr/bin/date','-d','@'+str(slot),'+%M %S'],text=True).strip()=='00 00'
env=os.environ|{'PATH':str(bin)+':'+os.environ['PATH'],'BUS_CONF':str(bus/'bus.conf'),'BUS_STATE_DIR':str(bus),'MOCK_NOW':str(slot+30),'CALLS':str(root/'calls')}
def run(args=(),expected=0,extra=None):
 p=subprocess.run(['bash',str(bus/'scheduled-once.sh'),*args],env=env|(extra or {}),capture_output=True,text=True,timeout=5)
 assert p.returncode==expected,(p.returncode,p.stdout,p.stderr)
 return p
for name in ['scheduled-once.sh','departure.sh','bus.sh']:subprocess.run(['bash','-n',str(source/name)],check=True)
run(('--scheduled-at',str(slot-1200)),expected=2)
run(('--scheduled-at',str(slot+1200)),expected=2)
(bus/'bus-queue').write_text('bus/feature\n')
with (bus/'runner.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX);run(expected=1)
assert not (bus/'native-slots').exists() and (bus/'bus-queue').read_text()=='bus/feature\n'
run();assert (root/'calls').read_text()=='bus/feature\n'
(bus/'bus-queue').write_text('bus/later\n');run()
assert (root/'calls').read_text()=='bus/feature\n' and (bus/'bus-queue').read_text()=='bus/later\n'
run(expected=1,extra={'MOCK_NOW':str(slot+1230),'FAIL_BATCH':'1'})
assert (bus/'native-slots'/f'{slot+1200}.status').read_text()=='finished exit=1\n'
(bus/'bus-queue').write_text('bus/fixed\n')
run(extra={'MOCK_NOW':str(slot+1230)})
assert (bus/'bus-queue').read_text()=='bus/fixed\n'
run(extra={'MOCK_NOW':str(slot+2430)})
assert (root/'calls').read_text().splitlines()==['bus/feature','bus/later','bus/fixed']
empty=run(extra={'MOCK_NOW':str(slot+3630)})
assert not empty.stdout and not empty.stderr
assert not (bus/'bus-queue').read_text()
assert (bus/'native-slots'/f'{slot+3600}.status').read_text()=='finished exit=0\n'
print('PASS one-shot schedule/window, legacy lock exclusion, duplicate/failed-slot receipts, independent next slot and empty success; no real gate/push/deploy')
