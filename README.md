# delivery-kit

Local scheduled trunk-based Git delivery. Each departure gates the game's local `main` HEAD in an
isolated container, pushes that exact commit, watches its CI and deploys the already-gated build
on a pass. The kit owns the mechanisms. Each game owns its repository, `delivery-kit.json`,
credentials and schedule; game-dev owns `config.json`, the registry and all mutable state under
`var/`.

The package is `@andornaut/delivery-kit`. Its one runtime entry point is the `delivery-kit` CLI,
bundled into `dist/cli.js`. The bundle imports only `node:` builtins, has no dynamic `import()`,
relative `require`, worker threads or source maps, never spawns its own files, and reads nothing
from disk after startup except configuration and state. Its child processes are `git`, `docker`,
`gh`, `flock`, `claude agents --json` and the game's own Wrangler run by the same Node binary.

## Install and pin

Games and game-dev pin the release asset as a devDependency and commit the lockfile integrity:

```json
"devDependencies": {
  "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v1.0.1/delivery-kit-1.0.1.tgz"
}
```

A pin changes only by a devDependency bump, `npm ci`, then an idle runner replacement. Each game's
runner runs from that game's own `node_modules`; game-dev's copy runs `migrate`, `check-config`,
`status`, `channel` and the monitor commands.

## Commands

Every command resolves game-dev from `--root DIR`, else `DELIVERY_KIT_ROOT`, else the working
directory. `--root` comes before the command.

