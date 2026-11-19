# State

Where delivery-kit keeps mutable state, how it writes it durably, and the persistent delivery control record.

The legacy default is game-coordinator's ignored `var/`. delivery-kit and coordination-kit share
this layout and its byte formats: coordination-kit owns the registry, route, review, message,
ledger and protocol state, and delivery-kit owns each game's bus. These paths remain there even
when the work protocol is active:

- `registry.json` and `registry.lock`.
- `route.json`: the review route.
- `handoffs/<scope>/`: checkpoints the registry references.
- `game-dev/`: review and inbox snapshots, health history, acknowledgements and retentions.
  This persisted directory remains `var/game-dev/` for the coordinator rename.
- `games/<g>/bus/`: the bus. It holds `runner.lock`, `loop.lock`, `departure.lock`,
  `active-departure` (the running departure's start epoch, empty when none), `gate-failed/`,
  the detached `gate-<sha>` worktree kept for a pending deployment, `gate-logs/`, `ci/`, `deploy/`,
  `deploy-pending`, `last-push*`, `last-deploy*`,
  `events.jsonl` (the runner's event log), `events.cursor` (the ingest cursor, written only by
  `coordination-kit events ingest`, naming its file by first line ID, inode and device), `events.quarantine.jsonl` (malformed lines ingest set aside),
  `events.<epoch>.jsonl` (rotated logs awaiting ingest), `events.imported-<epoch>/` (the imported
  6.0 outbox with its `<sha>.state` files), `last-complete.sha` (the last commit the runner saw
  complete), `requests/`, `unblock/` (coordination-kit's delivery spool), `runner.json`, `runner.identity.json`,
  `seam.json` (the last coordinator CLI identity a seam result carried), `resources.log`,
  `runner.log`, `codex-bus.pid` (the runner's PID), `delivery-control.json` and `control.lock`.

The gate's npm cache is the Docker volume `delivery-kit-npm-<game>`.

An active work protocol uses its external `stateRoot` for publications and artifacts,
`<stateRoot>/accounting` for the request ledger and intake, and
`<stateRoot>/transport/messages` for derived message transport state and recipient spools.
The configuration pointer and cutover fence remain under `var/`.

Every state write is a temp file, fsync, rename, then a directory fsync. The event log is the
exception: an append-only file whose lines are single `O_APPEND` writes followed by fsync
([Event log](runner.md#event-log)). Locks are `flock(1)` on
files under the selected state directories. Runners read `<game>/delivery-kit.json` and write only to their own
`var/games/<g>/bus/`. delivery-kit writes nothing under any `.claude/` directory.

## Desired and observed delivery control

`games/<g>/bus/delivery-control.json` is the single persistent control record. Writers hold
`control.lock` and use the durable write procedure above. Its schema is:

| Field                | Content                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `schema`, `revision` | `1` and the record revision.                                                                  |
| `desired`            | `state` (`enabled` or `paused`), `reason`, `requester`, `updatedAt` and `revision`.           |
| `observed`           | Null before a runner claims control; otherwise `state`, `sha`, `updatedAt` and `runnerToken`. |
| `activities`         | Activity IDs mapped to `state` (`checking`, `deploying` or `failed`), `sha` and `updatedAt`.  |

The runner claims observations only after acquiring its singleton locks. Observation writes
must match its token; an earlier runner cannot overwrite the current runner's observations.
Observed states are `idle`, `checking`, `deploying`, `stopped` and `failed`. Concurrent CI and
deployment activities are aggregated into the observation. A SHA is a full 40-character commit
ID or null; timestamps are ISO strings.

`paused` prevents admission of new scheduled and requested departures. An already admitted gate,
CI watch or deployment finishes. On restart, an existing CI watch can resume while paused;
pause does not admit a new departure to retry a deployment. Missing or invalid control fails
closed until explicitly initialized or repaired. A legacy installation never becomes enabled
implicitly. Readiness probes, candidates and blockers remain separate from desired control;
none creates a competing control file or implies permission to depart.

`status --game ID` adds a `control` object:

| Field                                 | Content                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `desired`, `desired_status`           | The desired record or null, and `valid`, `missing` or `invalid`.                             |
| `desired_state`, `migration_required` | `enabled`, `paused` or `unknown`, and whether explicit initialization or repair is required. |
| `observed`, `observed_status`         | The observation or null, and `current`, `stale`, `unattested`, `missing` or `invalid`.       |
| `mismatch`, `mismatch_reason`         | Boolean or null when comparison is unknown, plus a bounded reason code or null.              |
| `draining`                            | Whether a current admitted batch is finishing while desired control is paused.               |

`mismatch_reason` is null or one of `control_missing`, `control_invalid`, `observation_missing`,
`observation_invalid`, `observation_unattested` or `desired_enabled_observed_stopped`.

The nested records retain their SHA, timestamps, revisions and runner identity fields. A paused
runner draining a current batch has `mismatch: false`; an enabled runner attested as stopped has
`mismatch: true`. Stale or unattested idle/checking observations do not prove a current phase:
the comparison is unknown (`mismatch: null`). Status never fabricates a phase from old identity
or treats missing data as clearance. A stopped observation is attested only when both runner
locks are free and its runner token matches the identity and lock token.

## Adopt persistent control

Tech installs the upgraded package and replaces its runner only while idle. Before starting
the new runner, `game-coordinator` uses the upgraded CLI to explicitly initialize the approved desired
states. An older installed CLI does not implement `control`:

```bash
delivery-kit control --game GAME_ID --state paused \
  --reason 'Approved initial pause' --requester game-coordinator
delivery-kit control --game OTHER_GAME_ID --state enabled \
  --reason 'Approved initial enablement' --requester game-coordinator
```

These are explicit adoption operations, not built-in defaults. Preserve an existing upgraded
control record and its desired state on later upgrades. Check `status` before and after Tech's
idle replacement, including singleton identity, desired/observed control, drain state and
blockers. Observe the next normal scheduled slot; adoption starts no manual departure.
