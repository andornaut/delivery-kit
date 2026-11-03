# delivery-kit

Local scheduled Git delivery with one isolated gate per integrated tree, exact-commit CI monitoring and deployment of the already-gated artifacts. The tool owns mechanisms; each client owns its repository, configuration, queues, locks, state, credentials and schedule.

## Structure

- `bin/delivery-kit`: explicit configuration/state entry point.
- `examples/`: project configuration and a thin pinned-snapshot runner adapter.
- `libexec/`: the Bash scheduler, batch preparation, gate, deployment, event outbox and optional Codex triage adapter.
- `scripts/check.sh`: isolated offline verification with fake Git, Docker, deployment, GitHub and native-protocol responses.
- `scripts/package.sh`: deterministic release archive and source identity from a pinned commit.
- `scripts/export.sh`: exports one committed source revision to a new local snapshot directory.
- `tests/`: mechanism and adapter contract tests. Consumers test only their own configuration and integration.

Releases are versioned source archives with no installation daemon or registry dependency. The tool uses the existing Bash scheduling mechanism and creates no additional timer.

## Explicit project contract

```bash
/path/to/snapshot/bin/delivery-kit \
  --config /absolute/path/to/project/bus.conf \
  --state-dir /absolute/path/to/project/bus-state \
  --revision EXACT_COMMIT_SHA run
```

`--help` and `help` print usage without configuration or state.

Both paths must be absolute and the state directory must already exist. Configuration is trusted Bash, not untrusted input. `REPO`, branch/remote, GitHub slug, departure minutes, container image, resource limits, installation and ordered gate commands are explicit project values. `examples/project.conf` lists the required fields. `check-config` loads and validates configuration without Git/network/container/native activity. `resource-report` prints reporting-only resource information. `scheduled-once` preserves the existing due-slot window and duplicate-slot receipts; it is not a manual departure command.

The gate mounts the scratch project checkout writable and the project state directory's `npm-cache` writable. Dependencies are installed with the configured command; all gate steps then run without network. The configured CPU and worker caps cannot exceed four. The gate compares Git-status file fingerprints before and after checking and stamps the exact build commit. Configuration and cache remain project-owned. Never place secret values in configuration: use the operator's existing authentication and credential references.

`DEPLOY_MODE` must explicitly be `wrangler` or `none`. The Wrangler adapter invokes the project's existing Wrangler executable/configuration against retained gated `dist/`, with the exact source SHA as its label. A failed deployment keeps its pointer and artifacts for a later configured departure. The CI monitor requires the configured names for the exact pushed commit. Red CI blocks later pushes unless the existing narrowly scoped one-shot repair approval protocol is satisfied.

## State and optional coordinator adapters

`--state-dir` preserves the existing filenames: `bus-queue`, queue/merge/runner/loop locks, `active-departure`, scratch batches, gate logs, CI/deployment state, event outbox and retained retry artifacts. Moving mechanisms does not move or rewrite any of these files.

`REPORT_PROJECT` and `REPORT_THREAD` select the existing Codex event sink. `CODEX_CONTROL_SOCKET` supplies the absolute nonsecret local Codex control socket
path. Missing, relative, unavailable or non-socket paths defer optional triage
without native delivery or blocking departures; there is no home-directory default.
`SESSION_MAP_FILE` explicitly selects project role metadata; `SHARED_TARGETS_FILE` optionally selects host-scoped shared-library targets. `CODEX_SHARED_ROLES` supplies space-separated allowed shared role names. Set
`CODEX_SHARED_ROLES="art-kit delivery-kit game-kit"` for the game host; an empty
list selects no shared roles. Leaving the variable unset defers optional triage
until the caller explicitly chooses its allowed roles. Nonhosts may leave `SHARED_TARGETS_FILE` empty.
The optional `codex_adapter.py` resolver preserves coordinator matching, distinct role identities, active ownership, host path matching and deduplication. Missing or invalid metadata defers triage. The guarded Codex adapter requires recipient-bound local decision clearance and
native question history to permit input; interrupted, ambiguous or unknown states
defer. Queue inventory and explicit acknowledgements operate independently of
reminder delivery. No live native connection is made by verification.

