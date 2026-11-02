"""Focused isolated checks for event durability, retry, dedupe and completion truth."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

source=pathlib.Path(__file__).resolve().parents[1] / "libexec"
root=pathlib.Path(tempfile.mkdtemp(dir='/tmp'))
bin=root/'bin';bin.mkdir()
log=root/'sent'
stub=bin/'codex'
stub.write_text('#!/bin/sh\n[ -f "$EVENT_FAIL" ] && exit 1\nprintf "%s\\n" "$*" >> "$EVENT_LOG"\n')
stub.chmod(0o755)
fail=root/'fail';fail.touch()
env=os.environ|{'PATH':str(bin)+':'+os.environ['PATH'],'REPORT_PROJECT':'Fixture','REPORT_THREAD':'fixture-only','EVENT_FAIL':str(fail),'EVENT_LOG':str(log)}
def run(*args):subprocess.run(['python3',str(source/'event.py'),str(root),*args],env=env,check=True)
if '--quiet-only' in sys.argv:
    fail.unlink()
    sha='c'*40
    for kind in ['attempt','push','deploy_failure','ci_failure','ci_timeout','deploy_success','ci_success']:
        run('emit',kind,sha,kind+' '+sha)
    for kind in ['ci_pending','ci_running','deploy_pending','deploy_retry']:
        run('emit',kind,sha,'quiet '+kind)
        stale={'id':kind,'kind':kind,'key':sha,'message':'stale '+kind,'sent':False,'created':0}
        (root/'events'/(kind+'.json')).write_text(json.dumps(stale))
    run('flush');run('flush')
    lines=log.read_text().splitlines()
    assert len(lines)==8 and not any('quiet ' in line or 'stale ' in line for line in lines)
    assert all(any(kind+' '+sha in line for line in lines) for kind in ['attempt','push','deploy_failure','ci_failure','ci_timeout','deploy_success','ci_success'])
    state=json.loads((root/'events'/(sha+'.state')).read_text())
    assert state['ci']=='success' and state['deploy']=='success'
    assert all(json.loads((root/'events'/(kind+'.json')).read_text())['suppressed'] for kind in ['ci_pending','ci_running','deploy_pending','deploy_retry'])
    print('PASS quiet pending/retry events and stale queued noise suppressed; lifecycle outcomes, completion and dedupe retained')
    sys.exit(0)
if '--delivery-only' in sys.argv:
    fail.unlink()
    sha='b'*40
    run('emit','push',sha,sha+' '+'漢🙂é'*1000)
    run('flush')
    delivered=log.read_text().split('--message ',1)[1].rstrip('\n')
    assert len(delivered.encode('utf-8'))<=900
    assert sha in delivered and delivered.endswith(']')
    assert len(next((root/'events').glob('*.json')).read_text().encode('utf-8'))>900
    print('PASS long Unicode delivery fits 900 UTF-8 bytes including event ID; SHA and local metadata retained')
    sys.exit(0)
run('flush');assert not log.exists()
sha='a'*40
run('emit','push',sha,'pushed; CI and deployment pending')
run('emit','push',sha,'duplicate')
run('flush');assert not log.exists()
fail.unlink();run('flush');run('flush')
assert len(log.read_text().splitlines())==1
run('emit','deploy_failure',sha,'deploy failed; retry pending')
run('emit','ci_success',sha,'CI success')
assert not any(json.loads(p.read_text())['kind']=='complete' for p in (root/'events').glob('*.json'))
run('emit','deploy_retry',sha,'retrying')
run('emit','deploy_success',sha,'deployed')
run('emit','deploy_success',sha,'duplicate')
run('flush')
events=[json.loads(p.read_text()) for p in (root/'events').glob('*.json')]
assert sum(x['kind']=='complete' for x in events)==1
assert len(log.read_text().splitlines())==5
assert all(x['sent'] for x in events)
run('emit','blocked-full-gate','attempt1','full gate failed')
run('emit','blocked-batch','attempt1','same failure at caller')
blocked=[json.loads(p.read_text()) for p in (root/'events').glob('*.json') if json.loads(p.read_text())['key']=='attempt1']
assert len(blocked)==1 and blocked[0]['kind']=='blocked-full-gate'
# The subprocess path closes inherited flock descriptors even while delivery blocks.
common='S='+str(source)+'; . "$S/bus-common.sh"; exec 5>"$BUS_DIR/runner.lock"; flock 5; bus_event attempt lockcheck "attempt pending"'
config=root/'bus.conf';repo=root/'repo';bus=repo/'.claude/bus';bus.mkdir(parents=True)
config.write_text('REPO='+str(repo)+'\nMAIN=main\nREMOTE=\nGH_SLUG=\nDEPARTURES="00"\nDEPLOY_SKIP_RE=\nNODE_IMAGE=unused\nCONTAINER_PREFIX=test\nCPUS=4\nMAX_WORKERS=4\nLOAD_LIMIT=24\nGATE_INSTALL=\nGATE_STEPS=()\nDEPLOY_MODE=none\n')
subprocess.run(['bash','-c',common],env=env|{'BUS_CONF':str(config),'BUS_STATE_DIR':str(bus)},capture_output=True,timeout=3,check=True)
import fcntl
with (bus/'runner.lock').open('a') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('PASS empty silence, durable failed delivery, retry/dedupe and CI/deployment completion truth')
