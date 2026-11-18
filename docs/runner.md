# Resident runner

The per-game resident runner: launch and replacement, the pin guard, status provenance, departures, the gate container and test-only overrides.

Launch one runner per game from that game's canonical checkout, in its own session, so it
resolves the game's own `node_modules`:

```bash
cd /absolute/path/to/game \
  && DELIVERY_KIT_ROOT=/absolute/path/to/game-coordinator setsid npx delivery-kit run --game GAME_ID
```

The runner holds `runner.lock` and `loop.lock` (a second runner is refused), records its identity,
and runs the scheduled and requested departure loop, the per-minute observer (scheduled reviews,
scheduled-slot reports and event flushes), the 1800 s resource sampler and the CI watches
in-process. No timer outlives it, and no systemd unit, cron entry or other timer is involved. A
missed scheduled slot is never replayed.

The observer wakes at the start of each minute after its previous clock reading, so a pass that
runs past a minute boundary still reviews that minute's slot. A slot whose whole minute passes
during one pass is skipped, not replayed.

Each distinct scheduled review slot attempts a guarded review, including when queues are empty,
unchanged since an accepted review, or explicitly retained. Accepted inventory signatures are
health diagnostics, not permission to suppress later scheduled reviews. Repeated observations
of the same slot use its persisted receipt without another send; an interrupted send becomes
ambiguous and is never resent. An explicit stale-turn rejection permits one refreshed attempt.
Queue inventory errors block the review, and recipient clearance and native question guards
still apply. Worker failure and question notice deduplication remain independent of the review.
Acceptance does not acknowledge queue work: acknowledgements still validate unchanged originals,
and retention remains bound to the exact payload.

The recipient's instruction contract for every caller-configured scheduled review pass is:

- Inventory registered parent queues, verified workers' queues and ready worker handoffs across
  all registered games, kits and game-coordinator. Classify every original backlog item, including
  independent work. This is a recipient obligation, not an automatic backlog drain or a guarantee
  that one snapshot contains every role's payloads.
- Report unavailable visibility explicitly, including unavailable Claude native target queues and
  worker visibility; never infer an empty backlog from unavailable data. Refused native historical
  worker-queue access remains unknown. Public 4.0.0 lacks the supported worker inbox path; adopt a
  reviewed package pin containing the 4.1.0 worker inbox support before using it. Report capability
  limits and require owner reconciliation without bypassing refusals or forcing session loads.
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
deadline.

## Pin guard

At startup the runner writes `var/games/<g>/bus/runner.json`: `schema`, `pid`, `startedAt`,
`version`, `cliPath` (realpath of the loaded `dist/cli.js`), `cliSha256` and the lockfile
`integrity` of `node_modules/@andornaut/delivery-kit`. Before each departure it compares the
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
`reporter_blockers` and `drained`; an idle runner can still have unsent events. There is no
public reporter-event list, reconciliation or flush command. The resident observer processes
event receipts in order and marks an event sent only after accepted delivery. Recipient inbox
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
  hold the watch. `requiredNames` must not be empty. `ci/<sha>.json` marks each run `required`. A
  failure names the failed required runs, and a timeout names the required checks with no run and
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