The optional Codex triage adapter retains the three-role game metadata schema and its coordinator reminder wording. That schema is an adapter contract, not a repository identifier. Other applications may omit reporting/triage rather than supplying fake identities.

### Operational reporting recipient and configuration adoption

`REPORT_THREAD` selects the queued bus-event recipient. Changing it alone grants
no operational authority or recipient decision clearance. After an explicitly
confirmed transfer, the existing monitor owns game-bus operations: queue admission
and mutation after Tech approval, gate/push/deploy tracking, retries, reporting and
resource oversight. Tech owns implementation, integration and approval of exact
pins. The library owns delivery-kit source and releases; existing project runners
execute approved work. This division creates no new timer, manual departure or
team.

Source Tech retains runtime ownership until controlled idle adoption, drained and
reconciled detached reporters, and final activation are confirmed. Receiving a
report or changing a route is not activation. Preserve outstanding work and its
owner throughout the transfer.

`MONITOR_ROUTE_FILE` selects guarded monitoring targets separately;
`MONITOR_MINUTES` sets their cadence. In legacy mode (route variable unset),
`REPORT_THREAD` also selects the triage coordinator, so changing it is not an
independent reporting transfer until routed monitoring is adopted.

Configuration is sourced by each shell entry point through `bus-common.sh`.
The resident runner, departure loop and observer retain their loaded values.
Fresh batch, deployment/retry, resource-report and detached CI-watch shells source
the configuration again when started. A CI watcher already running retains its
values through completion. Detached `event.py` flushers inherit `REPORT_THREAD`
from their spawning process and never reload configuration. Editing the file or
running `check-config` does not reload resident processes; there is no supported
reload command or signal. The observer does reread route JSON at its loaded
`MONITOR_ROUTE_FILE` path on each due monitor slot; that does not reload config.

For an approved reporting transfer, the runtime owner uses the idle cutover below:

1. Confirm the new recipient's identity and acceptance, preserve Tech exact-pin
   approval, and inventory the owned runner/loop, notifier, detached CI watchers,
   event flushers, pending CI/deployment work and unsent outbox entries.
2. Wait for an idle departure boundary and reconcile detached reporting still in
   flight. Preserve exact-SHA retry artifacts and event receipts. Stop only the
   verified owned idle runner/loop and descendants before changing configuration.
3. Set the confirmed `REPORT_THREAD`, validate configuration, then start exactly
   one pinned adapter using the existing launch mechanism and unchanged state,
   locks, queue and release schedule. Do not use `scheduled-once` to test adoption.
4. Verify the single runner/loop and observe subsequent scheduled, CI and
   deployment reports at the confirmed recipient. Record old in-flight reports
   separately; queued delivery acceptance is not proof of recipient handling.
5. Confirm drained/reconciled reporters and explicit final activation before
   transferring runtime operations from source Tech to the existing monitor.

The outbox stores event identity and sent state, not a recipient binding. A new
flusher sends unsent entries to its inherited recipient; sent entries are not
replayed. An old detached flusher can still deliver to the former recipient.
There is no atomic recipient transfer, automatic drain/retarget operation or
resident reload acknowledgement. If detached reporters cannot be reconciled,
transfer completion remains blocked. A later deployment retry reads the new
configuration while using the retained exact-SHA artifacts; retain the source
snapshot until its processes and retry dependencies are released.

## Snapshot and cutover

Prepare a new immutable local snapshot from a reviewed commit:

```bash
bash scripts/export.sh EXACT_COMMIT_SHA /new/absolute/snapshot/directory
```

The export refuses an existing destination and writes `SOURCE_COMMIT`. The project runner adapter pins both the absolute snapshot location and expected revision. Do not point running adapters at a mutable development branch. Preserve the snapshot while its runner, detached CI monitor or retained deployment artifacts need it.

