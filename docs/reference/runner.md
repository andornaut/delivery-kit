# Resident runner

Launch one resident per app from the app's canonical checkout, using its installed Delivery Kit.
In app mode, launch from the active bus owner's environment with the
[required grants](commands.md#app-mode-authorization).

```bash
cd /absolute/path/to/app \
  && DELIVERY_KIT_ROOT=/absolute/path/to/workspace setsid node node_modules/@andornaut/delivery-kit/dist/cli.js run --app APP_ID
```

The runner holds `runner.lock` and `loop.lock` (a second runner is refused), records its identity,
and runs the scheduled and requested departure loop, the per-minute observer (scheduled reviews,
scheduled-slot reports and event ingests), the 1800 s resource sampler and the CI watches
in-process. The schedule needs no external timer or cron entry. A missed scheduled slot is
never replayed. See [Supervision](#supervision) for the optional systemd user service.

The observer wakes at the start of each minute after its previous clock reading, so a pass that
runs past a minute boundary still reviews that minute's slot. A slot whose whole minute passes
during one pass is skipped, not replayed.

For each due slot the observer calls the coordinator-installed `coordination-kit review deliver`,
logs the line for its result, reports scheduled slots when `scheduledTicks` is set, then requests
an event ingest ([Coordinator CLI seam](#coordinator-cli-seam)). coordination-kit composes and
delivers the review and owns the per-slot receipt: a repeated call for a slot returns the recorded
outcome without another send. The runner keeps no slot receipt. A typed
`compaction-reserved` deferral retains the exact observed slot in memory for retry in a
later pass. Each pass handles a newly due slot first and retries at most one retained slot.
The runner never replays a missed slot.

A departure slot's `scheduled-status` report comes from whichever of the observer and that slot's
departure appends it first. The observer compares the start epoch in `active-departure` with the
slot start. A departure that started at or after the slot is reported as checking `main`, with
any attempt reported separately. An earlier start or an unreadable epoch is reported as a
departure still checking or finishing.

The recipient's instruction contract for every caller-configured scheduled review pass is:

- Inventory registered parent queues, verified workers' queues and ready worker handoffs across
  all registered apps, kits and shared roles. Classify every original backlog item, including
  independent work. This is a recipient obligation, not an automatic backlog drain or a guarantee
  that one snapshot contains every role's payloads.
- Report unavailable visibility explicitly, including unavailable Claude native target queues and
  worker visibility; never infer an empty backlog from unavailable data. Refused native historical
  worker-queue access remains unknown. Report capability limits and require owner reconciliation
  without bypassing refusals or forcing session loads.
- Acknowledge only exact unchanged originals with evidence of actual handling or supersession.
  Native or channel acceptance records transport only.
- Retain guarded items and unanswered decisions with their owner, reason and next review boundary.
  Never interrupt or clear an unanswered question, or treat silence as an answer.
- Use native live delivery only for confirmed unblockers; send ordinary independent work through
  the normal queue. Preserve recipient guards, exact-payload validation, inventory semantics and
  existing deduplication.
- Report disposition counts and remaining item IDs. An item still unhandled or repeatedly deferred
  across two distinct scheduled slots is a starvation failure: report its ID, blocker, required
  owner and next action.

This contract changes no cadence, routing or runtime capability.

To replace a runner: record its identity, stop it while idle, start one runner, verify exactly one
holder of each lock with `status` and `runner.json`, then observe the next normal slot. A
replacement resumes every CI watch whose `ci/<sha>.status` is still running, with its original
deadline. A `pending` status, or a last push with no CI status, starts a watch with a new deadline.

A second direct `run` while another runner holds `runner.lock` or `loop.lock` exits 3 and leaves
the holder's identity intact.

## Coordinator CLI seam

The runner spawns the coordinator root's
`node_modules/@andornaut/coordination-kit/dist/cli.js` with its own Node binary
(`process.execPath`). It resolves the coordinator root from `--root`, then `DELIVERY_KIT_ROOT`,
then the working directory. The child inherits the runner's environment and uses that root
both as `--root` and as its working directory.

| Call                                      | When                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `review deliver --app APP_ID --slot SLOT` | At a due `wakeMinutes` slot or to retry a retained compaction deferral |
| `events ingest --app APP_ID`              | Once per observer pass and after each appended event                   |
| `--version --json`                        | At startup, and before a call while the last seen CLI is out of range  |

The table shows app mode. With legacy `games` configuration the runner uses `--game ID` for
both calls, including when it was started with `--app`.

`SLOT` is the slot's minute start in ISO 8601 with the `config.json` timezone's offset, such as
`2026-11-18T16:30:00-05:00`, so the two daylight-saving fold slots at one wall minute differ. Each
review or ingest call prints one JSON line on stdout with `schema` 1, its `kind`, the echoed
app identifier (`appId` for the app call, `game` for the legacy call), `status` (`delivered`,
`deferred` or `skipped`), `reason`, free-text `detail` and `cli` `{version, distSha256}`. An ingest
result has kind `events-ingest`. Its status is `delivered` when it ingested lines, `skipped`
with `no-events` when nothing was new, and `deferred` with a reason otherwise. It may add counts, each a non-negative integer when present: `ingested`,
`quarantined`, `completed` (COMPLETE reports formed), `delivered` (lines committed) and `held` (1
while a torn tail is pending). The runner parses the JSON, not its key order, ignores fields it
does not define and never parses `detail`.

The reader requires the exact app ID and, for reviews, the exact echoed `slot`. It accepts
either identity field and rejects conflicting values if both are present.

A delivered result may carry a null `reason`. Recognised reason tokens are `route-unavailable`,
`recipient-unavailable`, `recipient-busy`, `question-pending`, `held`, `receipt-ambiguous`,
`already-delivered`, `nothing-due`, `no-events`, `cli-error` and `compaction-reserved`. An unknown token such as
`in-flight` is a deferral. The runner adds `cli-unavailable` and `cli-version` for its own
deferrals. Coordination Kit reuses any result recorded under `bus/unblock/review-deliver/` for
a repeated call. A busy slot lock or a store compaction reservation can defer without recording
a result. The runner never passes `--capture`. The version probe returns a separate JSON object
with `schema` 1, `version` and `distSha256`.

- **No delivery claimed:** a missing result, a nonzero exit (an internal failure exits 1 with no
  stdout and one `coordination-kit:` stderr line, which the runner logs), a line that is not one
  JSON object, a second stdout line, a wrong `schema`, `kind`, app ID or `slot`, a timeout and an
  abort claim nothing. The runner logs them and continues; none stops a departure, prevents runner
  start or ends the runner. The CLI checks for an abort before it writes a slot record, so killing
  it never leaves a partial record.
- **Timeout:** each spawn has a 45 s deadline. A pass can cross a minute boundary,
  especially when it also retries a reserved slot. On timeout or shutdown the runner kills the
  child's whole process group. The seam runs independently of departures and outside `departure.lock`.
- **Missing CLI:** while the file is missing, for example during `npm ci` at the root, reviews
  and ingests defer with reason `cli-unavailable`. The next call after the install finishes
  reaches the CLI again.
- **Range:** legacy mode accepts the workspace CLI range `>=3.0.0 <9.0.0`. App mode requires
  the app-compatible CLI starting at 7.8.0 within that range. An unsupported CLI defers
  with reason `cli-version`, and while the last seen CLI is out of range the runner asks only for
  its version until a supported install answers. Departures continue.
- **Identity:** the runner logs `bus: coordinator CLI VERSION (dist sha256 SHA256), inside RANGE`
  (or `is outside RANGE; reviews and event delivery defer`) at startup and whenever a result
  carries a different identity, since `npm ci` can replace the CLI under a live runner. It records
  the last identity and the time it saw it in `bus/seam.json`. `status --game ID` reports it,
  read-only, as `coordinator_cli`: `{version, distSha256, seenAt, supported}`, all null before the
  runner has seen a result. `runner.json` and `runner.identity.json` record the bundled
  coordination-kit, not this CLI.

Review lines in `runner.log`:

| Result                          | Line                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `delivered`                     | `bus: scheduled review WAKE: DETAIL`                                |
| `deferred`, or an unknown token | `bus: review deferred: REASON: DETAIL`, also written to stderr      |
| `skipped`                       | `bus: scheduled review WAKE: skipped REASON: DETAIL`                |
| no delivery claimed             | `bus: scheduled review WAKE unavailable (WHY); no delivery claimed` |

`WAKE` is the slot start in epoch seconds. An ingest logs `bus: event ingest deferred: REASON:
DETAIL` or `bus: event ingest failed: WHY; no delivery claimed` once until its outcome changes,
and nothing for a delivered or skipped ingest. At most one ingest runs at a time; a request during
one runs one more after it.

## Event log

The runner alone appends to its [resolved bus](state.md) at `bus/events.jsonl`.
The workspace CLI's `events ingest` reads it. The schema lives in `src/state/events.ts`.

- **Lines:** one JSON object per line, terminated by `\n`. The file is opened with `O_APPEND`;
  each line is a single `write()` under 4096 bytes, then `fsync`. A `detail` that does not fit is
  cut at a character boundary and ends in `[truncated]`.
- **Fields:** schema 1 app-mode lines use `appId` with an app-compatible CLI. Legacy
  workspace lines use `game`. Coordination Kit 7.8.0 accepts either field and rejects
  conflicting values. Other fields are `schema`, `id`, `kind`, `type`, `key`, `at`, `sha`,
  `status`, `detail` and `work`. The event ID is the sha256 hex of
  `${appId}\n${type}\n${key}`, using the same ID value for either spelling. `sha` is the key
  when it is a commit SHA or is set explicitly for `attempt-captured`. `at` is UTC to the
  second. `detail` carries the operator-facing text.
- **At most once:** per `(type, key)`, through an in-memory ID set rebuilt at startup from the
  unrotated log; coordination-kit's store keeps the older IDs unique. A failed append logs
  `bus: event TYPE KEY not appended to events.jsonl (...); operator review required` to
  `runner.log` and stderr and never stops a departure. Every appended event requests an ingest.
- **`runner.started`:** appended at each start once the startup probe settles, keyed by the
  runner token when available. Its `detail` is a JSON string with `token`, `deliveryKitVersion`
  and `cliSha256` for the running Delivery Kit. `coordinationKitVersion` and `distSha256` come
  from the coordinator CLI probe and are null when the probe found no identity.
- **`work`:** on a deploy event with status `ok` or `skipped`, the work IDs whose
  `docs/work/<id>.md` front matter is `status: done` at this SHA but not at the last complete SHA,
  from `git` in the game checkout; `[]` when none, null when either commit is unknown. A commit is
  complete once its push, CI and deploy events are `ok` (deploy `ok` or `skipped`); the runner
  keeps the last one in `bus/last-complete.sha`. Elsewhere `work` is null. A deploy event appended
  before an earlier commit completes can list items that commit also lists; ingest records each
  item once.
- **Capture evidence:** `attempt` identifies the candidate before load and source checks.
  `attempt-captured` retains its attempt key and records the full SHA after the gate verifies the
  immutable source snapshot, before executing a gate. A docs-only departure records the SHA
  selected for the pinned push after preflight, identified as docs-only in the event detail.
  Idle slots, stale requests and failures before capture have no capture event. Gate, push, CI
  and deploy outcomes retain their own evidence.
- **COMPLETE:** a coordination-kit projection with a unique `(app ID, complete, sha)` key, formed
  when the gate passes (`gate_passed`) or a docs-only range skips it (`gate_skipped`), push and CI
  succeed and the deploy status is `ok` or `skipped`. The runner appends no `complete` event.

| `type`                                               | `kind`    | `status`  |
| ---------------------------------------------------- | --------- | --------- |
| `attempt`, `attempt-captured`                        | `attempt` | null      |
| `blocked-main`, `blocked-fetch`, `blocked-load`      | `attempt` | `blocked` |
| `gate_passed`                                        | `gate`    | `ok`      |
| `gate_skipped`                                       | `gate`    | `skipped` |
| `blocked-gate`                                       | `gate`    | `blocked` |
| `blocked-full-gate`, `blocked-install`               | `gate`    | `failed`  |
| `push`                                               | `push`    | `ok`      |
| `blocked-push`                                       | `push`    | `blocked` |
| `ci_pending`                                         | `ci`      | null      |
| `ci_success`                                         | `ci`      | `ok`      |
| `ci_failure`                                         | `ci`      | `failed`  |
| `ci_auth_failed`                                     | `ci`      | `blocked` |
| `ci_timeout`                                         | `ci`      | `timeout` |
| `deploy_retry`                                       | `deploy`  | null      |
| `deploy_success`                                     | `deploy`  | `ok`      |
| `deploy_failure`                                     | `deploy`  | `failed`  |
| `deploy_skipped`, `deploy_disabled`                  | `deploy`  | `skipped` |
| `scheduled-status`, `pin-mismatch`, `runner.started` | `runner`  | null      |

`blocked-full-gate` and `blocked-install` are failed gates: the SHA is never gated again.
`blocked-gate` is a gate that could not run. `deploy_disabled` reports a push under
`deploy.mode` `none`. A null status is progress or a notice, not an outcome.

### Cursor and drain

`events ingest` writes `bus/events.cursor` atomically, and the runner and `status` only read it:
`{"schema":1,"file":"events.jsonl","offset":BYTES,"lines":N,"lastId":ID|null,"firstId":ID|null,
"inode":N,"dev":N,"at":ISO}`. `firstId` is the ID of the first complete line of the file the
cursor names, null when it has none; `inode` and `dev` identify that file. A cursor names a file
when `firstId` equals that file's first line ID or, when `firstId` is null, when the file has no
first line ID and its inode and device match. The offset counts only for the file the cursor
names; the runner and `status` parse every field strictly.

`status` reports a non-empty log as drained when the cursor names the live `events.jsonl` and
its `offset` equals the file's size, with no rotated log or torn line. An absent or empty log
can be drained without a cursor if there are no event blockers.
A cursor naming a rotated log adds `events_cursor_rotated`, and one naming no file present
`events_cursor_unmatched`. Ingest finds the file the cursor names, finishes it from `offset` and
reads newer files from 0, or every file from 0 when none matches; it never consumes a torn line
and moves a malformed complete line to `events.quarantine.jsonl`.

### Rotation

Before an append, when the cursor names the live file, its offset equals the file size and the
size exceeds 1 MiB, the runner renames the file to `events.<epochSeconds>.jsonl` and starts a new
one. It never deletes a
rotated file; ingest consumes and deletes it.

### Torn last line

A last line without its newline can only come from a runner that stopped mid-append. At startup,
holding `runner.lock`, the runner writes a newline after it. A fragment that is valid JSON is the
whole event without its newline and becomes a normal line, deduplicated with the rest. Any other
fragment becomes a malformed complete line that ingest quarantines. Leaving it unterminated would
merge the next append into it and lose that event to quarantine. After a failed append the runner
checks the tail the same way before its next append.

### Unmigrated 6.0 outbox

Startup refuses a game with a `bus/events` outbox before changing runner state. Use the
[6.1.2 migration bridge](../guides/upgrading.md#upgrading-to-80) to import and drain it. Previously
imported schema-1 records remain readable, and archived `events.imported-<epoch>/` directories
are left in place.

## Supervision

Supervision by a systemd user service is optional and adds no timer: the service starts the same
resident runner, whose schedule stays in-process. `runner unit` prints a unit for one app.
Use the app's canonical checkout and the Node binary and `PATH` the runner should use.

```bash
mkdir -p ~/.config/systemd/user \
  && cd /absolute/path/to/app \
  && DELIVERY_KIT_ROOT=/absolute/path/to/workspace node node_modules/@andornaut/delivery-kit/dist/cli.js runner unit --app APP_ID \
  > ~/.config/systemd/user/delivery-kit-APP_ID.service
```

The unit resolves every path when it is printed:

- `WorkingDirectory` is the app's canonical checkout. `ExecStart` uses the absolute Node binary
  running the command (`process.execPath`) and the app's installed
  `node_modules/@andornaut/delivery-kit/dist/cli.js` to run the selected app.
- `Environment` sets `DELIVERY_KIT_ROOT` to the resolved coordinator root and `PATH` to the
  directory of `process.execPath`, followed by the directories of `gh`, `docker`, `git`,
  `flock` and `claude` from the caller's `PATH`. A missing tool or installed CLI exits 1
  with no unit printed.
- `Restart=on-failure` with `RestartSec=30`. A sixth start within 600 s (`StartLimitIntervalSec`,
  `StartLimitBurst=5`) is refused and the unit stays failed until `systemctl --user reset-failed`,
  so a persistent failure does not loop.
- `SuccessExitStatus=143` makes a `SIGTERM` stop a clean exit. `RestartPreventExitStatus=3` never
  restarts a refused start, because another runner holds the locks.
- `KillMode=mixed` and `KillSignal=SIGTERM` signal only the runner, which ends its own children.
  `TimeoutStopSec=120` covers an idle shutdown; processes still running after it are killed.
- `[Install]` has `WantedBy=default.target`.

In app mode the operator provisions the service environment, for example in a unit drop-in,
with the actual registered native ID of the active bus owner. Set `CODEX_THREAD_ID` for Codex
or `CLAUDE_CODE_SESSION_ID` for Claude, using the selected harness binding. A role label or
`--requester` supplies no native identity. Requalify the service environment when the active
binding changes. Detached `runner start` inherits the caller environment. Git push and `gh`
authentication must also work in the resident's environment.

Enable and start the service after stopping any manually launched runner for the app.

```bash
systemctl --user daemon-reload \
  && systemctl --user enable --now delivery-kit-APP_ID.service
```

Starting at boot without a login session needs lingering, which the user enables with
`sudo loginctl enable-linger "$USER"`.

`runner stop` and `runner start` replace a runner with or without the unit:

- `runner stop --app APP_ID [--timeout SECONDS]` polls `status` (default timeout 900 s) until
  the runner is idle and drained: no active departure, deploy retry, CI watch or pending
  request, and the event log ingested. It then runs
  `systemctl --user stop delivery-kit-APP_ID` when
  `~/.config/systemd/user/delivery-kit-APP_ID.service` exists and `systemctl --user is-active`
  reports the unit active; otherwise it sends `SIGTERM` to the PID in `bus/runner.json`, but only while `runner.lock` holds the token `runner.identity.json`
  records for that PID, so a recycled PID is never signalled. It waits up to 150 s for both locks
  to be free and prints one JSON line `{schema, appId, pid, method, stopped, locksFree}`, `method`
  being `systemd`, `signal` or `none`. It exits 0 when the runner stopped with both locks free,
  or when no runner was running (`method` `none`, `pid` null). On a timeout, or when the PID does
  not hold the identity, it exits 1 and leaves the runner running and untouched.
- `runner start --app APP_ID` exits 1 and starts nothing while either lock is held or the
  legacy outbox check fails. With the unit file installed it runs
  `systemctl --user start delivery-kit-APP_ID`. Otherwise it spawns the running Node binary
  directly with the app's installed Delivery Kit CLI, detached in its own
  session from the app checkout with `DELIVERY_KIT_ROOT` set and stdout and stderr appended to
  `bus/runner.out`, creating its parent directory if needed. It waits up to 30 s for both locks,
  a current identity and a `runner.json` naming that PID, then prints `{schema, appId, pid, method, status}`, where
  `method` is `systemd` or `spawn` and `status` is `{running, idle, coordinator_cli}`. A runner
  that does not come up, or exits first, exits 1.

The legacy `--game` selector preserves the `game` field in these replies.

Neither command changes desired delivery control or any coordination-kit state. Both use the status
report and `runner.json` to attest the runner. Startup also checks the legacy outbox path.
When starts race, the singleton locks admit only one runner.

Upgrade or replace a supervised runner in a quiet window:

1. Install the new pin in the app checkout and run `npm ci`.
2. After a Node upgrade or a moved tool, run `runner unit` again, replace the unit file and run
   `systemctl --user daemon-reload`. A pin change alone keeps every path.
3. Run `runner stop --app APP_ID`, which waits until the runner is idle and drained.
4. Run `runner start --app APP_ID`.
5. Verify exactly one holder of each lock with `status` (`runner_lock_held`, `loop_lock_held`,
   `identity_status` `current`) and `runner.json`.
6. Confirm `observer_adoption` `current` once the new runner's `runner.started` is ingested (see
   [Observer adoption](#observer-adoption)), then observe the next normal slot.

## Observer adoption

Every runner start appends `runner.started`, keyed by the new identity token, once the startup
CLI probe settles ([Event log](#event-log)). That line is the runner's identity record: the
observer has adopted the running runner once the coordinator CLI has ingested it. There is no
separate adoption record, owner attestation or identity-change event.

`status --game ID` reports `observer_adoption`, read only from `bus/` (no coordinator store, work
protocol or registry read):

- The record is the latest complete `runner.started` line in `events.jsonl`, or in the newest
  rotated `events.<epoch>.jsonl` when `events.jsonl` has none. Its token is the `token` field of
  its detail.
- `current`: the record carries the running runner's token (`identity_status` `current`),
  `bus/seam.json`'s last seen coordinator CLI is inside `COORDINATOR_CLI_RANGE`, and
  `events.cursor` names the record's file (by `firstId`, or inode and device for a file without
  one) with an offset past the record's line.
- `stale`: the record carries a different token, for example a previous runner's while the new
  one's probe has not settled.
- `unknown`: anything else.

`observer_adoption_reason` is null only for `current`:

| Reason               | Status    | Cause                                                                      |
| -------------------- | --------- | -------------------------------------------------------------------------- |
| `runner_not_current` | `unknown` | No running runner with a current identity                                  |
| `log_unreadable`     | `unknown` | `events.jsonl`, the bus directory or the newest rotated log is unreadable  |
| `no_runner_started`  | `unknown` | No complete `runner.started` line where the record is read                 |
| `token_differs`      | `stale`   | The record's token is not the running runner's                             |
| `cli_unseen`         | `unknown` | `bus/seam.json` holds no coordinator CLI identity                          |
| `cli_out_of_range`   | `unknown` | The last seen coordinator CLI is outside `COORDINATOR_CLI_RANGE`           |
| `not_ingested`       | `unknown` | The cursor is absent, invalid, names another file or stops before the line |

Departures, reviews and ingest never depend on the field; it records nothing, changes nothing
and authorises no replacement.

## Pin guard

The bundles inline the coordination-kit utilities they use (layout, registry reads, locks,
durable writes, configuration validation and IDs) from `build/registry`, `build/review` and
`build/shared`, and nothing from `build/protocol`, so a game
pins only `@andornaut/delivery-kit` and the runner never loads a game copy of coordination-kit. The
build embeds the bundled coordination-kit version. delivery-kit declares the bundled
coordination-kit range in `COORDINATION_KIT_RANGE` in `src/compatibility.ts`. The app layout
and permissions require `>=7.8.0 <9.0.0` for the bundle. The independently
installed CLI has the runtime ranges in [Coordinator CLI seam](#coordinator-cli-seam).
The range holds plain `MAJOR.MINOR.PATCH` comparators (`<`, `<=`, `>`,
`>=`, `=`), and a prerelease or build-metadata version never satisfies it. The package check refuses a
build whose bundled version is outside the range, so a release can only ship a supported one.

`status` reports `coordination_kit` read-only: `bundled` (the inlined version) and `supported`
(the range). game-coordinator pins coordination-kit directly for the roles' CLI, the channel
MCP server and the seam the runner spawns, whose own range is `COORDINATOR_CLI_RANGE`
([Coordinator CLI seam](#coordinator-cli-seam)). Otherwise that install and each game's runner
exchange data only through on-disk formats: the registry, the event log and its cursor
([Event log](#event-log)).

At startup the runner writes `bus/runner.json` with `schema`, `pid`, `startedAt`,
`version`, `coordinationKitVersion` (the bundled coordination-kit), `cliPath` (realpath of the
loaded `dist/cli.js`), `cliSha256` and the lockfile `integrity` of
`node_modules/@andornaut/delivery-kit`; `runner.identity.json` records the same bundled version as
`coordination_kit_version`. Before each departure it compares the
loaded version, `cliSha256` and integrity with the game's installed package and `package-lock.json`.
On a mismatch, or a missing package, it logs, emits one `pin-mismatch` event deduplicated on the
loaded and installed values, and finishes on the loaded code until a controlled idle replacement.
Short commands load fresh code.

## Status provenance

`status --game ID` includes `provenance` in its existing JSON report:

```json
{
  "archive": { "reason": "no_independent_verification", "status": "unknown" },
  "comparison": { "cli_sha256": "unknown", "source_commit": "unknown", "version": "unknown" },
  "installed": { "cli_sha256": null, "source_commit": null, "version": null },
  "resident": { "cli_sha256": null, "source_commit": null, "version": null },
  "resident_status": "unknown"
}
```

- `installed` reads the selected game's `node_modules/@andornaut/delivery-kit`, independently of
  the package running the status command. Missing, unreadable or invalid evidence is null.
- `resident` uses the startup pin capture bound into `runner.identity.json`, including its
  `cli_sha256`. It is `attested` only with the current identity token, both singleton locks held
  and a valid startup digest. Otherwise its fields are null and `resident_status` is `unknown`.
  Older identities without that digest stay unknown; `runner.json` is not an attestation source.
- Each comparison is `match`, `different` or `unknown` when either value is unavailable.
  Version and source are metadata claims. The digest compares the startup CLI bytes with the
  current installed CLI; hashing today's installed file cannot reconstruct the startup digest.
- `archive.status` stays `unknown`: neither package metadata, lockfile integrity nor matching
  installed/resident digests independently verifies a published archive. No archive verifier or
  adoption-record attestation is consumed by this report.

A provenance match does not establish readiness or authorise replacement. Inspect the existing
configuration, control, lock, idle and reporter/drain fields separately. Status performs no repair,
registry update, runner replacement or scheduling action.

Reporter drain is separate from recipient inbox health. Use `status --game ID` to read
`events`, `reporter_blockers` and `drained`; an idle runner can still have uningested events.
delivery-kit has no reporter-event list, reconciliation or ingest command. The resident observer
requests coordination-kit's `events ingest`, which advances the cursor only past lines it has
stored. Recipient inbox acknowledgements and common-message reconciliation do not change the
cursor. Installing a newer CLI or adopting its generic inbox does not prove an older resident's
reporters drained.
A persisted review snapshot proves collection, not reminder delivery. Adapter availability and
local inbox health do not attest a resident reporter, native bridge or scheduled wake.

## Departures

Delivery is trunk-based. Tech merges each reviewed feature branch into the game's local `main`, as
a real merge or a fast-forward, and never pushes. There is no queue, batch merge,
cherry-pick, rewrite or revert. Each scheduled or requested departure, under `departure.lock`:

1. Restarts the CI watch of the pending deployment or the last push when it timed out or lost
   GitHub authentication, then retries a pending deployment whose CI has passed.
2. Reads the branch named by `git.main` in the canonical checkout and its remote counterpart
   with `git ls-remote`. A request verifies its captured SHA against the local ref before step 1
   and keeps that SHA through gate and push.
3. Skips when HEAD is the remote `main` or the last pushed SHA, or has a `gate-failed/<sha>`
   record. Nothing new means nothing departs.
4. Waits while the one-minute load is at or above `loadLimit`, re-checking it every 60 seconds
   with `departure.lock` and the runner locks held, so nothing else departs meanwhile. It
   continues once the load is below the limit. A load still at or above the limit 15 minutes after
   the scheduled slot (for a request, 15 minutes after it starts) skips the slot with
   `blocked-load` and `main` retained. A runner shutdown ends the wait without a report.
5. Stops with `blocked-push` when the remote `main` is known locally and is not an ancestor of
   HEAD. Nothing is gated or pushed; Tech merges the remote `main` into local `main`.
6. Gates HEAD on a detached scratch worktree, so merge commits are gated as they are, and
   appends `gate_passed` for HEAD once the gate passes. A docs-only range skips this step.
7. Pushes with `git push <remote> <sha>:refs/heads/<main>`, never forced. A non-fast-forward
   rejection is reported as `blocked-push` and nothing is pushed.
8. Stages the deployment, then watches CI for that exact SHA. A docs-only range never deploys.

The runner never fetches, checks out or moves a ref in the canonical checkout. Its only write there
is the push of an exact SHA (and the scratch worktree's Git metadata).

- **Fix forward:** a red gate (install or a gate step exiting non-zero inside the running
  container) leaves `main` unpushed and records `gate-failed/<sha>`, so that SHA is never gated
  again. Red CI also requires a new commit. A failed deployment with passing CI retains its
  pending assets for retry.
- **Docs-only range:** when every path changed from the remote `main` to HEAD starts with `docs/`
  (both sides of a rename count) and no deployment is pending, the departure starts no gate
  container. It pushes the exact SHA as in step 7, records `last-deploy-skipped.sha`, reports
  `deploy_skipped` and watches CI as usual; that range is never deployed. The `push` and
  `complete` reports say the gate was skipped. An unknown range (no remote `main`, or a remote
  commit missing locally), an empty diff or a pending deployment of an earlier push departs with
  the full gate, so the gated push supersedes the pending deployment. The prefix is fixed, not
  configured.
- **Gate infrastructure:** when Docker is unavailable, the image cannot be pulled, the container
  cannot be created or started, install fails with an npm network code (`E5xx`, `ETIMEDOUT`,
  `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `ESOCKETTIMEDOUT`), a passing install
  skipped an optional package that `package-lock.json` lists for the container's platform (see
  [Gate container](#gate-container)), the network cannot be
  detached, more than loopback remains, copying the deployment outputs fails or the worktree
  fingerprint changes, the departure reports `blocked-gate` with the cause. It writes no
  `gate-failed` record and retries the same SHA at the next departure.
- **CI:** polls the check runs of the exact pushed commit through the existing `gh` login, or the
  public GitHub API (User-Agent `delivery-kit`) when `gh` is not installed. Only the runs named in
  `requiredNames` decide the result, from the latest run of each name: the watch fails once a
  required run completes with a conclusion other than `success`, `neutral` or `skipped`, and
  passes once every required run has completed and passed. Runs of other names, such as a
  third-party integration's check, are recorded in `ci/<sha>.json` and the log but never fail or
  hold the watch. `requiredNames` must not be empty. A workflow that skips jobs by changed paths
  lists its path-classification job in `requiredNames`, and its skippable jobs run unless that
  job explicitly reports a docs-only change, because a skipped required run counts as passing.
  delivery-kit's own workflow uses `!cancelled() && needs.changes.outputs.code != 'false'`.
  `ci/<sha>.json` marks each run `required`. A failure names the failed required runs, and a timeout names the required checks with no run and
  those still incomplete. A watch that reaches `timeoutSeconds` reports the status as unknown
  (`ci_timeout`), and a refused GitHub
  authentication stops the watch with `ci_auth_failed`. The next departure restarts either watch,
  so a pending deployment still runs once CI passes.
- **Deployment:** with `mode` `wrangler` and a range that needs it, the push records
  `deploy-pending` with its worktree, superseding an older pending deployment. When CI passes and
  the remote `main` is still that SHA, it runs `node_modules/wrangler/bin/wrangler.js deploy
--config wrangler.jsonc --no-bundle` in the gate worktree with the gated `dist/`, so the
  deployment uses the runner's Node binary to invoke the Wrangler locked in the gated commit.
  A worktree without that entry is not deployed: the runner logs the missing path and keeps the
  deployment pending. The CI completion and scheduled retry paths serialize access to the pending
  deployment. A failure, including an unavailable remote ref lookup, keeps the assets for a later
  retry. A deployment that cannot be staged after its push is reported as `deploy_failure` with the
  cause, so a pushed SHA never goes undeployed silently.
- **`request`:** an operator-authorized one-off departure of the current `main` HEAD with the same
  rules and receipts, including the 15-minute load wait, which starts when the request departs. A
  HEAD that is the last pushed SHA or failed its gate is refused. At departure, the runner compares
  the captured SHA with the local ref and uses that exact SHA for gate and push. A changed ref
  rejects the request. An unavailable ref is a main-read failure.

## Gate container

One container per gated SHA, named `delivery-kit-gate-<game>-<short sha>` and labelled
`delivery-kit-gate=<game>`:

- requires the complete approved tracked source inventory, rejecting extra ignored/untracked
  paths and unsupported filesystem entries before creating a source-mounted container;
- runs `gate.image` as `--user 19001:19001` with `HOME=/tmp`, `--group-add` of the staged source's
  group, `--cpus` from `resources.cpus` and `--memory <memoryMiB>m` from
  `resources.memoryMiB` (MiB);
- binds a verified source-only stage read-only at `/src` (`--mount type=bind,...,readonly`) and the npm cache
  volume at `/var/tmp` (`npm_config_cache=/var/tmp/npm`), and sets `WORKERS_CI_COMMIT_SHA`;
- checks that the image has `git`, `tar`, `ls` and `tail`, then copies `/src` without `.git`
  into `/tmp/work` and checks that the copy's tree is the commit's tree;
- captures exact commit/tree/digest pins with the source-identity helpers and validates the
  source bytes in fresh runner scratch before the stage is exposed to the image. A dirty or
  mismatched stage is rejected; original Git metadata is never mounted;
- transfers only freshly generated, sanitized Git metadata as a binary archive. The gate
  verifies its digest, genuine detached HEAD, raw/index tree, exact object inventory and clean
  status before install. Original Git configuration, history, refs, remotes, hooks and
  credentials are not copied;
- runs `install` with network access.
- after a passing install, when the commit's `package-lock.json` (lockfileVersion 2 or 3) lists
  optional packages, checks that each one npm installs on the container's platform is present,
  because npm skips an optional package whose fetch or build fails and still exits 0. `node` in
  the container reports the platform (`process.platform`, `process.arch` and libc when detected)
  and the Node and npm versions, so such a commit needs `node` in the image. The check follows
  npm's effective omit: `npm config get omit` run in the working copy (so project configuration,
  `npm_config_omit` and `NODE_ENV=production` count), joined with a best-effort reading of the
  install command's words (`--omit=X` or `--omit X`, `--production`, `--only=prod[uction]`,
  `--no-optional`, an inline `NODE_ENV=production`), less the kinds it names with `--include`.
  Expected are the `optional` entries the root and workspace folders reach whose `os`, `cpu`,
  `libc` and `engines` match and whose kind is not omitted (`dev` omits `dev` entries, `optional`
  omits `optional` ones, `peer` omits `peer` ones, and a `devOptional` entry goes only when both
  dev and optional are omitted). An unmatched, unreadable or omitted entry is skipped together
  with what only it reaches. `devOptional` entries are not checked themselves, since npm fails
  the install when one fails, nor are bundled entries. A missing package blocks the gate with a
  reason naming it, the platform, any omitted kinds and the install log. An empty install, a
  failing install and a commit without such a lock run no check.
- disconnects the Docker bridge and confirms only loopback remains.
- repeats read-only identity and clean-source validation before running the gate steps. Changed
  or unavailable identity fails closed without resetting, cleaning or rewriting source.
- runs the ordered steps in one `sh -c` script with `set -e`, logging to `NN-<name>.log`.
- allows up to four hours for install and four hours for the entire step sequence.

The identity bridge runs in the Node runner and adds no gate-image tool requirement. Builds
read genuine Git identity alongside the existing `WORKERS_CI_COMMIT_SHA`; no synthetic commit,
build-ID override or consumer-specific identity environment is required.

Installers may change only `core.hooksPath` in the generated Git configuration; all other
configuration and source-identity fields remain pinned. Validation disables hooks and
fsmonitor only for its own Git commands, leaving installer and category configuration untouched.

After a gate the host attempts to copy the logs and remove the container, including after a
failure or timeout. A passing gate compares Git status and the contents of the files it reports
with the pre-gate fingerprint. A change discards the result. After that check, the runner copies
`dist/` and `node_modules/` into the gate worktree when those directories exist. If container
removal cannot be confirmed, it retains the source stage and blocks an otherwise passing gate.
The next gate attempts to remove leftover containers for the game.

## Test overrides

Two environment variables are test-only overrides for the contract harness, never configuration.
`run` and `status --resources` honour them; an invalid value stops the command.

- `DELIVERY_KIT_TEST_CLOCK` names a JSON file `{epoch, realStartMs, speed, maxRealSleep?}`.
  Virtual time is `epoch` plus the sum of a `clock-offsets` file beside it (one number per line)
  plus the elapsed wall time times `speed`; both files are re-read on every reading. A runner sleep
  lasts until virtual time has advanced by its full interval. With `maxRealSleep` (seconds), each
  real wait is at most that long and the clock is re-read after it, so a stepped clock ends the
  sleep promptly.
- `DELIVERY_KIT_TEST_LOADAVG` is a one-minute load average, a decimal number of at least 0 such as
  `0.5`, read in place of the host load. A `loadLimit` of 0 still holds every departure, after the
  15-minute load wait.
