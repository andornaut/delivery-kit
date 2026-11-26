# State

Where delivery-kit keeps mutable state, how it writes it durably, and the persistent delivery control record.

The following paths live under the workspace's ignored `var/`. Coordination Kit owns the
registry, route, review and message state. Delivery Kit owns each app's bus and shares the
event log and cursor formats with Coordination Kit.

- `registry.json` and `registry.lock`.
- `route.json`: the review route.
- `handoffs/<scope>/`: checkpoints the registry references.
- `reviews/`: review and inbox snapshots, health history, acknowledgements and retentions.
  Legacy workspaces and app mode with `"appStateDir": "games"` use `game-dev/`.
- `apps/<id>/bus/`: the bus for a new app workspace. Legacy workspaces and app mode with
  `"appStateDir": "games"` use `games/<id>/bus/`. The bus holds `runner.lock`, `loop.lock`, `departure.lock`,
  `active-departure` (the running departure's start epoch, empty when none), `gate-failed/`,
  the detached `gate-<sha>` worktree kept for a pending deployment, `gate-logs/`, `ci/`, `deploy/`,
  `deploy-pending`, `last-push*`, `last-deploy*`,
  `events.jsonl` (the runner's event log), `events.cursor` (the ingest cursor, written only by
  `coordination-kit events ingest`, naming its file by first line ID, inode and device), `events.quarantine.jsonl` (malformed lines ingest set aside),
  `events.<epoch>.jsonl` (rotated logs awaiting ingest), `events.imported-<epoch>/` (a retained
  6.0 outbox archive with its `<sha>.state` files), `last-complete.sha` (the last commit the
  runner saw complete), `requests/` (receipts and `requests.lock`), `unblock/` (Coordination Kit delivery state),
  `runner.json`, `runner.identity.json`,
  `seam.json` (the last coordinator CLI identity a seam result carried), `resources.log`,
  `runner.log`, `runner.out` (the output of a runner `runner start` spawned without a unit), `codex-bus.pid` (the runner's PID), `delivery-control.json` and `control.lock`.

An unmigrated `bus/events` outbox blocks startup and remains in place. Use the
[6.1.2 migration bridge](upgrading.md#upgrading-to-80) to import and drain it.

The gate's npm cache is the Docker volume `delivery-kit-npm-<id>`.

Coordination Kit owns the external coordination state root. The legacy protocol used
`<stateRoot>/accounting` and `<stateRoot>/transport/messages`. See the [Coordination Kit 3.0 migration](https://github.com/andornaut/coordination-kit/blob/main/docs/upgrading.md#from-21)
for retirement and the current configuration pointer.

Durable record replacement uses a temporary file, file fsync, rename and directory fsync. The
[event log](runner.md#event-log) uses single `O_APPEND` writes followed by fsync. Locks use
`flock(1)`. Runners load `delivery-kit.json` from the app repository. Gates also create
detached worktrees and use a Docker cache volume.

## Desired and observed delivery control

`bus/delivery-control.json` is the single persistent control record. Writers hold
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

`status --app ID` includes a `control` object:

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