For each game, its tech owner must perform the runtime cutover:

1. Confirm an idle departure boundary and record the current runner/loop identities, locks, queue, active marker, configuration and pending artifact pointers.
2. Export the reviewed tool revision and preserve the original game scripts and launcher outside the active adapter path.
3. Add explicit `SESSION_MAP_FILE` and `SHARED_TARGETS_FILE` to that game's local configuration. Keep the existing repository, gate, auth, reporting, resource limits and schedule values exactly. Archie remains hourly `00`; Chibi remains hourly `10`, both `America/Toronto`.
4. Replace only the game's runner launcher with a pinned adapter based on `examples/project-runner.sh`. Keep its existing state directory and every queue/lock/artifact file in place. Do not start a second scheduler or run a missed slot manually.
5. Stop only the verified owned idle runner/loop and its lock-holding descendants, then start one adapter through the existing background launch mechanism. Verify one runner/loop, locks, unchanged queue/state and the next normal scheduled slot. Observe actual departure/failure and CI/deployment reports before declaring operational completion.

Rollback uses the same idle-boundary procedure: stop the verified owned new runner/loop, restore the preserved launcher/scripts/configuration and start one original runner. Do not restore old queue/state copies or replay a consumed slot. Pending gated artifacts and their exact SHA remain authoritative. Never delete a snapshot used by an active detached monitor.

This source extraction does not perform cutover. A project owner must explicitly approve its reviewed pin and coordinate its runtime transition.

## Verification

```bash
bash scripts/check.sh
```

Verification requires Docker and a locally available `node:24.21.0` image. It starts only below one-minute load 24, uses at most four CPUs, mounts source read-only, copies it to container scratch, disables network and exposes no host socket or credential stores. Tests use fake commands and protocol fixtures only. No project gate, push, deployment, live queue operation or coordinator input runs.

## Versions, licensing and releases

`VERSION` identifies the cohesive CLI, configuration contract and helper source release.
The first public release is `0.0.1`. Compatible fixes increment the patch version;
additive public features increment the minor version. Before `1.0.0`, incompatible
CLI, configuration or state contract changes increment the minor version and require
explicit compatibility notes. From `1.0.0`, incompatible changes increment the major
version. Never publish an incompatible patch. Consumers adopt an explicit reviewed
version and commit independently of library publication and their delivery schedules.

Helper code is MIT-licensed under `LICENSE`. This licence does not cover consumer
art assets or game values.

The release owner reviews and pushes the release commit to `main`, then verifies
that every required CI workflow has completed successfully for that exact commit.
Only then create and push the immutable `vVERSION` tag at that same commit. Never
move a published tag. Generate release files from the pinned commit:

```bash
bash scripts/package.sh EXACT_COMMIT_SHA /new/absolute/release/directory
```

The directory contains `delivery-kit-VERSION.tar.gz`, `SOURCE_COMMIT` and
`SHA256SUMS`. The archive has one `delivery-kit-VERSION/` root containing the CLI,
mechanisms, examples, verification scripts, tests, README, version, licence and
`SOURCE_COMMIT`. Git metadata and local state are excluded. Archive bytes derive
only from committed contents, permissions and commit time, with sorted entries,
fixed ownership and no gzip timestamp. Dirty worktree files are excluded.

Publish those three files together on the versioned GitHub release. Release notes
state the version, exact source commit, compatibility changes and completed checks.
Verify downloaded checksums and source identity before adopting a snapshot. Release
publication never starts or modifies consumer runners, queues, timers or deployments.

## User-authorized one-off requests (0.1.0)

After explicit operator authorization, capture the current nonempty queue:

```bash
/path/to/snapshot/bin/delivery-kit \
  --config /absolute/path/to/project/bus.conf \
  --state-dir /absolute/path/to/project/bus-state \
  --revision EXACT_COMMIT_SHA request-once --request-id SAFE_ID
```

