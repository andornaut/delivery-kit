#!/usr/bin/env bash
# Poll bounded GitHub check metadata using the existing CLI login or public API.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
. "$S/bus-common.sh"
sha=$1
mkdir -p "$BUS_DIR/ci"
exec 6>"$BUS_DIR/ci/$sha.lock"
flock -n 6 || exit 0
bus_event ci_pending "$sha" "CI monitoring pending/running for pushed $sha; completion not confirmed; deployment tracked separately."
python3 - "$GH_SLUG" "$sha" "$BUS_DIR/ci" "$CI_POLL_SECONDS" "$CI_TIMEOUT_SECONDS" "$DEPLOY_MODE" "${2:-1}" "$CI_REQUIRED_NAMES" <<'PY'
import json,pathlib,shutil,subprocess,sys,time,urllib.request
slug,sha,directory,poll,timeout,mode,needed,required=sys.argv[1:]
required_names=set(required.split('|'))
root=pathlib.Path(directory); status=root/(sha+'.status'); summary=root/(sha+'.json')
def state(value):
 tmp=status.with_suffix('.status.tmp'); tmp.write_text(value+'\n'); tmp.replace(status)
state('running'); last=None; deadline=time.monotonic()+int(timeout)
while time.monotonic()<deadline:
 try:
  path='repos/'+slug+'/commits/'+sha+'/check-runs?per_page=100'
  if shutil.which('gh'):
   result=subprocess.run(['gh','api',path,'--jq','.check_runs | map({id,name,status,conclusion})'],capture_output=True,text=True,timeout=25)
   if result.returncode:raise RuntimeError('GitHub CLI metadata query failed (exit '+str(result.returncode)+')')
   payload={'check_runs':json.loads(result.stdout)}
  else:
   request=urllib.request.Request('https://api.github.com/'+path,headers={'Accept':'application/vnd.github+json','User-Agent':'scheduled-game-bus'})
   with urllib.request.urlopen(request,timeout=20) as response: payload=json.load(response)
  # A rerun supersedes an older check of the same name.
  latest={}
  for check in payload.get('check_runs',[]):
   name=check['name']
   if name not in latest or check['id']>latest[name]['id']:latest[name]=check
  rows=[{'name':c['name'],'status':c['status'],'conclusion':c['conclusion']} for c in latest.values()]
  rows.sort(key=lambda c:c['name'])
  encoded=json.dumps(rows,sort_keys=True)
  if encoded!=last:
   print(time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),encoded,flush=True);summary.write_text(encoded+'\n');last=encoded
  failed=[c for c in rows if c['status']=='completed' and c['conclusion'] not in ('success','neutral','skipped')]
  if failed:state('failure');sys.exit(1)
  # The test workflow exists in both games. Require it so a partially registered list is not green.
  names={c['name'] for c in rows}
  if rows and required_names <= names and all(c['status']=='completed' for c in rows):
   if mode!='workers-builds' or needed!='1' or any(c['name'].startswith('Workers Builds:') for c in rows):
    state('success');sys.exit(0)
 except Exception as error:
  print(time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),type(error).__name__,str(error),flush=True)
 time.sleep(int(poll))
state('timeout');print('CI monitor timed out; inspect the commit checks before declaring completion',flush=True);sys.exit(2)
PY
result=$?
case "$result" in
  0) bus_event ci_success "$sha" "CI success for $sha; deployment completion is tracked separately." ;;
  1) bus_event ci_failure "$sha" "CI FAILED for pushed $sha; monitor stopped on red; deployment state tracked separately; inspect checks, fix and queue repair. No automatic CI rerun." ;;
  *) bus_event ci_timeout "$sha" "CI status unknown for pushed $sha: monitor timed out or metadata query failed; inspect checks and restart monitoring; completion not confirmed." ;;
esac
exit "$result"
