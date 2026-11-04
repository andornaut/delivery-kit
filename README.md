# delivery-kit

Local scheduled trunk-based Git delivery: each departure gates the game's local `main` HEAD in
isolation, pushes that exact commit, monitors its CI and deploys the already-gated build on a pass. The kit owns the mechanisms. Each game
owns its repository, `delivery-kit.json`, credentials and schedule; game-dev owns `config.json`,
the registry and all mutable state under `var/`.

The package is `@andornaut/delivery-kit`. Its one runtime entry point is the `delivery-kit` CLI,
bundled into `dist/cli.js`. The bundle imports only `node:` builtins, never imports or spawns its
own files, and reads nothing from disk after startup except configuration and state. Its only
child processes are `git`, `docker`, `gh`, `wrangler`, `flock`, `claude` and `codex`.

## Install and pin

Games and game-dev pin the release asset as a devDependency and commit the lockfile integrity:

```json
"devDependencies": {
  "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v1.0.0/delivery-kit-1.0.0.tgz"
}
```

A pin changes only by a devDependency bump, `npm ci`, then an idle runner replacement. Each game's
runner runs from that game's own `node_modules`; game-dev's copy runs `migrate`, `check-config`,
`status`, `channel` and the monitor commands.

## Commands

Every command resolves game-dev from `--root DIR`, else `DELIVERY_KIT_ROOT`, else the working
directory. `--root` comes before the command.