IDs are 1-64 ASCII letters, digits, underscores or hyphens, beginning with a
letter or digit. Repeating an ID returns its existing JSON receipt without
capturing new work or executing again. The queue lock protects the deduplicated,
ordered branch names and exact commit tips captured in `requests/ID.json`.
An empty queue is refused. This command records a request only; it never calls
the departure flow or starts a runner.

The existing resident loop checks requests at most five seconds apart when idle.
It retains `loop.lock` and serializes scheduled and requested departures through
`active-departure`, using the same gate, CI checks, push and deployment mechanism.
A due scheduled slot takes priority. A request does not shift hourly deadlines;
slots missed during active work are not replayed. A scheduled departure may
consume the captured queue first, in which case the request is rejected.

Queue names and tips are validated at both queue reads, including after deployment
retry and load checks. Final validation and queue consumption hold the same queue
lock; integration uses captured commit IDs even if a branch later advances.
A changed queue or tip is terminal `rejected` and leaves the queue unchanged.
Receipts transition from `pending` to `started`, then `finished` with
`departure_exit`, or `rejected`. On resident-loop recovery, `started` becomes
`interrupted`. A started request ID is never executed again, including after failure or interruption.
Queue work retained by existing preflight failures remains eligible at the next
normal scheduled slot; this API does not suspend or retry that queue.
After reviewing retained state and explicitly requeueing appropriate work,
use a new ID for a retry. Receipts remain in place for audit and deduplication.

One-off event IDs use `request-ID`, with a separate wall-clock timestamp. They do
not emit a scheduled tick or hourly coordinator input. `finished` means the
departure function returned, not that asynchronous CI or deployment succeeded.
Consult exact-commit CI status, deployment pointers and normal event reports.
Publication or recording a request does not adopt a new snapshot: the consumer
owner performs the normal idle cutover to the 0.1.0 resident loop first.


## 0.2.0 compatibility

This pre-1.0 minor release removes the `workers-builds` deployment adapter and its
implicit default. Every configuration must explicitly set `DEPLOY_MODE=wrangler`
or `DEPLOY_MODE=none`; missing, empty and removed values fail configuration
validation before runtime activity. Both game consumers already explicitly use
`wrangler`, so their deployment-mode configuration needs no change. Their tech
owners must explicitly declare both `CODEX_CONTROL_SOCKET` and
`CODEX_SHARED_ROLES` for every triage-enabled consumer before optional Codex
triage resumes. Nonhosts set `CODEX_SHARED_ROLES=''` and
`SHARED_TARGETS_FILE=''`, preserving art/gameplay peers without shared-library
targets. `none` continues to disable
deployment. Exact-commit `SKIP_GATE` behaviour, one-off requests, state files,
locks and reporting are preserved.

CI monitoring checks the exact pushed commit and requires configured check names
and completion of every registered check, including unrelated workflows. It no
longer waits for a special Workers Builds check. Internal monitor callers now
pass only the source SHA; deployment scope remains a separate batch decision.

Batch history-resolution failures report the skipped branch, `merge-base`
operation, exit status and Git diagnostic. Valid branches in the same batch
continue through integration and the existing gate. Inspect and requeue skipped
work after fixing its reference or history.


## 0.3.0 monitoring and recipient clearance

