"""Isolated smoke checks with stubbed Git, Docker, deployment and GitHub responses."""
import fcntl
import json
import os
import pathlib
import subprocess
import sys
import tempfile

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "libexec"
SHA = 'a' * 40
BASE = 'b' * 40
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='game-bus-', dir='/tmp'))
BIN = ROOT / 'bin'
BIN.mkdir()
REPO = ROOT / 'repo'
BUS = REPO / '.claude/bus'
BUS.mkdir(parents=True)
WORK = REPO / 'batch'
WORK.mkdir()
CONF = ROOT / 'bus.conf'
LOG = ROOT / 'calls'
CONF.write_text(f'''REPO={REPO}
MAIN=main
REMOTE=origin
GH_SLUG=
DEPARTURES="00 20 40"
DEPLOY_SKIP_RE='(\\.md$|^art/|^gameplay/)'
NODE_IMAGE=unused
CONTAINER_PREFIX=test-
CPUS=4
MAX_WORKERS=4
LOAD_LIMIT=10000
GATE_INSTALL="npm ci"
GATE_MOUNT_GIT=0
GATE_STEPS=("check|check" "lint|lint" "test|test" "build|build")
DEPLOY_MODE=wrangler
CI_REQUIRED_NAMES=Test
''')

def stub(name, body):
    p = BIN / name
    p.write_text('#!/usr/bin/env python3\n' + body)
    p.chmod(0o755)

stub('git', '''import os,pathlib,sys,json
args=sys.argv[1:]
with open(os.environ['CALLS'],'a') as log:log.write('git '+json.dumps(args)+'\\n')
if args[:1]==['-C']:args=args[2:]
command=args[0]
if command=='rev-parse':
 if args[-1].endswith('^{tree}'):print(os.environ.get('WRONG_TREE','f'*40) if args[-1]=='HEAD^{tree}' else 'f'*40)
 elif args[-1].startswith('refs/heads/bus/'):print(os.environ.get('BRANCH_TIP',os.environ['SHA']))
 else:print(os.environ['SHA'] if args[-1]=='HEAD' else pathlib.Path(os.environ['REMOTE_HEAD']).read_text().strip())
elif command=='merge-base':print(os.environ['BASE_SHA'])
elif command=='diff':print(os.environ.get('FILES','src/example.ts'))
elif command=='status':sys.stdout.write(os.environ.get('MOCK_STATUS',''))
elif command=='log':print(os.environ['SHA']+' fixture')
elif command=='worktree' and args[1]=='add':pathlib.Path(args[-2]).mkdir(parents=True,exist_ok=True)
elif command=='push':
 if os.environ.get('PUSH_FAIL')=='1':sys.exit(1)
 pathlib.Path(os.environ['REMOTE_HEAD']).write_text(os.environ['SHA'])
''')
stub('docker', '''import os,pathlib,sys,json
args=sys.argv[1:]
with open(os.environ['CALLS'],'a') as log:log.write('docker '+json.dumps(args)+'\\n')
assert args[args.index('--cpus')+1]=='4'
assert 'WORKERS_CI_COMMIT_SHA='+os.environ['SHA'] in args
if '--network' in args:
 if os.environ.get('GATE_FAIL')=='1':sys.exit(1)
 if os.environ.get('MOVE_BASE')=='1':pathlib.Path(os.environ['REMOTE_HEAD']).write_text('9'*40)
 if os.environ.get('CHANGE_APPROVAL')=='1':pathlib.Path(os.environ['APPROVAL']).write_text('changed')
 mount=next(x for x in args if x.endswith(':/app'));p=pathlib.Path(mount[:-5]);(p/'dist').mkdir(exist_ok=True);(p/'dist/index.html').write_text(os.environ['SHA'][:8])
''')
stub('node', '''import os,pathlib,sys,json
with open(os.environ['CALLS'],'a') as log:log.write('node '+json.dumps(sys.argv[1:])+'\\n')
if pathlib.Path(os.environ['DEPLOY_FAIL']).exists():sys.exit(1)
''')
REMOTE = ROOT / 'head'
REMOTE.write_text(BASE)
FAIL = ROOT / 'fail-deploy'
env = os.environ | {'PATH': str(BIN) + ':' + os.environ['PATH'], 'BUS_CONF': str(CONF), 'BUS_STATE_DIR': str(BUS),
                    'CALLS': str(LOG), 'SHA': SHA, 'BASE_SHA': BASE, 'REMOTE_HEAD': str(REMOTE),
                    'WORK': str(WORK), 'DEPLOY_FAIL': str(FAIL)}
