# Upgrading

Breaking changes between major versions, the edits each one needs, and the removed command forms.

## Upgrading to 6.1

6.1.0 replaces the in-process event outbox with a per-game append-only event log,
`bus/events.jsonl`, that the runner alone writes, and asks the coordinator CLI to
`events ingest` it instead of `events flush` ([Event log](runner.md#event-log)). The runner no
longer tracks `<sha>.state` or emits `complete`: COMPLETE is a coordination-kit projection.
Commands, options and exit codes are unchanged.

1. game-coordinator installs coordination-kit 2.0.1 or later (inside `>=2.0.1 <3.0.0`) and runs
   `npm ci` before any 6.1 runner starts. A 6.1 runner on an older root, 2.0.0 included, still
   starts, departs and appends events, but defers every review and event ingest with
   `cli-version`.
2. Each game pins delivery-kit 6.1.1, commits the lockfile integrity, runs `npm ci` and replaces
   its runner while idle, after its own departure and outside a wake minute:

   ```json
   "devDependencies": {
     "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v6.1.1/delivery-kit-6.1.1.tgz"
   }
   ```

   At that first start, before its loop, the runner imports the unsent `bus/events/*.json`
   outbox files into `events.jsonl` in creation order and renames `bus/events` to
   `bus/events.imported-<epoch>`; the `<sha>.state` files stay there. A last push that has not
   completed gets a `push` line, so its COMPLETE still forms. The import repeats safely if
   interrupted.

3. Confirm with `status --game GAME_ID` that `coordinator_cli.supported` is `true`, that
   `reporter_blockers` holds no `events_legacy_outbox`, and that `events.drained` becomes `true`
   once the first ingest runs.

- Output: a `nothing-due` review now logs `bus: scheduled review SLOT: skipped nothing-due:
DETAIL`, one line per due slot on every runner, where 6.0 printed nothing. The ingest logs
  `bus: event ingest deferred|failed`; the `held` line is gone. Each
  appended event's `detail` keeps the text the 6.0 outbox delivered.
- Status: `status --game` adds `events {file, size, cursorOffset, rotated, torn, drained}`;
  `reporter_blockers` replaces `unsent_events:N` and `event_flush_running` with the event log
  blockers in [Command semantics](commands.md#command-semantics).
- State: the bus gains `events.jsonl`, `events.cursor`, `events.quarantine.jsonl`,
  `events.<epoch>.jsonl`, `events.imported-<epoch>/` and `last-complete.sha`
  ([State](state.md)).
- Events: a push under `deploy.mode` `none` now appends `deploy_disabled`.
- Pins: delivery-kit 6.1.1 bundles coordination-kit 2.0.1 for its utilities
  (`COORDINATION_KIT_RANGE` `>=2.0.0 <3.0.0`); the coordinator CLI range is `>=2.0.1 <3.0.0`,
  because a 2.0.0 ingest quarantines the runner's lines with a null `status`.
- Rollback: run `coordination-kit events ingest --game GAME_ID` once with the 2.0 CLI to drain
  `events.jsonl`, confirm `events.drained`, then restore the 6.0.0 pin and lockfile, run `npm ci`
  and start the 6.0 runner while idle. The 2.0 CLI keeps `events flush` working on the 6.0
  outbox, so the root keeps coordination-kit 2.0.

## Upgrading to 6.0

6.0.0 stops bundling scheduled review delivery and event delivery. The runner spawns the
coordinator root's `coordination-kit review deliver` and `events flush` instead
([Coordinator CLI seam](runner.md#coordinator-cli-seam)). State formats do not change, events are
still recorded in-process, and delivery-kit's commands, options and exit codes are unchanged.

1. game-coordinator installs coordination-kit 1.2.0 or later (inside `>=1.2.0 <2.0.0`) before any
   6.0 runner starts, then runs `npm ci`:

   ```json
   "devDependencies": {
     "@andornaut/coordination-kit": "https://github.com/andornaut/coordination-kit/releases/download/v1.2.0/coordination-kit-1.2.0.tgz"
   }
   ```

   A 6.0 runner on a root without it still starts and departs, but defers every review and event
   flush with `cli-unavailable` or `cli-version`.

2. Each game pins delivery-kit 6.0.0, commits the lockfile integrity, runs `npm ci` and replaces
   its runner while idle, after its own departure and outside a wake minute:

   ```json
   "devDependencies": {
     "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v6.0.0/delivery-kit-6.0.0.tgz"
   }
   ```

3. Confirm with `status --game GAME_ID` that `coordinator_cli.supported` is `true` once the first
   seam result arrives, and that `runner.log` shows the next slot's review line.

- Pins: delivery-kit 6.0.0 bundles coordination-kit 1.2.0 for its utilities
  (`COORDINATION_KIT_RANGE` `>=1.0.1 <2.0.0`), the same release the coordinator root installs; the
  coordinator CLI range is separate.
- Output: a delivered review reads `bus: scheduled review SLOT: DETAIL`, where `DETAIL` is the
  CLI's free text, not a JSON object. A deferral reads `bus: review deferred: REASON: DETAIL`, a skip other than `nothing-due`
  reads `bus: scheduled review SLOT: skipped REASON: DETAIL`, and the event flush logs
  `bus: event flush deferred|held|failed`. Update any parser that read JSON after the slot.
- Status: `status --game` adds `coordinator_cli`; every other field is unchanged.
- The state directory gains `bus/seam.json`, written only by the runner.
- Rollback: restore the 5.0.2 pin and lockfile in the game, run `npm ci` and replace the runner
  while idle. A 5.0.2 runner delivers with its bundled coordination-kit and ignores the root's
  install, so the root may keep coordination-kit 1.2.

## Upgrading to 5.0

5.0.0 moves the coordination commands, libraries and docs to `@andornaut/coordination-kit` and
keeps the game operations: `run`, `runner unit`, `status`, `control`, `check-config` and
`request`. State does not move: both kits read and write the `var/` layout and byte formats of
4.7.0.

- Pins: a game pins only delivery-kit, which bundles coordination-kit; delivery-kit 5 bundles
  coordination-kit 1.x; 5.0.2 supports `>=1.0.1 <2.0.0` ([Pin guard](runner.md#pin-guard)).
  game-coordinator pins coordination-kit directly for the roles' CLI and the channel MCP server,
  beside its delivery-kit pin for `check-config` and `status`. The two installs exchange data only
  through the on-disk formats, which stay compatible within coordination-kit 1.x. Pin each release
  asset as a devDependency, commit the lockfile integrity, run `npm ci`, then replace the runner
  while idle:

  ```json
  "devDependencies": {
    "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v5.0.2/delivery-kit-5.0.2.tgz"
  }
  ```

  game-coordinator adds:

  ```json
  "devDependencies": {
    "@andornaut/coordination-kit": "https://github.com/andornaut/coordination-kit/releases/download/v1.0.2/coordination-kit-1.0.2.tgz"
  }
  ```

  From 5.0.0 to 5.0.1, a game only reinstalls delivery-kit 5.0.1, which bundles
  coordination-kit 1.0.1. game-coordinator's coordination-kit pin may stay on any 1.0.x release:
  1.0.1 changes only tests and docs, so its runtime, CLI, exports and formats match 1.0.0.

- Commands: each moved command keeps its options, JSON output and exit codes under
  `coordination-kit`. delivery-kit 5 refuses the old form with exit 2 and a one-line hint naming
  the new one. Update scripts and agent instructions:

  | delivery-kit 4.x command                           | coordination-kit 1.x command            |
  | -------------------------------------------------- | --------------------------------------- |
  | `delivery-kit inbox snapshot`                      | `coordination-kit inbox snapshot`       |
  | `delivery-kit inbox ack`                           | `coordination-kit inbox ack`            |
  | `delivery-kit message send`                        | `coordination-kit message send`         |
  | `delivery-kit message dispatch`                    | `coordination-kit message dispatch`     |
  | `delivery-kit message status`                      | `coordination-kit message status`       |
  | `delivery-kit message reconcile`                   | `coordination-kit message reconcile`    |
  | `delivery-kit message retire-spool`                | `coordination-kit message retire-spool` |
  | `delivery-kit ledger intake`                       | `coordination-kit ledger intake`        |
  | `delivery-kit ledger apply`                        | `coordination-kit ledger apply`         |
  | `delivery-kit ledger show`                         | `coordination-kit ledger show`          |
  | `delivery-kit ledger report`                       | `coordination-kit ledger report`        |
  | `delivery-kit ledger history`                      | `coordination-kit ledger history`       |
  | `delivery-kit ledger coverage`                     | `coordination-kit ledger coverage`      |
  | `delivery-kit ledger reconcile`                    | `coordination-kit ledger reconcile`     |
  | `delivery-kit ledger boundary`                     | `coordination-kit ledger boundary`      |
  | `delivery-kit harness doctor`                      | `coordination-kit harness doctor`       |
  | `delivery-kit harness ready`                       | `coordination-kit harness ready`        |
  | `delivery-kit harness select`                      | `coordination-kit harness select`       |
  | `delivery-kit claude ready`                        | `coordination-kit claude ready`         |
  | `delivery-kit claude channel`                      | `coordination-kit claude channel`       |
  | `delivery-kit codex ready`                         | `coordination-kit codex ready`          |
  | `delivery-kit protocol VERB` (every protocol verb) | `coordination-kit protocol VERB`        |

- Channel MCP configuration: run `coordination-kit ... claude channel` in place of
  `delivery-kit ... claude channel`. The server still identifies itself as
  `delivery-kit-channel`, so an existing server key needs no change.
- Root: delivery-kit resolves `--root`, then `DELIVERY_KIT_ROOT`. coordination-kit also accepts
  both and prefers a nonempty `COORDINATION_KIT_ROOT`.
- Library imports: delivery-kit no longer exports `/build/registry`, `/build/transport`,
  `/build/accounting` or `/build/protocol`, nor their unprefixed aliases `/registry`,
  `/transport`, `/accounting` and `/protocol`, under `@andornaut/delivery-kit`. Import the same
  symbols from `@andornaut/coordination-kit/build/registry`, `/build/transport`,
  `/build/accounting` and `/build/protocol`; coordination-kit has no unprefixed aliases.
  `@andornaut/delivery-kit/build/source-identity` and its alias are unchanged.

## Upgrading to 4.7

`run --game` now exits 3, not 1, when another runner holds `runner.lock` or `loop.lock`.
Invalid configuration still exits 1. Scripts that treat 1 as "already running" must check 3.

## Upgrading to 4.0

Version 4.0 requires an explicit `resources.memoryMiB` in every game configuration, including
configurations created with 3.x. The value must be an integer from 6 through 8192 because
[Docker requires at least 6 MiB](https://docs.docker.com/engine/containers/resource_constraints/#limit-a-containers-access-to-memory).
Missing or invalid values fail configuration validation before a gate container starts.
There is no default or automatic configuration rewrite. The 3.x validators reject the new field,
so the owning Tech must coordinate the configuration and package pin changes in a controlled
idle adoption. Do not edit the live configuration early. Preserve delivery controls, locks,
reports and departure cadence during adoption.

## Upgrading to 3.0

3.0.0 removes duties and the route's `monitor` field. A game's scheduled review goes to the role
its `delivery-kit.json` names as `reports.recipient`, the same role that receives its events.
A 2.x reader cannot use a schema 2 route or resolve a duty after the edits, so every pin (each
game and game-coordinator) moves to 3.0.0 in the same idle replacement window.

- `var/registry.json`: remove `duties` from every role, and replace each duty name with the role
  key that held it, in `operations.<game>.busOwner` and anywhere else a role is named. A role that
  still has `duties` fails validation with this edit. The registry schema stays 1.
- `var/route.json`: remove `monitor` and set `schema` to 2. The host game's `reports.recipient`
  receives the review. A schema 1 route defers every review and is reported by `check-config`.
- Each `delivery-kit.json`: `reports.recipient` and `reports.workerParents` name registered role
  keys (for example `game-coordinator`), never a duty.
- Channel MCP configuration: replace `--monitor UUID` with `--conversation UUID`, or omit it to
  serve the selected games' `reports.recipient`. The example server key is `delivery-kit-channel`.
- Scripts and instructions: `inbox snapshot` and `inbox ack` replace `monitor snapshot` and
  `monitor ack`, with the same options. Role arguments (`--requester`, `--role`, `--recipient`,
  `--parent`) take role keys, not duties.
- Output: runner lines read `bus: scheduled review SLOT:` and `bus: review deferred:`; slot and
  health fields are `review_status`, `review_reason` and `recipient_session_status`, slot receipts
  carry `recipient`, and the health event kind is `review-stuck`. Claude review briefs are spooled
  with kind `review`; an entry a 2.x runner spooled is still delivered. Inbox state changes
  serialize on `unblock/inbox.lock`.
- Registry module: `AmbiguousRole` is removed, `resolveRole` accepts only registered role keys, and
  `Layout.monitorDir` is `Layout.reviewDir`.

## Removed command forms

A removed form exits 2; there are no aliases. Each prints a one-line hint naming its replacement,
except `migrate`, which prints the usage text, and `request --request-id`, which is refused as an
unknown option with the `request` usage line.

| Removed form                                                                       | Removed in | Current form                                                                 |
| ---------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `channel ...`                                                                      | 2.0.0      | `coordination-kit claude channel ...`                                        |
| `monitor-snapshot ...`                                                             | 2.0.0      | `coordination-kit inbox snapshot ...`                                        |
| `monitor-ack ...`                                                                  | 2.0.0      | `coordination-kit inbox ack ...`                                             |
| `resource-report --game ID`                                                        | 2.0.0      | `status --game ID --resources`                                               |
| `status --harness claude`                                                          | 2.0.0      | `coordination-kit claude ready`                                              |
| `status --harness codex`                                                           | 2.0.0      | `coordination-kit codex ready`                                               |
| `request --game ID --request-id ID`                                                | 2.0.0      | `request --game ID --id ID`                                                  |
| `migrate ...`, `migrate --remove-legacy`                                           | 2.0.0      | removed; upgrade 0.9.x through 1.0.3                                         |
| `monitor snapshot ...`                                                             | 3.0.0      | `coordination-kit inbox snapshot ...`                                        |
| `monitor ack ...`                                                                  | 3.0.0      | `coordination-kit inbox ack ...`                                             |
| `claude channel --monitor UUID`                                                    | 3.0.0      | `coordination-kit claude channel --conversation UUID`                        |
| `inbox`, `message`, `ledger`, `harness`, `protocol`, `claude` and `codex` commands | 5.0.0      | `coordination-kit GROUP VERB ...` (see [Upgrading to 5.0](#upgrading-to-50)) |