This pre-1.0 minor release changes the optional monitor clearance contract.
`STATE` below means the configured `--state-dir`. Each recipient's owner maintains
`STATE/unblock/decisions/THREAD_UUID.json`:

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "state": "clear",
  "resolutions": [
    {
      "question_turn_id": "question-turn-id",
      "question_item_id": "question-item-id",
      "answer_turn_id": "answer-turn-id",
      "answer_item_id": "answer-item-id"
    }
  ]
}
```

Use `pending` while that recipient awaits a user decision. Omit `resolutions` or
use an empty list when no historical question needs an explicit answer attestation.
Missing, malformed, mismatched or unknown records defer reminder delivery.
The legacy `pending-user-decision.json` is neither read nor modified. One
recipient's pending state cannot block or clear another. Peer clearance is not
consulted merely to inventory that peer's queue.

A resolution is the owner's explicit attestation of an actual answer, never a
classification inferred from text. For the current turn, the monitor verifies the
exact question item and an exact native `userMessage` answer item on the same
recipient, using complete paginated history. Within one turn, the answer must
follow the question in native ascending order. Older unrelated resolutions remain
syntax-checked without fetching their old turns. Only the exact resolved question
is exempted; another question, pending native active flags, incomplete history or
unknown native item shapes still defer delivery. Native agent messages may omit
`questions`, whose schema default is null. Nonempty questions require attestation;
clear local state alone does not resolve them.

The configured scheduled monitoring cadence captures complete queue entries from every page before
checking recipient questions or deciding whether to send a reminder. Each immutable
`STATE/unblock/snapshots/SNAPSHOT_UUID.json` contains `queues`, keyed by exact
recipient UUID, preserving each original `id`, `clientUserMessageId` and `input`.
Files are local and readable; private payloads are never included in events or
stdout. Snapshot files use owner-only permissions. An incomplete queue read is
reported in `errors`, not treated as an empty queue.

Obtain a snapshot independently of question clearance:

```bash
/path/to/snapshot/bin/delivery-kit \
  --config /absolute/path/to/project/bus.conf \
  --state-dir /absolute/path/to/project/bus-state \
  --revision EXACT_COMMIT_SHA monitor-snapshot --recipient THREAD_UUID
```

Stdout identifies the snapshot path, ID, queue IDs and safe history metadata.
`history[THREAD_UUID]` contains `status`, `complete`, `cursor`, `nextCursor`,
`question_refs` (`turn_id`, `item_id`, `kind`: `rendered_prompt` or `question_tool`)
and `user_reply_refs` (`turn_id`, `item_id`). Native conversation bodies are not
stored. This is one bounded recent metadata page across that recipient's turns;
`partial` or `unavailable` is explicit. To inspect an older reference page, repeat
`monitor-snapshot --recipient THREAD_UUID --history-cursor NEXT_CURSOR`. Each
invocation also captures the full queue again. IDs expose references only; they do
not establish that a reply answers a question.

After actual reconciliation, the owner explicitly acknowledges exact queued IDs:

```bash
/path/to/snapshot/bin/delivery-kit \
  --config /absolute/path/to/project/bus.conf \
  --state-dir /absolute/path/to/project/bus-state \
  --revision EXACT_COMMIT_SHA monitor-ack --recipient THREAD_UUID \
  --snapshot SNAPSHOT_UUID --queue-id QUEUED_ID --disposition handled