# Entry points use their own directory; expose the shared companions beside test configuration.
for name in ['ci-watch.sh', 'post-push.sh']:
    (BUS / name).symlink_to(SOURCE / name)


def run(script, args=(), extra=None, expected=0):
    result = subprocess.run(['bash', str(SOURCE / script), *args], env=env | (extra or {}),
                            text=True, capture_output=True)
    assert result.returncode == expected, (script, result.returncode, result.stdout, result.stderr)
    return result.stdout

# Exercise the production load_ok function with the container's real awk binary.
load_check = ('S=' + str(SOURCE) + '; . "$S/bus-common.sh"; '
              'LOAD_LIMIT=0; if load_ok; then exit 1; fi; '
              'LOAD_LIMIT=1000000; load_ok')
subprocess.run(['bash', '-c', load_check], env=env, check=True)
for load_value, limit_value, expected in [('23.99', '24', 0), ('24', '24', 1), ('24.01', '24', 1)]:
    result = subprocess.run(['awk', '-v', 'load_value=' + load_value, '-v', 'limit_value=' + limit_value,
                             'BEGIN { exit !(load_value < limit_value) }'], env=env)
    assert result.returncode == expected
assert '-v load=' not in (SOURCE / 'bus-common.sh').read_text()
print('PASS real awk load guard below/equal/above thresholds')
if '--load-guard-only' in sys.argv:
    sys.exit(0)

for p in SOURCE.glob('*.sh'):
    subprocess.run(['bash', '-n', str(p)], check=True)
print('PASS shell syntax')

# Full batch scope decides whether to deploy, even with a trailing documentation commit.
common = 'S=' + str(SOURCE) + '; . "$S/bus-common.sh"; deploy_needed "'+BASE+'" "'+SHA+'"'
def common_run(files):
    return subprocess.run(['bash','-c',common],env=env|{'FILES':files}).returncode
assert common_run('README.md\nart/inventory.md') == 1
assert common_run('README.md\npublic/art/images/example.png') == 0
print('PASS documentation-only and mixed-batch deployment scope')

# A failed deploy retains the exact built worktree and retries without another gate or push.
FAIL.touch()
# Push advances the fixture's remote before post-push verifies it.
run('merge.sh', (str(WORK),'batch-fixture'))
assert (BUS/'deploy-pending').exists()
assert (WORK/'.bus-built.sha').read_text().strip()==SHA
calls=LOG.read_text();assert calls.count('docker ')==2 and calls.count('"push"')==1
assert '--tag' in calls and '--message' in calls and '--no-bundle' in calls
FAIL.unlink()
run('post-push.sh', ('--retry',))
assert not (BUS/'deploy-pending').exists()
assert (BUS/'last-deploy.sha').read_text().strip()==SHA
calls=LOG.read_text();assert calls.count('docker ')==2 and calls.count('"push"')==1
print('PASS gated build SHA, push once, deploy retry without tests/build/push')
# Explicit none mode disables deployment without staging or touching retained assets.
original = CONF.read_text()
CONF.write_text(original + 'DEPLOY_MODE=none\n')
previous_calls = LOG.read_text()
previous_deploy = (BUS/'last-deploy.sha').read_bytes()
run('post-push.sh', ('--stage', str(WORK), 'batch-fixture', SHA, '1'))
assert LOG.read_text() == previous_calls and not (BUS/'deploy-pending').exists()
assert (BUS/'last-deploy.sha').read_bytes() == previous_deploy
CONF.write_text(original)
print('PASS explicit none mode leaves deployment state and commands untouched')


# A failed install/gate never pushes or stages deployment.
LOG.write_text('');REMOTE.write_text(BASE)
run('merge.sh',(str(WORK),'batch-failed'),{'GATE_FAIL':'1'},expected=1)
assert '"push"' not in LOG.read_text() and not (BUS/'deploy-pending').exists()
print('PASS failed gate blocks push/deploy')
LOG.write_text('');REMOTE.write_text(BASE)
output=run('batch.sh',('bus/test-input',),{'GATE_FAIL':'1'},expected=1)
assert 'kept branch batch-' in output and 'node ' not in LOG.read_text()
assert not any('\"branch\", \"-D\"' in x for x in LOG.read_text().splitlines())
print('PASS failed batch retains its commit branch and never deploys')

