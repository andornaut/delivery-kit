"""Native CLI and scheduled boundaries ignore PATH Python without real socket operations."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TECH = '00000000-0000-0000-0000-000000000001'
ART = '00000000-0000-0000-0000-000000000002'
GAMEPLAY = '00000000-0000-0000-0000-000000000003'


class NativePythonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.site = self.root / 'site'
        self.site.mkdir()
        self.shadow = self.root / 'shadow'
        self.shadow.mkdir()
        python = self.shadow / 'python3'
        python.write_text('#!/bin/sh\necho PATH_PYTHON_USED >&2\nexit 91\n')
        python.chmod(0o755)
        self.log = self.root / 'native-calls'
        self.wrapper_log = self.root / 'wrapper-calls'
        self.wrapper = self.root / 'native-python'
        self.wrapper.write_text('#!/bin/sh\nprintf "selected\\n" >> "$WRAPPER_CALLS"\nexec /usr/bin/python3 "$@"\n')
        self.wrapper.chmod(0o755)
        self.mapping = self.root / 'sessions.json'
        self.mapping.write_text(json.dumps({'codex': {'tech': TECH, 'art': ART, 'gameplay': GAMEPLAY}}))
        decisions = self.state / 'unblock' / 'decisions'
        decisions.mkdir(parents=True)
        (decisions / (TECH + '.json')).write_text(json.dumps({'thread_id': TECH, 'state': 'clear'}))
        self.conf = self.root / 'project.conf'
        self.original = f'''REPO={self.root}
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
CODEX_CONTROL_SOCKET=/fixture/control.sock
CODEX_SHARED_ROLES=''
SHARED_TARGETS_FILE=''
SESSION_MAP_FILE={self.mapping}
'''
        self.conf.write_text(self.original)
        self.env = {key: value for key, value in os.environ.items() if key != 'CODEX_PYTHON'}
        self.env.update(PATH=str(self.shadow) + ':' + os.environ['PATH'], PYTHONPATH=str(self.site),
                        NATIVE_CALLS=str(self.log), WRAPPER_CALLS=str(self.wrapper_log))
        (self.site / 'sitecustomize.py').write_text('''import builtins,json,os,pathlib,socket,sys,types
with open(os.environ['NATIVE_CALLS'],'a') as stream:
 stream.write(json.dumps({'executable':sys.executable,'script':pathlib.Path(sys.argv[0]).name})+'\\n')
original_is_socket=pathlib.Path.is_socket
pathlib.Path.is_socket=lambda path: str(path)=='/fixture/control.sock' or original_is_socket(path)
class Transport:
 def settimeout(self,*args): pass
 def connect(self,path):
  assert path=='/fixture/control.sock'
 def close(self): pass
socket.socket=lambda *args,**kwargs: Transport()
class Connection:
 def settimeout(self,*args): pass
 def send(self,message):
  self.message=json.loads(message)
  if os.environ.get('RPC_CALLS'):
   with open(os.environ['RPC_CALLS'],'a') as stream:
    stream.write(json.dumps({'method':self.message['method'],'thread_id':self.message.get('params',{}).get('threadId')})+'\\n')
 def recv(self):
  method=self.message['method']; params=self.message.get('params',{})
  if method=='thread/queue/list':
   result={'data':[{'id':'queued-one','clientUserMessageId':'client-one','input':[{'type':'text','text':'PRIVATE_QUEUE_PAYLOAD'}]}]}
  elif method=='thread/read': result={'thread':{'status':{'type':'active','activeFlags':[]},'canAcceptDirectInput':True}}
  elif method=='thread/turns/list': result={'data':[{'id':'turn-one','status':'inProgress'}]}
  elif method=='thread/items/list': result={'data':[]}
  elif method=='turn/steer': result={'turnId':'turn-one'}
  elif method=='initialize': result={}
  else: raise AssertionError(method)
  return json.dumps({'id':self.message['id'],'result':result})
 def close(self): pass
def create_connection(*args,**kwargs):
 if os.environ.get('FAKE_NATIVE_MODE')=='transport-error': raise RuntimeError('PRIVATE_TRANSPORT_BODY')
 return Connection()
if os.environ.get('FAKE_NATIVE_MODE')=='missing-dependency':
 original_import=builtins.__import__
 def import_module(name,*args,**kwargs):
  if name=='websocket': raise ModuleNotFoundError('PRIVATE_DEPENDENCY_BODY')
  return original_import(name,*args,**kwargs)
 builtins.__import__=import_module
else:
 sys.modules['websocket']=types.SimpleNamespace(create_connection=create_connection)
''')

    def public(self, command='monitor-snapshot', extra=None):
        args = ['/bin/bash', str(ROOT / 'bin/delivery-kit'), '--config', str(self.conf),
                '--state-dir', str(self.state), command]
        if command == 'monitor-snapshot':
            args += ['--recipient', TECH]
        return subprocess.run(args, env=self.env | (extra or {}), capture_output=True, text=True, timeout=5)

    def scheduled(self, extra=None):
        command = f'S="{ROOT / "libexec"}"; . "$S/bus-common.sh"; bus_unblock_tick 1793556000'
        return subprocess.run(['/bin/bash', '-c', command], env=self.env | {
            'BUS_CONF': str(self.conf), 'BUS_STATE_DIR': str(self.state)} | (extra or {}),
            capture_output=True, text=True, timeout=5)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_default_and_configured_interpreter_bypass_path_shadow_for_public_and_scheduled(self):
        result = self.public()
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot = json.loads(result.stdout)
        self.assertTrue(Path(snapshot['path']).is_file())
        self.assertNotIn('PRIVATE_QUEUE_PAYLOAD', result.stdout + result.stderr)
        self.assertEqual(self.calls()[0], {'executable': '/usr/bin/python3', 'script': 'monitor.py'})
        self.conf.write_text(self.original + f'CODEX_PYTHON={self.wrapper}\n')
        self.assertEqual(self.public().returncode, 0)
        result = self.scheduled()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('accepted', result.stdout)
        self.assertNotIn('PRIVATE_QUEUE_PAYLOAD', result.stdout + result.stderr)
        self.assertEqual(self.wrapper_log.read_text().splitlines(), ['selected'] * 3)
        self.assertEqual([row['script'] for row in self.calls()], ['monitor.py', 'monitor.py', 'codex_adapter.py', 'unblock.py'])
        self.assertTrue(all(row['executable'] == '/usr/bin/python3' for row in self.calls()))

    def test_routed_observer_uses_monitor_clearance_and_persistent_slot_deduplication(self):
        monitor = '00000000-0000-0000-0000-000000000004'
        route = self.root / 'monitor-route.json'
        route.write_text(json.dumps({'version': 1, 'harness': 'codex',
                                     'host_project_root': str(self.root), 'state': 'active',
                                     'monitor_thread_id': monitor,
                                     'targets': [{'thread_id': TECH, 'ownership': 'active'},
                                                 {'thread_id': GAMEPLAY, 'ownership': 'active'}]}))
        self.conf.write_text(self.original + f'MONITOR_ROUTE_FILE={route}\n')
        rpc_log = self.root / 'rpc-calls'
        self.env['RPC_CALLS'] = str(rpc_log)
        twenty = int(subprocess.check_output(['date', '-d', '2026-11-02T14:20:00-05:00', '+%s'], text=True))
        fifty = twenty + 1800
        def observe(slot):
            command = f'S="{ROOT / "libexec"}"; . "$S/bus-common.sh"; bus_monitor_due_ticks {slot-1} {slot+15}'
            return subprocess.run(['/bin/bash', '-c', command], env=self.env | {
                'BUS_CONF': str(self.conf), 'BUS_STATE_DIR': str(self.state)},
                capture_output=True, text=True, timeout=5)
        first = observe(twenty)
        self.assertEqual(first.returncode, 0, first.stderr)
        first_receipt = json.loads((self.state / 'unblock' / f'{monitor}-{twenty}.json').read_text())
        self.assertEqual(first_receipt['status'], 'deferred')
        queues = json.loads(Path(first_receipt['snapshot_path']).read_text())['queues']
        self.assertEqual(set(queues), {monitor, TECH, GAMEPLAY})
        self.assertEqual(queues[TECH][0]['input'][0]['text'], 'PRIVATE_QUEUE_PAYLOAD')
        calls = [json.loads(line) for line in rpc_log.read_text().splitlines()]
        self.assertFalse(any(row['method'].startswith('turn/') for row in calls))
        decision = self.state / 'unblock' / 'decisions' / (monitor + '.json')
        decision.write_text(json.dumps({'thread_id': monitor, 'state': 'clear'}))
        next_slot = observe(fifty)
        self.assertEqual(next_slot.returncode, 0, next_slot.stderr)
        self.assertIn('accepted', next_slot.stdout)
        duplicate = observe(fifty)
        self.assertIn('deduplicated', duplicate.stdout)
        mutations = [row for row in (json.loads(line) for line in rpc_log.read_text().splitlines())
                     if row['method'].startswith('turn/')]
        self.assertEqual(mutations, [{'method': 'turn/steer', 'thread_id': monitor}])
        receipt = json.loads((self.state / 'unblock' / f'{monitor}-{fifty}.json').read_text())
        self.assertEqual(receipt['status'], 'accepted')
        self.assertNotIn('PRIVATE_QUEUE_PAYLOAD', first.stdout + next_slot.stdout + duplicate.stdout)

    def test_invalid_declared_interpreter_never_falls_back_or_breaks_nonnative_config(self):
        nonexecutable = self.root / 'not-executable'
        nonexecutable.write_text('fixture')
        for value in ('', 'python3', str(self.root / 'missing-python'), str(nonexecutable)):
            with self.subTest(value=value):
                self.conf.write_text(self.original + f"CODEX_PYTHON='{value}'\n")
                self.assertEqual(self.public('check-config').returncode, 0)
                result = self.public()
                self.assertEqual(result.returncode, 2)
                self.assertIn('CODEX_PYTHON', result.stderr)
                result = self.scheduled()
                self.assertEqual(result.returncode, 0)
                self.assertIn('CODEX_PYTHON', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_dependency_capability_names_actual_interpreter_without_private_error_bodies(self):
        mode = {'FAKE_NATIVE_MODE': 'missing-dependency'}
        public = self.public(extra=mode)
        self.assertEqual(public.returncode, 1)
        reason = json.loads(public.stdout)['reason']
        self.assertIn('websocket-client', reason)
        self.assertIn('/usr/bin/python3', reason)
        self.assertIn('CODEX_PYTHON', reason)
        scheduled = self.scheduled(extra=mode)
        self.assertEqual(scheduled.returncode, 0)
        self.assertIn(reason, scheduled.stdout)
        self.assertNotIn('PRIVATE_', public.stdout + public.stderr + scheduled.stdout + scheduled.stderr)
        private_transport = self.public(extra={'FAKE_NATIVE_MODE': 'transport-error'})
        self.assertEqual(private_transport.returncode, 1)
        self.assertNotIn('PRIVATE_', private_transport.stdout + private_transport.stderr)
        self.assertNotIn('websocket-client', json.loads(private_transport.stdout)['reason'])