```

Repeat `--queue-id` for additional IDs; `superseded` also authorizes deletion.
No automated semantic classification or arbitrary delivery JSON is accepted as
proof. Independent work remains preserved unless explicitly retained without
deletion or later acknowledged as handled/superseded; there is no blanket
exclusion. An accepted reminder is not an acknowledgement. Explicit acknowledgement remains available during pending user
questions and never steers/starts a turn or resolves/cancels a prompt.

Before deleting, acknowledgement validates the recipient, snapshot and ID, then
re-lists and compares the exact `input` and `clientUserMessageId` under the same ID.
Changed payloads are preserved. There is no native compare-and-swap API: the
comparison and deletion are sequential, not atomic. Concurrent queue editing is
unsupported during acknowledgement. Only the explicitly acknowledged ID is deleted.

Durable per-ID operations in `STATE/unblock/acks/` record disposition, attempts and
outcome history before mutation. `deleted: true` records deletion; `false` requires
an absence-confirming re-list or records `not_deleted`. Missing responses are
`ambiguous`, with one read-only absence check and no automatic mutation retry.
A fresh explicit invocation may retry after a fresh exact comparison, at most one
delete per ID per invocation, preserving prior attempts. Already absent IDs are
`confirmed_absent`, without claiming delivery or semantic handling beyond the
owner's explicit acknowledgement.

Monitor health is separate from reminder acceptance. An unacknowledged queue ID with the same payload
and client message ID observed in two distinct slots, or repeated deferral, produces
`monitor_status: failed`, an actionable reason and nonzero CLI status. Same-slot
retries do not increment counters. Unchanged inventory already accepted as a
reminder is not sent again. Health records in `STATE/unblock/health/` retain the
latest snapshot and counters. The existing event outbox emits one actionable
failure per unresolved episode. New arrivals or changes to other items do not
restart the episode while any failure persists; a new episode requires full
resolution of the previous failure. Owners inspect the full local snapshot,
classify/reconcile work and explicitly acknowledge handled IDs. No additional
runner, schedule, timer or automatic queue deletion is introduced.


To preserve planned independent work without treating it as a stuck backlog:

```bash
/path/to/snapshot/bin/delivery-kit \
  --config /absolute/path/to/project/bus.conf \
  --state-dir /absolute/path/to/project/bus-state \
  --revision EXACT_COMMIT_SHA monitor-ack --recipient THREAD_UUID \
  --snapshot SNAPSHOT_UUID --queue-id QUEUED_ID --disposition retained \
  --reason "Independent work awaiting its owner"