# Repair approval is limited to one exact failed base and one pinned branch tip.
APPROVAL=BUS/'ci-repair-approval'
CONSUMED=BUS/'ci-repair-approval.consumed'
(BUS/'ci').mkdir(exist_ok=True)
REPAIR='bus/ci-repair'
def prepare_repair():
    LOG.write_text('');REMOTE.write_text(BASE)
    (BUS/'last-push.sha').write_text(BASE+'\n')
    (BUS/'ci'/f'{BASE}.status').write_text('failure\n')
    APPROVAL.write_text(BASE+'\n'+REPAIR+'\n'+SHA+'\n')
    if CONSUMED.exists():CONSUMED.unlink()
    if (BUS/'deploy-pending').exists():(BUS/'deploy-pending').unlink()

def repair_run(extra=None, expected=1, branches=None):
    return run('batch.sh',tuple(branches or [REPAIR]), {'APPROVAL':str(APPROVAL)}|(extra or {}),expected)

for extra,branches in [({'BRANCH_TIP':'8'*40},None), ({},[REPAIR,'bus/extra'])]:
    prepare_repair();repair_run(extra,branches=branches)
    assert '"push"' not in LOG.read_text() and 'docker ' not in LOG.read_text()
    assert APPROVAL.exists() and not CONSUMED.exists()
prepare_repair();REMOTE.write_text('7'*40);repair_run()
assert '"push"' not in LOG.read_text() and APPROVAL.exists()
for extra in [{'GATE_FAIL':'1'},{'PUSH_FAIL':'1'},{'MOVE_BASE':'1'},{'CHANGE_APPROVAL':'1'},{'WRONG_TREE':'0'*40}]:
    prepare_repair();repair_run(extra)
    assert APPROVAL.exists() and not CONSUMED.exists()
    if 'PUSH_FAIL' not in extra:assert '"push"' not in LOG.read_text()
print('PASS repair rejects wrong base/tip/tree/extra branch and preserves failed approval')
prepare_repair()
repair_run({'SKIP_GATE':'1'},expected=0)
assert not APPROVAL.exists() and CONSUMED.exists()
assert LOG.read_text().count('docker ')==2 and LOG.read_text().count('"push"')==1
assert (BUS/'ci'/f'{BASE}.status').read_text().strip()=='failure'
# Reintroducing the same approval cannot reuse it, even if the fixture remote is reset.
REMOTE.write_text(BASE);(BUS/'last-push.sha').write_text(BASE+'\n')
APPROVAL.write_text(CONSUMED.read_text());LOG.write_text('')
repair_run()
assert '"push"' not in LOG.read_text() and 'docker ' not in LOG.read_text()
assert APPROVAL.exists() and CONSUMED.exists()
APPROVAL.unlink();CONSUMED.unlink();(BUS/'last-push.sha').write_text(SHA+'\n')
print('PASS one-shot repair requires full gate, consumes only after push and rejects replay')

# Refuse manual departures and duplicate scheduled loops before touching the queue.
run('bus.sh',('--now',),expected=2)
with open(BUS/'loop.lock','w') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    run('bus.sh',expected=1)
with open(BUS/'runner.lock','w') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    run('runner.sh',expected=1)
print('PASS scheduled-only entry point and singleton runner/loop locks')

# Exercise one real scheduled departure with a high-load threshold and an untouched queue.
stub('codex', '''import sys
sys.exit(1)
''')
CONF.write_text(CONF.read_text()+'REPORT_PROJECT=Fixture\nREPORT_THREAD=fixture-only\n')
(BUS/'bus-queue').write_text('bus/queued\n')
CONF.write_text(CONF.read_text()+'LOAD_LIMIT=0\n')
stub('date', '''import os,pathlib,sys
p=pathlib.Path(os.environ['CALLS']+'.sleeps')
if sys.argv[1:]==['+%s']:print(1000+(int(p.read_text()) if p.exists() else 0))
elif '-d' in sys.argv:print('19 59')
else:print('fixture departure')
''')
stub('sleep', '''import os,pathlib,signal
p=pathlib.Path(os.environ['CALLS']+'.sleeps');n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
if n>1:os.kill(os.getppid(),signal.SIGTERM)
''')
run('bus.sh',expected=-15)
assert (BUS/'bus-queue').read_text()=='bus/queued\n'
CONF.write_text(CONF.read_text()+'LOAD_LIMIT=10000\n')
events=[json.loads(p.read_text()) for p in (BUS/'events').glob('*.json')]
assert {event['kind'] for event in events}=={'attempt','blocked-load'}
print('PASS high-load departure retains queue and persists attempt/blocked events')
# Empty scheduled ticks add no events.
(BUS/'bus-queue').write_text('')
pathlib.Path(str(LOG)+'.sleeps').unlink()
run('bus.sh',expected=-15)
assert len(list((BUS/'events').glob('*.json')))==2
CONF.write_text(CONF.read_text()+'REPORT_THREAD=\n')
# A red departure validates its complete queue before draining it.
for queued in [REPAIR+'\n'+'bus/extra\n',REPAIR+'\n']:
    prepare_repair();(BUS/'bus-queue').write_text(queued)
    pathlib.Path(str(LOG)+'.sleeps').unlink()
    run('bus.sh',expected=-15)
    if 'bus/extra' in queued:
        assert (BUS/'bus-queue').read_text()==queued
        assert APPROVAL.exists() and 'docker ' not in LOG.read_text()
    else:
        assert (BUS/'bus-queue').read_text()==''
        assert CONSUMED.exists() and not APPROVAL.exists()
        assert LOG.read_text().count('\"push\"')==1