| Command                                                                                                                                                    | Purpose                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `run --game ID`                                                                                                                                            | The resident runner for one game.                                                                                              |
| `check-config [--game ID]`                                                                                                                                 | Validate `config.json`, `var/registry.json` and each `delivery-kit.json` together, with no Git, network or container activity. |
| `request --game ID --request-id SAFE_ID`                                                                                                                   | Record an operator-authorized one-off departure of the current local `main` HEAD. The runner performs it.                      |
| `status --game ID`                                                                                                                                         | Read-only runner identity, singleton, idle and drain report as one JSON line.                                                  |
| `status --harness claude\|codex`                                                                                                                           | The handoff readiness probe (see [Readiness probe](#readiness-probe)).                                                         |
| `resource-report --game ID`                                                                                                                                | Reporting-only resource information.                                                                                           |
| `migrate [--game ID] [--dry-run] [--harness claude\|codex]`                                                                                                | Move 0.9.x state into `var/` (see [Upgrading from 0.9.x](#upgrading-from-09x)).                                                |
| `migrate --remove-legacy [--dry-run]`                                                                                                                      | Delete the listed 0.9.x scripts once every runner runs from `node_modules`.                                                    |
| `channel [--game ID]... [--poll-seconds N] [--monitor UUID] [--state-dir DIR]...`                                                                          | The Claude channel consumer, a stdio MCP server the monitor session launches.                                                  |
| `monitor-snapshot --game ID [--recipient ROLE] [--parent ROLE]... [--history-cursor CURSOR]`                                                               | Capture the monitor review snapshot.                                                                                           |
| `monitor-ack --game ID [--recipient ROLE] [--parent ROLE]... --snapshot UUID --queue-id ID... --disposition handled\|superseded\|retained [--reason TEXT]` | Acknowledge queue items from that snapshot. `retained` requires a reason.                                                      |
| `help`, `--help`, `--version`                                                                                                                              | Usage and version.                                                                                                             |

- `request`: `SAFE_ID` is 1 to 64 ASCII letters, digits, underscores or hyphens.
- `channel`: by default it drains every game's spool (or each `--game`) for the registry's
  `monitor` conversation and requires `harness` to be `claude`. `--monitor UUID` and repeated
  absolute `--state-dir STATE/unblock` paths select the monitor and spools explicitly;
  `--state-dir` excludes `--game`. `--poll-seconds` defaults to 5.
- `monitor-snapshot` and `monitor-ack`: `--recipient` defaults to the `monitor` duty. `--recipient`
  and `--parent` take a role name, or a canonical conversation UUID registered for the active
  harness. With Claude the recipient must be the active route's monitor and every parent a route
  member; with Codex every parent must belong to the active route. `--history-cursor` applies to
  Codex.

Exit status is 0 on success, 1 for invalid configuration, a failed precondition, an unavailable
read or a refused runner start, and 2 for a usage error or an unexpected failure. `run` exits 130
on `SIGINT` and 143 on `SIGTERM`.

## Configuration

Configuration never holds secret values. Use the operator's existing authentication and
credential references.

### game-dev `config.json`

Committed in game-dev, schema 1. Every path is relative to game-dev. See `examples/config.json`.

- `timezone` and `wakeMinutes` (integers 0 to 59): the monitor wake schedule. An empty
  `wakeMinutes` schedules no wake.
- `games.<id>`: `name` (the report name, for example `Archie`), `path` to the game checkout and
  `roles`.
- `kits.<id>.path` and `sharedRoles`.

Role keys are `<game>/<role>` for each game role, then each shared role name. The registry, the
route and every role reference must use these keys.

### Game `delivery-kit.json`

Committed in each game, schema 1, and owned by its Tech role. See `examples/delivery-kit.json`.

- `git`: `main`, `remote` and the GitHub `owner/name`.
- `schedule`: `departures`, a non-empty list of two-digit minute strings such as `"00"`, and
  `timezone`, which defaults to the `config.json` timezone.
- `gate`: `image`, `install` and ordered `steps` (`name`, `run`). Any image and install command
  are accepted. An empty `install` skips the install step, and an empty `steps` list gates with no
  checks. A command that assigns a secret-like variable inline (for example `TOKEN=x npm ci`) is
  rejected.
- `resources`: `cpus` (1 to 4) and `loadLimit` (0 to 24). A departure starts only below
  `loadLimit`, so 0 holds every departure.
- `ci`: `requiredNames` (a non-empty list of check names that must exist and pass for the exact
  pushed commit), `pollSeconds` (1 to 3600) and `timeoutSeconds` (1 to 86400).
- `deploy`: `mode` is `wrangler` or `none`; the optional `skipPattern` is a regular expression
  over the paths changed in the pushed range (the previous remote `main` to the pushed SHA). A push
  whose every changed path matches it skips deployment.
- `reports`: `project` (must equal the game's `name` in `config.json`), `scheduledTicks`, and
  `recipient` and `workerParents`, each a role key or duty name resolved through the registry.

## Registry

`var/registry.json` (schema 1) is shared by delivery-kit and the game-sessions skills. It records
ownership and the conversation ID of each role per harness. It never proves activation on its
own: `transfers` carries the hold, acceptance and activation markers.

| Field                             | Content                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `revision`, `updatedAt` | `1`, a non-negative integer incremented on every write, and a UTC timestamp.                                                                                                                    |
| `harness`                         | `claude` or `codex`: the active harness for every role.                                                                                                                                         |
| `host`                            | `nativeProjectId` and `root` (relative to game-dev).                                                                                                                                            |
| `roles.<key>`                     | `ownership`, `worktree` (relative to game-dev), `conversations` (`claude` and `codex`, each an ID or null), and optional `branch`, `phase`, `activation` (`marker`, `checkpoint`) and `duties`. |
| `operations.<game>`               | `busOwner` (a role key or duty), optional `activation.marker` and `lastAdoption` (`at`, `version`, `cliSha256`, optional `integrity`).                                                          |
| `transfers[]`                     | `marker`, `from`, `to`, `phase` (`source-held`, `accepted` or `active-confirmed`), `roles` and `checkpoint`.                                                                                    |

- Every role key must be a role key in `config.json`, and every `operations` key a game.
- A duty (for example `monitor`) is a name held by exactly one role. A role name resolves to
  itself; a duty name resolves to the role that holds it, and a duty held by more than one role is
  an error. A duty must not equal a role key.
- Every writer holds `var/registry.lock`, rejects a changed `revision`, validates the result,
  writes durably and increments `revision`.
- The skills own every field except `operations.*.lastAdoption`, which is reserved for
  delivery-kit. Apart from `migrate` creating the first registry, the CLI only reads it.

### Send-time resolution

Route, configuration, briefs and events name roles, never conversation IDs. Each wake, event
delivery, monitor snapshot, acknowledgement and readiness probe reads `var/registry.json` when it
sends: `harness` selects the adapter and `roles.<role>.conversations.<harness>` gives the ID.
Nothing is cached across sends. A missing or null ID is reported `unavailable` for that role,
never as clearance.

A harness handoff is therefore one `updateRegistry` mutation of `harness`, with no configuration
edit, runner restart or migration. The other harness's IDs stay in place.

Recipient decision records (`unblock/decisions/<conversation>.json`) stay keyed by conversation
ID, because a pending question belongs to one conversation. Their owner writes them; delivery-kit
only reads them, and a missing or invalid record is never clearance.

### Readiness probe

`status --harness claude|codex` sends nothing and reports whether that adapter can deliver now:

- Claude: `claude agents --json` returns a listing.
- Codex: `CODEX_CONTROL_SOCKET` names an absolute socket path that accepts a connection.
- The route's monitor and every target, or the `monitor` duty when there is no route, have a
  conversation ID for that harness. An invalid route is never ready.

Output is one JSON line:

```json
{
  "harness": "codex",
  "adapter": { "status": "available", "reason": null },
  "roles": [{ "role": "game-dev", "conversation": "<uuid>", "status": "resolved" }],
  "ready": true
}
```

It exits 0 when ready and 1 when not. Run it before flipping `harness`.

## Monitor route

`var/route.json` (schema 1) names the monitor and its targets by role:

```json
{
  "schema": 1,
  "state": "active",
  "host": "archies-dog-walks",
  "monitor": "game-dev",
  "targets": ["archies-dog-walks/tech", "chibis-way-home/tech", "art-kit"]
}
```

- `state` is `active` or `held`. A held route, or no route, delivers no scheduled wake.
- `host` is the game whose runner dispatches the scheduled wake at the `config.json`
  `wakeMinutes`.
- `monitor` and every target must be role keys in `config.json`. Targets are distinct, and an
  active route needs at least one target other than the monitor.
- The file has exactly these five keys.

## Harness adapters

- **Claude:** briefs and events are spooled under the bus's `unblock/` directory with a `sending`
  receipt written first. `delivery-kit channel` claims each entry, delivers it once to the
  monitor session, records the delivery, marks the receipt `accepted`, then removes the entry. A
  `sending` receipt with no spool entry becomes `ambiguous` and is never resent. The channel server
  is configured in the monitor session's MCP settings; see `examples/claude-channel.mcp.json`.
- **Codex:** turns are steered through the control socket at `CODEX_CONTROL_SOCKET`, which must be
  set to an absolute path, with the same receipt rules. Without it Codex delivery is deferred.

`CLAUDE_BIN` overrides the `claude` executable. Events dedupe on `sha256(kind:key)`, and every
`blocked-*` kind shares one identity, so a changed block reason is not reported again. Events are
delivered in creation order and marked sent only after the adapter accepts them; the first
refusal stops a flush and the next flush resumes there.

## State

All mutable state lives in game-dev's ignored `var/`:

- `registry.json` and `registry.lock`.
- `route.json`: the monitor route.
- `handoffs/<scope>/`: checkpoints the registry references.
- `game-dev/`: monitor review snapshots, health history, acknowledgements and retentions.
- `games/<g>/bus/`: the bus. It holds `runner.lock`, `loop.lock`, `departure.lock`,
  `active-departure`, `gate-failed/`, the detached `gate-<sha>` worktree kept for a pending
  deployment, `gate-logs/`, `ci/`, `deploy/`, `deploy-pending`, `last-push*`, `last-deploy*`,
  `events/`, `requests/`, `unblock/` (the delivery spool), `runner.json`, `runner.identity.json`,
  `resources.log` and `runner.log`.
- `games/<g>/process-health.json`: the optional owner-registered process manifest.
- `games/<g>/migrated.json`: the migration marker.

The gate's npm cache is the Docker volume `delivery-kit-npm-<game>`.

Every state write is a temp file, fsync, rename, then a directory fsync. Locks are `flock(1)` on
files under `var/`. Runners read `<game>/delivery-kit.json` and write only to their own
`var/games/<g>/bus/`. Apart from `migrate`, delivery-kit writes nothing under any `.claude/`
directory.

## Resident runner

Launch one runner per game from that game's canonical checkout, in its own session, so it
resolves the game's own `node_modules`:

```bash
cd /absolute/path/to/game \
  && DELIVERY_KIT_ROOT=/absolute/path/to/game-dev setsid npx delivery-kit run --game GAME_ID
```

The runner holds `runner.lock` and `loop.lock` (a second runner is refused), records its identity,
and runs the scheduled and requested departure loop, the 60 s observer (monitor wakes,
scheduled-slot reports and event flushes), the 1800 s resource sampler and the CI watches
in-process. No timer outlives it, and no systemd unit, cron entry or other timer is involved. A
missed scheduled slot is never replayed.

To replace a runner: record its identity, stop it while idle, start one runner, verify exactly one
holder of each lock with `status` and `runner.json`, then observe the next normal slot. A
replacement resumes every CI watch whose `ci/<sha>.status` is still running, with its original
deadline.

### Pin guard

At startup the runner writes `var/games/<g>/bus/runner.json`: `schema`, `pid`, `startedAt`,
`version`, `cliPath` (realpath of the loaded `dist/cli.js`), `cliSha256` and the lockfile
`integrity` of `node_modules/@andornaut/delivery-kit`. Before each departure it compares the
loaded version, `cliSha256` and integrity with the game's installed package and `package-lock.json`.
On a mismatch, or a missing package, it logs, emits one `pin-mismatch` event deduplicated on the
loaded and installed values, and finishes on the loaded code until a controlled idle replacement.
Short commands load fresh code.

### Departures

Delivery is trunk-based. Tech merges each reviewed feature branch into the game's local `main`, as
a real merge or a fast-forward, and never pushes. There is no queue, admission, batch merge,
cherry-pick, rewrite or revert. Each scheduled or requested departure, under `departure.lock`:

1. Retries a pending deployment whose CI has passed.
2. Reads `refs/heads/main` in the canonical checkout and the remote `main` with `git ls-remote`.
3. Skips when HEAD is the remote `main` or the last pushed SHA, or has a `gate-failed/<sha>`
   record. Nothing new means nothing departs.
4. Holds the departure while the one-minute load is at or above `loadLimit` (`blocked-load`).
5. Stops with `blocked-push` when the remote `main` is known locally and is not an ancestor of
   HEAD. Nothing is gated or pushed; Tech merges the remote `main` into local `main`.
6. Gates HEAD on a detached scratch worktree, so merge commits are gated as they are.
7. Pushes with `git push <remote> <sha>:refs/heads/<main>`, never forced. A non-fast-forward
   rejection is reported as `blocked-push` and nothing is pushed.
8. Stages the deployment, then watches CI for that exact SHA.

The runner never fetches, checks out or moves a ref in the canonical checkout. Its only write there
is the push of an exact SHA (and the scratch worktree's Git metadata).

- **Fix forward:** a red gate leaves `main` unpushed and records `gate-failed/<sha>`, so that SHA
  is never gated again; the next departure runs once Tech merges a fix. Red CI or a failed
  deployment is fixed the same way, with no automatic CI rerun.
- **CI:** polls the check runs of the exact pushed commit through the existing `gh` login, or the
  public GitHub API when `gh` is not installed. The latest run of each name counts. Any completed
  run that is not `success`, `neutral` or `skipped` fails it; it passes once every
  `requiredNames` check exists and every run has completed. A watch that reaches `timeoutSeconds`
  reports the status as unknown.
- **Deployment:** with `mode` `wrangler` and a range that needs it, the push records
  `deploy-pending` with its worktree, superseding an older pending deployment. When CI passes and
  the remote `main` is still that SHA, it runs `node_modules/wrangler/bin/wrangler.js deploy
--config wrangler.jsonc --no-bundle` in the gate worktree with the gated `dist/`, so the
  deployment uses the Wrangler locked in the gated commit. A worktree without that entry is not
  deployed: the runner logs the missing path and keeps the deployment pending. A failure keeps the
  assets and is retried at a later departure.
- **`request`:** an operator-authorized one-off departure of the current `main` HEAD with the same
  rules and receipts. A HEAD that is the last pushed SHA or failed its gate is refused, and a
  request whose HEAD moved before it departs is rejected.

### Gate container

One container per gated SHA, named `delivery-kit-gate-<game>-<short sha>` and labelled
`delivery-kit-gate=<game>`:

- runs `gate.image` as `--user 19001:19001` with `HOME=/tmp`, `--group-add` of the worktree's
  group and `--cpus` from `resources.cpus`;
- binds the worktree read-only at `/src` (`--mount type=bind,...,readonly`) and the npm cache
  volume at `/var/tmp` (`npm_config_cache=/var/tmp/npm`), and sets `WORKERS_CI_COMMIT_SHA`;
- copies `/src` without `.git` into `/tmp/work` and checks that the copy's tree is the commit's
  tree;
- runs `install` with network, disconnects the container from every network and confirms only
  loopback remains, then runs each step in order under `sh -c` with `set -e`, logging to
  `NN-<name>.log`;
- gives install and the steps four hours each.

After a gate the host copies the logs out with `docker cp` and removes the container, also after a
failure or timeout. Git status and the content of every file it reports are fingerprinted before
and after; a change discards the gate. Only a passing gate whose fingerprint is unchanged also
copies `dist/` and `node_modules/` into the worktree, before any deployment. Leftover gate
containers for the game are removed before the next gate.

### Test overrides

Two environment variables are test-only overrides for the contract harness, never configuration.
`run` and `resource-report` honour them; an invalid value stops the command.

- `DELIVERY_KIT_TEST_CLOCK` names a JSON file `{epoch, realStartMs, speed, maxRealSleep?}`.
  Virtual time is `epoch` plus the sum of a `clock-offsets` file beside it (one number per line)
  plus the elapsed wall time times `speed`; both files are re-read on every reading. A runner sleep
  lasts until virtual time has advanced by its full interval. With `maxRealSleep` (seconds), each
  real wait is at most that long and the clock is re-read after it, so a stepped clock ends the
  sleep promptly.
- `DELIVERY_KIT_TEST_LOADAVG` is a one-minute load average, a decimal number of at least 0 such as
  `0.5`, read in place of the host load. A `loadLimit` of 0 still holds every departure.

## Registry library

`@andornaut/delivery-kit/registry` (`exports["./registry"]`: `dist/registry.js` with
`dist/registry.d.ts`) is the typed registry module the skills use. It uses only `node:` builtins
and `flock(1)`; `dist/cli.js` embeds the same source. Context parameters come first and the
subject last.

- `loadLayout(gameDevRoot)` and `gameLayout(layout, game)`: `config.json` and the `var/` paths.
  `roleKeys(config)` and `validateGameDevConfig`.
- `readRegistry(layout)`: a validated snapshot carrying its `revision`; `RegistryMissing` when
  absent.
- `updateRegistry(layout, expectedRevision, mutate, options)` and
  `createRegistry(layout, initial, options)`: hold `var/registry.lock` (30 s by default), reject a
  changed revision with `RevisionConflict` or an existing file with `RegistryExists`, validate,
  write durably, increment `revision` and set `updatedAt`. An invalid result throws
  `ValidationError` and leaves the file unchanged. Pass `options.held` when the caller already
  holds the lock.
- `resolveRole(registry, role)` and `resolveConversation(registry, role)`, which throw
  `UnknownRole` or `AmbiguousRole`.
- `RegistrySchema`, `validateRegistry`, `HARNESSES` and `TRANSFER_PHASES`, with the record types.

## Upgrading from 0.9.x

1.0 replaces the Bash and Python mechanisms, `bus.conf` and the per-game state directories.
Configuration moves into `delivery-kit.json` and `config.json`, Codex and Claude session maps into
`var/registry.json`, and every state file into `var/`. Delivery is trunk-based: the queue,
admission, batch merges, cherry-picks and the CI-repair approval are gone, and 1.x ignores the
`bus-queue`, `bus-queue.lock`, `merge.lock`, `ci-repair-approval*` and Tech `*-queued.json` and
`*-ready.json` files that migration copies. The other bus files keep their 0.9.x names and
statuses; request receipts record `head` instead of `entries`.

Before cutover each game Tech pins 1.0, commits `delivery-kit.json` and, if needed, drops non-Node
tooling from its gate image as its own change.

### Migration

Run from game-dev, with every 0.x runner stopped at an idle boundary:

```bash
npx delivery-kit migrate --dry-run
npx delivery-kit migrate --harness claude
```

- **Preconditions**, checked after taking the old queue, request, delivery and event locks plus
  `var/registry.lock`: the old `runner.lock` and `loop.lock` are free, `active-departure` is empty,
  no `ci/*.lock` is held, no request is `started` or `pending`, no spool entry is `.claimed` and
  there is no `deploy-pending`. No 0.x work may be in flight: each branch still in `bus-queue`
  and each `batch-*` scratch worktree is listed for Tech to land on `main` or drop. Any failure
  stops the migration before its first write.
- **Copy:** each game's `.claude/bus/` goes to `var/games/<g>/bus/` and game-dev's
  `.claude/monitor/codex/` to `var/game-dev/`, through a staging directory, with symlinks
  preserved and both sides hashed. Tech's ad hoc records (`*-queued.json`, `*-ready.json`) never
  block: they are copied and listed as "Tech-owned records, copied, not acted on". Legacy scripts,
  `bus.conf`, 0.x snapshots, `__pycache__` and `npm-cache` are not copied.
- **Runner log:** `runner.log`, or Chibi's `codex-bus.log`, moves to `var/games/<g>/bus/runner.log`.
- **Route:** the route host game's `.claude/monitor/route.json`, whose `host_project_root` must name
  that game, becomes `var/route.json` in the role-name schema. Each version 1 `monitor_thread_id`
  and `targets[].thread_id`, or version 2 `session_id`, maps through the registry's conversations
  to one role; an ID that maps to no role or to several stops the migration and is listed.
- **Markers:** `var/games/<g>/migrated.json`, `var/game-dev.migrated.json` and
  `var/route.migrated.json` record the source digest. A matching marker makes a rerun a no-op; a
  changed source, or a target without a marker, stops and reports. A leftover staging directory is
  discarded.
- **Registry:** when absent, `var/registry.json` is built from the 0.x registry files and their
  checkpoints are copied to `var/handoffs/`. `var/registry-provenance.json` records each field's
  source, every cross-source conflict and every record that has no version 1 field. When the 0.x
  records name more than one active harness, `--harness` is required.
- **Read-only:** the old trees are then made read-only. `migrate` never deletes them.
- `--game ID` migrates only that game's bus; the monitor state, route and registry need a full run.

Until convergence a 1.x runner also takes the old `runner.lock` and `loop.lock`, so a 0.x runner
cannot start beside it.

### Removing the 0.9.x scripts

`migrate --remove-legacy` runs only when every game is migrated and each `runner.json` shows a live
runner loading the game's `node_modules` copy of `dist/cli.js`. It prints every path first and
deletes only these, in each game's `.claude/bus/`:

- **Archie:** the regular files `batch.sh`, `bus-common.sh`, `bus.sh`, `ci-watch.sh`,
  `departure.sh`, `merge.sh`, `post-push.sh`, `resource-check.sh`, `resource-report.sh`,
  `scheduled-once.sh`, `event.py`, `unblock.py` and `runner.sh`.
- **Chibi:** the symlinks with the same ten `.sh` names plus `event.py` and `unblock.py`, and the
  regular files `runner.before-monitor-041.sh` and `runner.sh`.

A listed path of the wrong kind stops the removal before anything is deleted. Unlisted paths are
never deleted.

### Rollback

At an idle boundary: stop the 1.x runner, make the old trees writable, copy back only
`last-push*`, `ci/`, `deploy/` and post-cutover receipts, then start the preserved 0.x snapshot.
Queue entries are never copied back, and the old registry files are never modified.

### Convergence

The migration code is removed once both skills use only `config.json` and `var/registry.json`,
every game has completed one clean 1.x cycle (scheduled departure, CI, deploy, accepted event and
acknowledgement, no `ambiguous` receipts) and no process references an old path.

## Development

The maintainer scripts are TypeScript under `scripts/`, run directly by Node with only `node:`
builtins: they run on the host as the invoking user and drive `docker`. `scripts/check.sh`,
`scripts/pack.sh` and `tests/contract/run.sh` are thin wrappers that `exec` them, and are not
shipped. The repository has no other shell or Python.

- `npm run verify` (`scripts/check.ts`): types, lint, build, unit tests and the contract cases in
  offline containers running as uid 19001 in the checkout's group (`--group-add`). The checkout
  and its file list are bound read-only and copied into container scratch. The npm cache and the
  verified v0.9.1 parity release live in a named volume that one networked step populates. The
  contract cases gate on both the v0.9.1 parity release and the 1.0 bundle. A changed source
  fingerprint, ownership or mode change, or any file owned by uid or gid 19001 discards the
  result.
- `npm run contract -- [--lock] [VITEST_ARGS]` (`scripts/contract.ts`): the contract harness alone,
  with the source streamed in as a tar and both implementations gating. `--lock` regenerates
  `tests/contract/package-lock.json`.
- `npm run check`: TypeScript only.
- `npm run pack -- EXACT_COMMIT_SHA /new/absolute/directory` (`scripts/pack.ts`): builds the
  release asset from an exact commit, offline under the same container rules with the cache volume
  read-only.

`.nvmrc` pins the Node version for both the host scripts and the container image. Containers
start only below a one-minute load of 24 and use at most four CPUs.

## Compatibility and releases

`VERSION` and `package.json` carry the version, and `pack` refuses a mismatch. The CLI,
`delivery-kit.json`, `config.json`, the registry schema, the route schema, the registry module API
and the `var/` layout follow semver: an incompatible change needs a major version and a migration.
1.0 is incompatible with 0.9.x.

A release is three files from `pack`:

- `delivery-kit-VERSION.tgz`, the npm package (`dist/`, `README.md`, `LICENSE`, `SOURCE_COMMIT`);
- `SOURCE_COMMIT`, the exact commit it was built from, also inside the archive;
- `SHA256SUMS`, covering the archive and `SOURCE_COMMIT`.

The release owner pushes the release commit to `main`, verifies every required CI workflow
succeeded for that exact commit, then tags `vVERSION` there and attaches the `pack` output. A
published tag is never moved.

## Licence

MIT; see `LICENSE`. The licence does not cover consumer art assets or game values.