```

`retained` requires a nonempty reason, exact snapshot/recipient/ID binding,
and a fresh unchanged-payload comparison. It performs no native deletion or turn
mutation. Durable local `STATE/unblock/retentions/` receipts preserve the reason,
identity, payload binding and history. Full snapshots still retain every original
entry. Only entries matching an active retention's exact input and client message
ID are excluded from backlog health and repeated-reminder inventory. Changed
payloads invalidate that match; unrelated unacknowledged entries still count.
No automatic expiry or keyword classification applies.

For later handling, capture a fresh snapshot and explicitly acknowledge `handled`
or `superseded`. A per-snapshot acknowledgement's disposition is immutable, so use
the new snapshot ID. The new deletion attempt invalidates the older retention
before processing, including if deletion subsequently fails, while retaining its
history. Native queue editing must remain quiescent during either kind of
acknowledgement. This consistency requirement does not imply an atomic API.


### 0.3.1 backlog persistence

Backlog age is tracked separately for each recipient and queue ID, bound to its
payload and client message ID. New arrivals cannot reset an older pending item's
age. A changed payload or explicit matching retention resets only that item;
confirmed removal drops its age. If a recipient's inventory fails, its prior ages
are preserved without increment until a successful observation. Same-slot retries
do not increment an unchanged item's age. `backlog_slots` reports the maximum
current item age. Older health records without per-item history begin with the
first actual observation; aggregate counters do not manufacture item history.


### 0.3.2 native Python interpreter

`CODEX_PYTHON` selects the absolute executable Python interpreter for public
`monitor-snapshot`/`monitor-ack` and scheduled Codex resolver/reminder entry points.
Its default is `/usr/bin/python3`; examples declare that value explicitly. There
is no PATH fallback. The selected interpreter must provide `websocket-client`.
Capability errors identify the actual interpreter and missing dependency without
exposing transport error bodies or queued payloads.

Interpreter validation occurs only at a native boundary. An unset value uses the
default; an explicitly empty, relative, missing or non-executable value is refused.
Public monitor commands report failure. Optional scheduled triage reports an
actionable deferral while the scheduler continues. Pure-Python request and CI
scripts retain their existing interpreter selection. Library verification uses
isolated fake transports and does not probe a live native service or install a
dependency.


## 0.4.0 monitor cadence and routing

`MONITOR_ROUTE_FILE` selects an absolute shared coordinator-managed JSON route.
It is an ordinary user-owned file, normally mode `0600`, managed by the owning
coordinator using confirmed identities. The library reads it without inferring
ownership or modifying any registry. A held route may explicitly have no owner:

```json
{
  "version": 1,
  "harness": "codex",
  "host_project_root": "/absolute/path/to/host-project",
  "state": "held",
  "monitor_thread_id": null,
  "targets": []
}
```

An active route requires a canonical monitor UUID distinct from every target UUID
and a nonempty list of active target UUIDs. The configured project root must be
absolute; no current-working-directory host match is inferred. Each target has `thread_id` and `ownership` (`active` or `held`).
Repeated identical targets are deduplicated; conflicting ownership, malformed
identities or unsupported schema defer monitoring. Held targets receive no native
input. Only the project whose canonical `REPO` matches `host_project_root`
dispatches. Nonhosts and held routes intentionally skip native monitoring. The
monitor UUID becomes the guarded coordinator; active target UUIDs are its peers.
Host state remains in `STATE/unblock/`, including recipient-specific decisions.
A route does not grant permission to clear any recipient's pending question.

When the route variable is declared, all release-driven native triage is
suppressed, including direct calls from departures and scheduled reports.
`REPORT_THREAD` remains the release-event recipient. `DEPARTURES`, release gates,
queues, state and reporting remain unchanged. Leaving `MONITOR_ROUTE_FILE` unset
retains the 0.3 release-driven compatibility behaviour. An explicitly empty or
invalid route does not fall back to legacy triage.

`MONITOR_MINUTES='20 50'` selects wall-clock monitoring minutes in `BUS_TIMEZONE`.
These are also the default when a route is declared and minutes are unset. An
explicitly empty value or anything other than literal minute values `0` through
`59` defers monitoring. This cadence is independent of release minutes. The
existing runner's 60-second observer checks monitor slots even during an active
release gate and when scheduled release-tick reporting is disabled. There is no
additional runner, timer or loop.

Observer startup records the current time and does not immediately dispatch or
replay prior slots. Later observations dispatch only a configured minute within
its current 60-second window; older missed slots are skipped. Epoch slot IDs
retain helper deduplication and distinguish repeated wall-clock minutes during a
DST fold. The existing native interpreter, socket, snapshot, acknowledgement and
question guards remain mandatory. Routed monitoring uses the route rather than
legacy game-role metadata and `CODEX_SHARED_ROLES`.

Snapshot `history` diagnostics include safe `reason_code` and `category` values.
Malformed pages, rows and items, unsupported item types, transport failures,
native RPC failures, JSON parse failures and incomplete pages are distinguished
without raw exception text or native bodies. Valid pagination remains
`partial` with `nextCursor`; safe references read before a malformed row remain
available but are not a completeness claim. These diagnostics require no extra
native requests. Queue capture and explicit acknowledgement remain available even
when history metadata is unavailable.


### 0.4.1 history degradation

Recognized native `contextCompaction` items preserve safe references and cursor
metadata while reporting history `status: partial`, `complete: false`, and both
`reason_code: context_compaction` and `category: context_compaction`. This is an
incomplete history diagnostic, not recipient decision clearance. Compaction in
the latest turn remains guarded: a structural marker cannot prove that opaque
questions are absent. Older compaction in across-thread history does not invalidate
a separately complete latest turn. Unknown item types remain unsupported.
Ordinary paginated history may be `partial` without being degraded.

Health adds `history_status: degraded|ok`. History degradation produces
`monitor_status: degraded` unless an actual failure requires `failed`, which
always takes precedence. History-only degradation does not increment
`deferral_slots`; an actual guarded delivery outcome of `deferred` or `blocked`
still does. Queue backlog and inventory failure rules remain applicable.
`history_status: ok` describes history metadata only: it does not establish
recipient clearance, successful delivery or overall monitor health. Inspect the
history diagnostics, delivery outcome, backlog and deferral counters separately.

The `monitor-snapshot` CLI exit status reflects queue capture errors only.
Incomplete or unavailable history diagnostics remain independently usable; a zero
exit status does not establish complete history, decision clearance or successful
guarded delivery.