CONSUMED.unlink();(BUS/'last-push.sha').write_text(SHA+'\n')
print('PASS scheduled red departure rejects extra queue and consumes exact repair after gate')

# Simulated public API checks verify green/red status files without network access.
SITE=ROOT/'site';SITE.mkdir()
(SITE/'sitecustomize.py').write_text('''import io,json,os,urllib.request
class Response(io.StringIO):
 def __enter__(self):return self
 def __exit__(self,*args):pass
def urlopen(request,**kwargs):
 assert '/commits/'+os.environ['EXPECTED_CI_SHA']+'/check-runs?' in request.full_url
 return Response(os.environ['CHECK_PAYLOAD'])
urllib.request.urlopen=urlopen
''')
CI_SHA='c'*40
payload={'check_runs':[{'id':1,'name':'Test','status':'completed','conclusion':'success'}]}
ci_extra={'EXPECTED_CI_SHA':CI_SHA,'PYTHONPATH':str(SITE),'CHECK_PAYLOAD':json.dumps(payload),'CI_POLL_SECONDS':'0','CI_TIMEOUT_SECONDS':'1'}
# Configuration supplies defaults via shell environment.
run('ci-watch.sh',(CI_SHA,),ci_extra)
assert (BUS/'ci'/f'{CI_SHA}.status').read_text().strip()=='success'
payload['check_runs'][0]['conclusion']='failure'
run('ci-watch.sh',('d'*40,),ci_extra|{'EXPECTED_CI_SHA':'d'*40,'CHECK_PAYLOAD':json.dumps(payload)},expected=1)
assert (BUS/'ci'/('d'*40+'.status')).read_text().strip()=='failure'
payload['check_runs'][0]['conclusion']='success'
payload['check_runs'].append({'id':2,'name':'Unrelated workflow','status':'completed','conclusion':'failure'})
run('ci-watch.sh',('f'*40,),ci_extra|{'EXPECTED_CI_SHA':'f'*40,'CHECK_PAYLOAD':json.dumps(payload)},expected=1)
assert (BUS/'ci'/('f'*40+'.status')).read_text().strip()=='failure'
payload['check_runs'][1].update(status='in_progress', conclusion=None)
run('ci-watch.sh',('9'*40,),ci_extra|{'EXPECTED_CI_SHA':'9'*40,'CHECK_PAYLOAD':json.dumps(payload)},expected=2)
assert (BUS/'ci'/('9'*40+'.status')).read_text().strip()=='timeout'
print('PASS background CI success/failure metadata states')
# CI monitors cannot retain the scheduled runner's lock descriptors.
original=CONF.read_text();CONF.write_text(original+'GH_SLUG=fixture/project\n')
background_env=ci_extra|{'EXPECTED_CI_SHA':'e'*40,'CI_TIMEOUT_SECONDS':'2','CI_POLL_SECONDS':'1','CHECK_PAYLOAD':json.dumps({'check_runs':[{'id':1,'name':'Test','status':'in_progress','conclusion':None}]})}
launch='S='+str(SOURCE)+'; . \"$S/bus-common.sh\"; exec 5>\"$BUS_DIR/runner.lock\"; flock 5; exec 9>\"$BUS_DIR/merge.lock\"; flock 9; start_ci '+('e'*40)
result=subprocess.run(['bash','-c',launch],env=env|background_env,text=True,capture_output=True,timeout=3)
assert result.returncode==0
for name in ['runner.lock','merge.lock']:
    with open(BUS/name,'w') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
CONF.write_text(original)
print('PASS background CI releases inherited runner/merge locks')
LOG.write_text('')
run('resource-report.sh')
resource_calls=LOG.read_text()
assert 'git ' not in resource_calls and '\"ps\"' in resource_calls
print('PASS resource sampler performs reporting only')
print('All isolated bus smoke checks passed')
