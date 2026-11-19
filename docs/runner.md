# Resident runner

The per-game resident runner: launch, supervision and replacement, the coordinator CLI seam, the pin guard, status provenance, observer adoption, departures, the gate container and test-only overrides.

Launch one runner per game from that game's canonical checkout, in its own session, so it
resolves the game's own `node_modules`:

```bash
cd /absolute/path/to/game \
  && DELIVERY_KIT_ROOT=/absolute/path/to/game-coordinator setsid node node_modules/@andornaut/delivery-kit/dist/cli.js run --game GAME_ID
```

The runner holds `runner.lock` and `loop.lock` (a second runner is refused), records its identity,
and runs the scheduled and requested departure loop, the per-minute observer (scheduled reviews,
scheduled-slot reports and event flushes), the 1800 s resource sampler and the CI watches
in-process. The runner creates no timers: none outlives it, and no cron entry or other timer is
involved. Supervision by a systemd user service is optional (see [Supervision](#supervision)). A
missed scheduled slot is never replayed.

The observer wakes at the start of each minute after its previous clock reading, so a pass that
runs past a minute boundary still reviews that minute's slot. A slot whose whole minute passes
during one pass is skipped, not replayed.

For each due slot the observer calls the coordinator-installed `coordination-kit review deliver`,
logs the line for its result, reports scheduled slots when `scheduledTicks` is set, then requests
an event flush ([Coordinator CLI seam](#coordinator-cli-seam)). coordination-kit composes and
delivers the review and owns the per-slot receipt: a repeated call for a slot returns the recorded
outcome without another send. The runner keeps no slot receipt, calls at most once per due slot
in each pass and never replays a missed slot.

The recipient's instruction contract for every caller-configured scheduled review pass is:

- Inventory registered parent queues, verified workers' queues and ready worker handoffs across
  all registered games, kits and game-coordinator. Classify every original backlog item, including
  independent work. This is a recipient obligation, not an automatic backlog drain or a guarantee
  that one snapshot contains every role's payloads.
- Report unavailable visibility explicitly, including unavailable Claude native target queues and
  worker visibility; never infer an empty backlog from unavailable data. Refused native historical
  worker-queue access remains unknown. Report capability limits and require owner reconciliation
  without bypassing refusals or forcing session loads.
- Acknowledge only exact unchanged originals with evidence of actual handling or supersession.
  Native or channel acceptance proves delivery, not handling.
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

A second start while another runner holds `runner.lock` or `loop.lock` is refused with exit 3 and
leaves the holder's identity intact.

## Coordinator CLI seam

The runner spawns the coordinator root's
`node_modules/@andornaut/coordination-kit/dist/cli.js` with its own Node binary
(`process.execPath`, never `npx`), the coordinator root it resolved from `--root` or
`DELIVERY_KIT_ROOT` as `--root` and as the working directory, and its own environment:

| Call                                        | When                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `review deliver --game GAME_ID --slot SLOT` | Once per due `wakeMinutes` slot                                       |
| `events flush --game GAME_ID`               | Once per observer pass and after each recorded event                  |
| `--version --json`                          | At startup, and before a call while the last seen CLI is out of range |

`SLOT` is the slot's minute start in ISO 8601 with the `config.json` timezone's offset, such as
`2026-11-18T16:30:00-05:00`, so the two daylight-saving fold slots at one wall minute differ. Each
call prints one JSON line on stdout with `schema` 1, its `kind`, the echoed `game` (and `slot`,
which must equal the one sent), `status` (`delivered`, `deferred` or `skipped`), `reason`, free-text
`detail` and `cli` `{version, distSha256}`; a flush adds `delivered` and `held` counts. The runner
parses the JSON, not its key order, and never parses `detail`.

`reason` is null when delivered, otherwise one of `route-unavailable`, `recipient-unavailable`,
`recipient-busy`, `question-pending`, `held`, `receipt-ambiguous`, `already-delivered`,
`nothing-due`, `no-events`, `outbox-unreadable` or `cli-error`; an unknown token is a deferral.
The runner adds `cli-unavailable` and `cli-version` for its own deferrals. coordination-kit
records each review result under `bus/unblock/review-deliver/` and prints it again for a repeated
call, except a `recipient-busy` lock contention, which it does not record. The runner never
passes `--capture`.

- **No delivery claimed:** a missing result, a nonzero exit (an internal failure exits 1 with no
  stdout and one `coordination-kit:` stderr line, which the runner logs), a line that is not one
  JSON object, a second stdout line, a wrong `schema`, `kind`, `game` or `slot`, a timeout and an
  abort claim nothing. The runner logs them and continues; none stops a departure, prevents runner
  start or ends the runner. The CLI checks for an abort before it writes a slot record, so killing
  it never leaves a partial record.
- **Timeout:** each spawn has 45 s, under the 60 s pass. On a timeout or an abort (runner
  shutdown) the runner kills the child's whole process group. A spawn never holds
  `departure.lock` and never delays a departure; departures never depend on the seam.
- **Missing CLI:** while the file is missing, for example during `npm ci` at the root, reviews
  and flushes defer with reason `cli-unavailable`. The next call after the install finishes
  reaches the CLI again.
- **Range:** the CLI version in each result must satisfy `COORDINATOR_CLI_RANGE` in
  `src/bus/pin.ts`, `>=1.2.0 <2.0.0` in delivery-kit 6.0.0. A result from a CLI outside it defers
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
| `skipped` with `nothing-due`    | none: this runner does not dispatch the slot                        |
| `skipped`, other reasons        | `bus: scheduled review WAKE: skipped REASON: DETAIL`                |
| no delivery claimed             | `bus: scheduled review WAKE unavailable (WHY); no delivery claimed` |

`WAKE` is the slot start in epoch seconds. A flush logs `bus: event flush deferred: REASON:
DETAIL`, `bus: event flush held N: DETAIL` or `bus: event flush failed: WHY; no delivery claimed`
once until its outcome changes, and nothing for a delivered or skipped flush with nothing held.
At most one flush runs at a time; a request during one runs one more after it.

The runner still records events in-process: `events/` is coordination-kit's outbox format, and
delivery-kit's per-commit tracking and `complete` event run under its lock. The CLI only delivers
them.

## Supervision

Supervision by a systemd user service is optional and adds no timer: the service starts the same
resident runner, whose schedule stays in-process. `runner unit` prints an explicit unit for one
game and installs nothing; it never runs `systemctl`. Run it from the game's canonical checkout
with the Node binary and `PATH` the runner should use:

```bash
mkdir -p ~/.config/systemd/user \
  && cd /absolute/path/to/game \
  && DELIVERY_KIT_ROOT=/absolute/path/to/game-coordinator node node_modules/@andornaut/delivery-kit/dist/cli.js runner unit --game GAME_ID \
  > ~/.config/systemd/user/delivery-kit-GAME_ID.service
```

The unit resolves every path when it is printed:

- `WorkingDirectory` is the game's canonical checkout. `ExecStart` is the absolute Node binary
  running the command (`process.execPath`), the game's installed
  `node_modules/@andornaut/delivery-kit/dist/cli.js` and `run --game GAME_ID`, with no `npx`.
- `Environment` sets `DELIVERY_KIT_ROOT` to the resolved coordinator root and `PATH` to the
  directories of `node`, `gh`, `docker`, `git`, `flock` and `claude` as found on the caller's
  `PATH`, Node first. A missing tool or installed CLI exits 1 with no unit printed.
- `Restart=on-failure` with `RestartSec=30`. A sixth start within 600 s (`StartLimitIntervalSec`,
  `StartLimitBurst=5`) is refused and the unit stays failed until `systemctl --user reset-failed`,
  so a persistent failure does not loop.
- `SuccessExitStatus=143` makes a `SIGTERM` stop a clean exit. `RestartPreventExitStatus=3` never
  restarts a refused start, because another runner holds the locks.
- `KillMode=mixed` and `KillSignal=SIGTERM` signal only the runner, which ends its own children.
  `TimeoutStopSec=120` covers an idle shutdown; processes still running after it are killed.
- `[Install]` has `WantedBy=default.target`.

The service sees only those variables plus the systemd user manager's defaults, such as `HOME`.
Git push and `gh` authentication must work without an interactive session's environment.

Enable and start it, after stopping any manually launched runner for that game:

```bash
systemctl --user daemon-reload \
  && systemctl --user enable --now delivery-kit-GAME_ID.service
```

Starting at boot without a login session needs lingering, which the user enables with
`sudo loginctl enable-linger "$USER"`.

Upgrade or replace a supervised runner in a quiet window:

1. Install the new pin in the game checkout: the devDependency bump, then `npm ci`.
2. After a Node upgrade or a moved tool, run `runner unit` again, replace the unit file and run
   `systemctl --user daemon-reload`. A pin change alone keeps every path.
3. Confirm with `status --game GAME_ID` that the runner is idle and drained.
4. Run `systemctl --user restart delivery-kit-GAME_ID.service`.
5. Verify exactly one holder of each lock with `status` (`runner_lock_held`, `loop_lock_held`,
   `identity_status` `current`) and `runner.json`.
6. Under an active work protocol, record observer adoption again for the new resident (see
   [Observer adoption](#observer-adoption)), then observe the next normal slot.

## Observer adoption

Under an active work protocol, the bus owner's `coordination-kit protocol observer-adoption` records the resident it
inspected. The adopted identity is `resident.residentId` in the audit artifact that registry
`operations.<game>.lastAdoption.evidenceRef` names; the audit must name the operation and match the
registry's bus owner, adopted version and CLI digest. Every runner start writes a new identity
token, so a start leaves the previous adoption stale until the bus owner refreshes it.

- At startup, when the protocol is active and the recorded adoption names a different token, the
  runner logs it and emits one `resident-identity-changed` event keyed by the new token. It goes
  through the existing reporter path to `reports.recipient` and names the bus owner who must
  refresh observer adoption. Each token reports at most once. An absent, unreadable or
  inconsistent adoption is logged, not reported.
- `status --game ID` reports `observer_adoption`, read-only:
  - `current`: the running identity is attested (`identity_status` `current`) and equals the
    adopted token;
  - `stale`: the running identity is attested and differs from the adopted token;
  - `unknown`: neither can be compared. `observer_adoption_reason` is `runner_not_current`,
    `protocol_inactive`, `protocol_unavailable`, `registry_unavailable`, `adoption_absent` or
    `adoption_unreadable`, and null for `current` and `stale`.

Neither the event nor the field records adoption, changes the registry or authorises replacement.

## Pin guard

The bundles inline the coordination-kit utilities they use (layout, registry reads, locks,
durable writes, configuration validation, IDs, event recording and the protocol read), so a game
pins only `@andornaut/delivery-kit` and the runner never loads a game copy of coordination-kit. The
build embeds the bundled coordination-kit version. delivery-kit declares the bundled
coordination-kit releases it supports in one place, `COORDINATION_KIT_RANGE` in `src/bus/pin.ts`;
delivery-kit 6.0.0 supports `>=1.0.1 <2.0.0` and bundles 1.2.0, the same release as the coordinator CLI it requires. The range holds plain `MAJOR.MINOR.PATCH` comparators (`<`, `<=`, `>`, `>=`,
`=`), and a prerelease or build-metadata version never satisfies it. The package check refuses a
build whose bundled version is outside the range, so a release can only ship a supported one.

`status` reports `coordination_kit` read-only: `bundled` (the inlined version) and `supported`
(the range). game-coordinator pins coordination-kit directly for the roles' CLI, the channel
MCP server and the seam the runner spawns, whose own range is `COORDINATOR_CLI_RANGE`
([Coordinator CLI seam](#coordinator-cli-seam)). Otherwise that install and each game's runner
exchange data only through the on-disk formats, which stay compatible within coordination-kit
1.x.

At startup the runner writes `var/games/<g>/bus/runner.json`: `schema`, `pid`, `startedAt`,
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
`reporter_blockers` and `drained`; an idle runner can still have unsent events. delivery-kit has
no reporter-event list, reconciliation or flush command. The resident observer requests
coordination-kit's `events flush`, which processes event receipts in order and marks an event
sent only after accepted delivery. Recipient inbox
acknowledgements and common-message reconciliation do not change reporter event state.
Installing a newer CLI or adopting its generic inbox does not prove an older resident's
reporters drained. Preserve event originals and ambiguous receipts for supported owner review.
A persisted review snapshot proves collection, not reminder delivery. Adapter availability and
local inbox health do not attest a resident reporter, native bridge or scheduled wake.

## Departures

Delivery is trunk-based. Tech merges each reviewed feature branch into the game's local `main`, as
a real merge or a fast-forward, and never pushes. There is no queue, batch merge,
cherry-pick, rewrite or revert. Each scheduled or requested departure, under `departure.lock`:

1. Restarts the CI watch of the pending deployment or the last push when it timed out or lost
   GitHub authentication, then retries a pending deployment whose CI has passed.
2. Reads `refs/heads/main` in the canonical checkout and the remote `main` with `git ls-remote`.
3. Skips when HEAD is the remote `main` or the last pushed SHA, or has a `gate-failed/<sha>`
   record. Nothing new means nothing departs.
4. Waits while the one-minute load is at or above `loadLimit`, re-checking it every 60 seconds
   with `departure.lock` and the runner locks held, so nothing else departs meanwhile. It
   continues once the load is below the limit. A load still at or above the limit 15 minutes after
   the scheduled slot (for a request, 15 minutes after it starts) skips the slot with
   `blocked-load` and `main` retained. A runner shutdown ends the wait without a report.
5. Stops with `blocked-push` when the remote `main` is known locally and is not an ancestor of
   HEAD. Nothing is gated or pushed; Tech merges the remote `main` into local `main`.
6. Gates HEAD on a detached scratch worktree, so merge commits are gated as they are. A
   docs-only range skips this step.
7. Pushes with `git push <remote> <sha>:refs/heads/<main>`, never forced. A non-fast-forward
   rejection is reported as `blocked-push` and nothing is pushed.
8. Stages the deployment, then watches CI for that exact SHA. A docs-only range never deploys.

The runner never fetches, checks out or moves a ref in the canonical checkout. Its only write there
is the push of an exact SHA (and the scratch worktree's Git metadata).

- **Fix forward:** a red gate (install or a gate step exiting non-zero inside the running
  container) leaves `main` unpushed and records `gate-failed/<sha>`, so that SHA is never gated
  again; the next departure runs once Tech merges a fix. Red CI or a failed deployment is fixed the
  same way, with no automatic CI rerun.
- **Docs-only range:** when every path changed from the remote `main` to HEAD starts with `docs/`
  (both sides of a rename count) and no deployment is pending, the departure starts no gate
  container. It pushes the exact SHA as in step 7, records `last-deploy-skipped.sha`, reports
  `deploy_skipped` and watches CI as usual; that range is never deployed. The `push` and
  `complete` reports say the gate was skipped. An unknown range (no remote `main`, or a remote
  commit missing locally), an empty diff or a pending deployment of an earlier push departs with
  the full gate, so the gated push supersedes the pending deployment. The prefix is fixed, not
  configured.
- **Gate infrastructure:** when Docker is unavailable, the image cannot be pulled, the container
  cannot be created or started, install fails with an npm network code (HTTP 5xx, `ETIMEDOUT`,
  `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `ESOCKETTIMEDOUT`), the network cannot be
  detached, more than loopback remains, a `docker cp` fails or the worktree fingerprint changes,
  the departure reports `blocked-gate` with
  the cause, writes no `gate-failed` record and gates the same SHA again at the next departure.
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
  deployment uses the Wrangler locked in the gated commit. A worktree without that entry is not
  deployed: the runner logs the missing path and keeps the deployment pending. A failure keeps the
  assets and is retried at a later departure. A deployment that cannot be staged after its push
  is reported as `deploy_failure` with the cause, so a pushed SHA never goes undeployed silently.
- **`request`:** an operator-authorized one-off departure of the current `main` HEAD with the same
  rules and receipts, including the 15-minute load wait, which starts when the request departs. A
  HEAD that is the last pushed SHA or failed its gate is refused, and a request whose HEAD moved
  before it departs is rejected.

## Gate container

One container per gated SHA, named `delivery-kit-gate-<game>-<short sha>` and labelled
`delivery-kit-gate=<game>`:

- requires the complete approved tracked source inventory, rejecting extra ignored/untracked
  paths and unsupported filesystem entries before creating a source-mounted container;
- runs `gate.image` as `--user 19001:19001` with `HOME=/tmp`, `--group-add` of the worktree's
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
- runs `install` with network;
- repeats read-only identity and clean-source validation after install, before gate categories.
  Changed or unavailable identity fails closed without resetting, cleaning or rewriting source;
- disconnects the container from every network and confirms only loopback remains, then runs
  each step in order under `sh -c` with `set -e`, logging to `NN-<name>.log`;
- gives install and the steps four hours each.

The identity bridge runs in the Node runner and adds no gate-image tool requirement. Builds
read genuine Git identity alongside the existing `WORKERS_CI_COMMIT_SHA`; no synthetic commit,
build-ID override or consumer-specific identity environment is required.

Installers may change only `core.hooksPath` in the generated Git configuration; all other
configuration and source-identity fields remain pinned. Validation disables hooks and
fsmonitor only for its own Git commands, leaving installer and category configuration untouched.

After a gate the host copies the logs out with `docker cp` and removes the container, also after a
failure or timeout. Git status and the content of every file it reports are fingerprinted before
and after; a change discards the gate. Only a passing gate whose fingerprint is unchanged also
copies `dist/` and `node_modules/` into the worktree, before any deployment. Leftover gate
containers for the game are removed before the next gate.

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