| Command                                                                                                                                 | Purpose                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `run --game ID`                                                                                                                         | The resident runner for one game.                                                                                              |
| `check-config [--game ID]`                                                                                                              | Validate `config.json`, `var/registry.json` and each `delivery-kit.json` together, with no Git, network or container activity. |
| `request --game ID --request-id SAFE_ID`                                                                                                | Record an operator-authorized one-off departure of the current local `main` HEAD. The runner performs it.                      |
| `status --game ID`                                                                                                                      | Read-only runner identity, singleton, idle and drain report.                                                                   |
| `resource-report --game ID`                                                                                                             | Reporting-only resource information.                                                                                           |
| `migrate [--game ID] [--dry-run] [--harness claude\|codex]`                                                                             | Move 0.9.x state into `var/` (see [Upgrading from 0.9.x](#upgrading-from-09x)).                                                |
| `migrate --remove-legacy [--dry-run]`                                                                                                   | Delete the listed 0.9.x scripts once both runners run from `node_modules`.                                                     |
| `channel [--game ID]... [--poll-seconds N]`                                                                                             | The Claude channel consumer, a stdio MCP server the monitor session launches.                                                  |
| `monitor-snapshot --game ID [--recipient ROLE] [--parent ROLE]...`                                                                      | Capture the monitor review snapshot. The recipient defaults to `monitor`.                                                      |
| `monitor-ack --game ID [--recipient ROLE] --snapshot UUID --queue-id ID... --disposition handled\|superseded\|retained [--reason TEXT]` | Acknowledge queue items from that snapshot. `retained` requires a reason.                                                      |
| `help`, `--help`, `--version`                                                                                                           | Usage and version.                                                                                                             |

Exit status is 0 on success, 1 for invalid configuration, a failed precondition or an
unavailable read, and 2 for a usage error.

## Configuration

### game-dev `config.json`

Committed in game-dev. Every path is relative to game-dev. See `examples/config.json`.

- `timezone` and `wakeMinutes`: the monitor wake schedule. An empty `wakeMinutes` schedules no
  wake.
- `games.<id>`: `name` (the report name, for example `Archie`), `path` to the game checkout and
  `roles`.
- `kits.<id>.path` and `sharedRoles`.

Registry role keys are `<game>/<role>` for each game role, then each shared role name.

### Game `delivery-kit.json`

Committed in each game and owned by its Tech role. See `examples/delivery-kit.json`.

- `git`: `main`, `remote` and the GitHub `owner/name`.
- `schedule`: departure minutes and `timezone`, which defaults to the `config.json` timezone.
- `gate`: `image`, `install` and ordered `steps` (`name`, `run`). Any image and install command
  are accepted. Dependencies install with network; every step then runs with none. An empty
  `install` skips the install step, and an empty `steps` list gates with no checks.
- `resources`: `cpus`, `maxWorkers` and `loadLimit`, capped at 4, 4 and 24. A departure starts
  only below `loadLimit`, so 0 holds every departure.
- `ci`: `requiredNames` (check names that must exist and pass for the exact pushed commit),
  `pollSeconds` and `timeoutSeconds`.
- `deploy`: `mode` is `wrangler` or `none`; `skipPattern` is a regular expression over the pushed
  range (the remote `main` to the pushed SHA), and a push whose every changed path matches it
  skips deployment.
- `reports`: `project` (must equal the game's name in `config.json`), `scheduledTicks`, and the
  role names `recipient` and `workerParents`, resolved through the registry.

Configuration never holds secret values. Use the operator's existing authentication and
credential references.

## State

All mutable state lives in game-dev's ignored `var/`:

- `registry.json` and `registry.lock`: ownership and conversation IDs, shared with the
  game-sessions skills.
- `route.json`: the monitor route.
- `handoffs/`: checkpoints the registry references.
- `game-dev/`: monitor review snapshots, health history, acknowledgements and retentions.
- `games/<g>/bus/`: the bus (locks, `active-departure`, `gate-failed/`, the detached gate worktree
  kept for a pending deployment, gate logs, CI and deployment state, events, requests, the
  delivery spool), plus `runner.json` and `runner.log`. The gate's npm cache is the Docker volume
  `delivery-kit-npm-<game>`.
- `games/<g>/process-health.json`: the optional owner-registered process manifest.

Every state write is a temp file, fsync, rename, then a directory fsync. Locks are `flock(1)` on
files under `var/`. Runners write only to their own `var/games/<g>/bus/`.

## Resident runner

Launch one runner per game from that game's canonical checkout, in its own session, so it
resolves the game's own `node_modules`:

```bash
cd /absolute/path/to/game \
  && DELIVERY_KIT_ROOT=/absolute/path/to/game-dev setsid npx delivery-kit run --game GAME_ID
```

The runner holds the singleton locks, records its identity, and runs the scheduled and requested
departure loop, the 60 s observer, the 1800 s resource sampler and the CI watches in-process. No
timer outlives it, and no systemd unit, cron entry or other timer is involved.

At startup it writes `var/games/<g>/bus/runner.json`: `schema`, `pid`, `startedAt`, `version`,
`cliPath` (realpath of the loaded `dist/cli.js`), `cliSha256` and the lockfile `integrity`. At each
departure it compares these with the installed package. On a mismatch or a missing package it
emits one deduplicated `pin-mismatch` event and finishes on the loaded code. Short commands load
fresh code.

To replace a runner: record its identity, stop it while idle, start one runner, verify exactly one
holder of each lock with `status` and `runner.json`, then observe the next normal slot. A
replacement resumes every CI watch whose `ci/<sha>.status` is still running.

### Departures

Tech merges each reviewed feature branch into the game's local `main`, as a real merge or a
fast-forward, and never pushes. Each departure, under `departure.lock`:

1. Reads `refs/heads/main` in the canonical checkout.
2. Skips when that HEAD is the last pushed SHA or the remote `main`, or has a
   `gate-failed/<sha>` record. Nothing new means nothing departs.
3. Gates it on a detached scratch worktree at HEAD, so merge commits are gated as they are.
4. Pushes with `git push origin <sha>:refs/heads/main`, never forced. A non-fast-forward rejection
   is reported and nothing is pushed.
5. Watches CI for that exact SHA and deploys the gated build when CI passes.

The runner never fetches, checks out or moves a ref in the canonical checkout: it reads
`refs/heads/main`, asks the remote for its `main` with `git ls-remote` and pushes the exact SHA.

- **Fix forward:** there is no cherry-pick, rewrite or revert. A red gate leaves `main` unpushed
  and records `gate-failed/<sha>`, so that SHA is never gated again; the next departure runs once
  Tech merges a fix. Red CI or a failed deployment is fixed the same way.
- **Gate:** one uid 19001 container per gated SHA reads the worktree through a read-only bind,
  checks that its copy is the commit's tree, installs with network, then runs every step with
  none. Its logs and `dist/` are copied out and the container is removed, also after a failure.
- **CI:** waits for every `requiredNames` check, and every other registered check, on the exact
  pushed commit.
- **Deployment:** staged at the push in `deploy-pending` with its worktree, run when CI passes,
  retried at a later departure after a failure, and superseded by a newer push.
- **`request`:** an operator-authorized one-off departure of the current `main` HEAD with the same
  rules and receipts. A HEAD that is already pushed or failed its gate is refused, and a request
  whose HEAD moved before it departs is rejected.

### Test overrides

Two environment variables are test-only overrides for the contract harness, never configuration.
`run` and `resource-report` honour them; an invalid value stops the command.

- `DELIVERY_KIT_TEST_CLOCK` names a JSON file `{epoch, realStartMs, speed}`. Virtual time is
  `epoch` plus the sum of a `clock-offsets` file beside it (one number per line) plus the elapsed
  wall time times `speed`, and every runner sleep shrinks by `speed`.
- `DELIVERY_KIT_TEST_LOADAVG` is a one-minute load average, a decimal number of at least 0 such as
  `0.5`, read in place of the host load. A `loadLimit` of 0 still holds every departure.

## Monitor and harnesses

The registry's top-level `harness` (`claude` or `codex`) selects the adapter for every role, and
each role keeps a conversation ID per harness, so a transfer flips `harness` without deleting the
other IDs.

- **Claude:** briefs and events are spooled under the bus's `unblock/` directory with a `sending`
  receipt first. `delivery-kit channel` claims each entry, delivers it once to the monitor
  session, records the delivery and marks the receipt `accepted`. An interrupted delivery becomes
  `ambiguous` and is never resent. The channel server is configured in the monitor session's MCP
  settings; see `examples/claude-channel.mcp.json`.
- **Codex:** turns are steered through the local control socket with the same receipt rules.

`CODEX_CONTROL_SOCKET` and `CLAUDE_BIN` override the adapters' defaults. Registry state records
ownership and never proves activation; transfers carry the hold, acceptance and activation
markers.

## Registry library

`@andornaut/delivery-kit/registry` (`dist/registry.js` with types) is the typed registry module the
skills use. It uses only `node:` builtins and `flock(1)`.

- `loadLayout(gameDevRoot)` and `gameLayout(layout, game)`: `config.json` and the `var/` paths.
- `readRegistry(layout)`: a validated snapshot carrying its `revision`.
- `updateRegistry(layout, expectedRevision, mutate, options)` and
  `createRegistry(layout, initial, options)`: hold `var/registry.lock`, reject a changed revision
  with `RevisionConflict`, validate, write durably and increment `revision`. Pass
  `options.held` when the caller already holds the lock.
- `resolveConversation(registry, role)` and `resolveRole(registry, role)`.
- `RegistrySchema` and `validateRegistry`.

delivery-kit writes only `operations.*.lastAdoption`; the skills own every other field.

## Upgrading from 0.9.x

1.0 replaces the Bash and Python mechanisms, `bus.conf` and the per-game state directories.
Configuration moves into `delivery-kit.json` and `config.json`, Codex and Claude session maps into
`var/registry.json`, and every state file into `var/`. Delivery becomes trunk-based: the queue,
admission, batch merges, cherry-picks and the CI-repair approval are gone, and 1.x ignores the
`bus-queue`, `bus-queue.lock`, `merge.lock`, `ci-repair-approval*` and Tech `*-queued.json` and
`*-ready.json` files that migration copies. The other bus files keep their 0.9.x names and statuses; request receipts now
record `head` instead of `entries`.

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
- **Route:** the route host game's `.claude/monitor/route.json` is copied to `var/route.json` when
  its `host_project_root` names that game.
- **Markers:** `var/games/<g>/migrated.json`, `var/game-dev.migrated.json` and
  `var/route.migrated.json` record the source digest. A matching marker makes a rerun a no-op; a
  changed source, or a target without a marker, stops and reports. A leftover staging directory is
  discarded.
- **Registry:** when absent, `var/registry.json` is built from the 0.x registry files and their
  checkpoints are copied to `var/handoffs/`. `var/registry-provenance.json` records each field's
  source, every cross-source conflict and every record that has no version 1 field. When the 0.x
  records name more than one active harness, `--harness` is required.
- **Read-only:** the old trees are then made read-only. They are never deleted by `migrate`.
- `--game ID` migrates only that game's bus; the monitor state, route and registry need a full run.

Until convergence a 1.x runner also takes the old `runner.lock` and `loop.lock`, read-only, so a
0.x runner cannot start beside it.

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
`scripts/pack.sh` and `tests/contract/run.sh` are thin wrappers that `exec` them.

- `npm run verify` (`scripts/check.ts`): types, lint, build, unit tests and the contract cases in
  offline containers running as uid 19001 in the checkout's group (`--group-add`). The checkout
  and its file list are bound read-only and copied into container scratch. The npm cache and the
  verified v0.9.1 parity release live in a named volume that one networked step populates. The
  v0.9.1 contract cases gate; the 1.0 bundle's cases gate once `DELIVERY_KIT_CONTRACT_NODE=1` is
  set and are reported only until then. A changed source fingerprint, ownership or mode change,
  or any file owned by uid or gid 19001 discards the result.
- `npm run contract -- [--lock] [VITEST_ARGS]` (`scripts/contract.ts`): the contract harness alone,
  with the source streamed in as a tar and both implementations gating. `--lock` regenerates
  `tests/contract/package-lock.json`.
- `npm run check`: TypeScript only.
- `npm run pack -- EXACT_COMMIT_SHA /new/absolute/directory` (`scripts/pack.ts`): builds the release
  asset from an exact commit, offline under the same container rules with the cache volume
  read-only, and writes `delivery-kit-VERSION.tgz`, `SOURCE_COMMIT` and `SHA256SUMS`.

`.nvmrc` pins the Node version for both the host scripts and the container image. Containers
start only below a one-minute load of 24 and use at most four CPUs.

## Compatibility and releases

`VERSION` and `package.json` carry the version, and `pack` refuses a mismatch. The CLI, `delivery-kit.json`, `config.json`, the registry
schema, the registry module API and the `var/` layout follow semver: an incompatible change needs
a major version and a migration. 1.0 is incompatible with 0.9.x.

The release owner pushes the release commit to `main`, verifies every required CI workflow
succeeded for that exact commit, then tags `vVERSION` there and attaches the `pack` output. A
published tag is never moved.

## Licence

MIT; see `LICENSE`. The licence does not cover consumer art assets or game values.
