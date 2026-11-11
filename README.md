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
  "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v3.0.0/delivery-kit-3.0.0.tgz"
}
```

A pin changes only by a devDependency bump, `npm ci`, then an idle runner replacement. Each game's
runner runs from that game's own `node_modules`; game-dev's copy runs `check-config`, `status`,
`claude channel`, the readiness probes and the inbox commands.

## Commands

Top-level verbs are game operations; `inbox`, `harness`, `claude` and `codex` are noun groups that take a
verb. Every command resolves game-dev from `--root DIR`, else `DELIVERY_KIT_ROOT`, else the working
directory. `--root` may appear anywhere on the command line, at most once. `--game` is always
explicit; it is never inferred from the working directory.

| Command                                                                                                                                                  | Purpose                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run --game ID`                                                                                                                                          | Game operation: the resident runner for one game.                                                                                                                |
| `status --game ID [--resources]`                                                                                                                         | Game operation: read-only runner identity, singleton, idle and drain report as one JSON line; with `--resources`, the reporting-only resource information.       |
| `control --game ID --state enabled\|paused --reason TEXT --requester ROLE`                                                                               | Game operation: persist desired delivery control with its reason and requesting role.                                                                            |
| `check-config [--game ID]`                                                                                                                               | Game operation: validate `config.json`, `var/registry.json`, `var/route.json` and each `delivery-kit.json` together, with no Git, network or container activity. |
| `request --game ID --id SAFE_ID`                                                                                                                         | Game operation: record an operator-authorized one-off departure of the current local `main` HEAD. The runner performs it.                                        |
| `inbox snapshot --game ID [--recipient ROLE] [--parent ROLE]... [--history-cursor CURSOR]`                                                               | Inbox (recipient): capture the recipient's inbox snapshot.                                                                                                       |
| `inbox ack --game ID --snapshot UUID --queue-id ID... --disposition handled\|superseded\|retained [--reason TEXT] [--recipient ROLE] [--parent ROLE]...` | Inbox (recipient): acknowledge queue items from that snapshot. `retained` requires a reason.                                                                     |
| `claude ready`, `codex ready`                                                                                                                            | Harness: the handoff readiness probe (see [Readiness probe](#readiness-probe)).                                                                                  |
| `claude ready [--game ID]... [--role ROLE]...`, `codex ready [--game ID]... [--role ROLE]...`                                                            | Harness: probe the requested target adapter and conversations for an explicit subset.                                                                            |
| `harness ready [--game ID]... [--role ROLE]...`                                                                                                          | Harness: read-only readiness using each selected role's effective harness.                                                                                       |
| `harness select --harness claude\|codex\|default --expected-revision N [--game ID]... [--role ROLE]...`                                                  | Harness: atomic selection for at least one explicit game or role, without activation.                                                                            |
| `claude channel [--game ID]... [--conversation UUID] [--state-dir DIR]... [--poll-seconds N]`                                                            | Harness: the stdio MCP server the Claude recipient session starts.                                                                                               |
| `help`, `--help`, `--version`                                                                                                                            | Usage and version.                                                                                                                                               |

- `request`: `SAFE_ID` is 1 to 64 ASCII letters, digits, underscores or hyphens.
- `control`: game-dev writes desired control; Tech owns runner adoption. The command changes
  admission for subsequent departures without starting a runner or terminating an active batch.
  `reason` must be non-empty and `requester` resolves through the registry to a role. Stdout is
  the desired record as one JSON line.
- `status --game`: an unreadable `ci/`, `events/`, `requests/` or `gate-failed/` directory is a
  blocker, never an empty one, and a corrupt `runner.identity.json` reports `identity_status`
  `unreadable` with the `identity_unreadable` blocker. The runner loads `delivery-kit.json` once
  at startup; `config_status` is `loaded` while the file still matches, `changed` when it differs
  (the runner keeps the loaded copy until an idle restart), `unknown` when either digest is
  unavailable, and `null` without a current runner.
- `claude channel`: by default it drains every game's spool (or each `--game`) for the
  conversation of the `reports.recipient` those games name, and requires that role's effective
  harness to be `claude`. Games that name different recipients stop it with exit 1; select games
  with one recipient or pass `--conversation`. `--conversation UUID` and repeated absolute
  `--state-dir STATE/unblock` paths select the conversation and spools explicitly; `--state-dir`
  excludes `--game`. `--poll-seconds` defaults to 5. It creates no state directory and drains only
  spools that already exist, so it can start before any game state. Without `--conversation`, an
  absent registry stops it with exit 1.
- `inbox snapshot` and `inbox ack`: `--recipient` defaults to the game's `reports.recipient`.
  `--recipient` and `--parent` take a role name, or a canonical conversation UUID registered for
  the active harness. With Claude the recipient must be the active route's recipient and every
  parent a route member; with Codex every parent must belong to the active route. `--history-cursor` applies to
  Codex. An unreadable Claude channel spool is reported under the snapshot's `errors`, with
  `complete` false and exit 1; only a missing spool counts as empty.

Exit status is 0 on success, 1 for invalid configuration, a failed precondition, an unavailable
read or a refused runner start, and 2 for a usage error or an unexpected failure. `run` exits 130
on `SIGINT` and 143 on `SIGTERM`. Errors, a refused runner start and a refused request go to
stderr prefixed `delivery-kit:`. `inbox snapshot` and `inbox ack` keep their JSON result on
stdout and also name the error on stderr. `--help` is generated from each command's parser
options, so it lists every flag a command accepts.

## Configuration

Configuration never holds secret values. Use the operator's existing authentication and
credential references.

### game-dev `config.json`

Committed in game-dev, schema 1. Every path is relative to game-dev. See `examples/config.json`.

- `timezone` and `wakeMinutes` (integers 0 to 59): the scheduled review minutes. An empty
  `wakeMinutes` schedules no review.
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
  are accepted, provided the image has `sh`, `git`, `tar`, `ls` and `tail`; a departure names
  the tool an image lacks. An empty `install` skips the install step, and an empty `steps` list
  gates with no checks. A command that assigns a secret-like variable inline (for example `TOKEN=x npm ci`) is
  rejected. Every step is treated alike: each needs a unique name (a letter or digit, then up
  to 63 letters, digits, `_`, `.` or `-`), steps run in list order, and the first failure stops
  the gate. No step name has special meaning. The
  canonical order is `check`, `lint`, `test`, `build`, then any game-specific steps (such as
  `art`), so every game lists the shared steps the same way and opts into extras by adding them.
- `resources`: `cpus` (1 to 4) and `loadLimit` (0 to 30). A departure starts only below
  `loadLimit`, so 0 holds every departure.
- `ci`: `requiredNames` (a non-empty list of check names that must exist and pass for the exact
  pushed commit), `pollSeconds` (1 to 3600) and `timeoutSeconds` (1 to 86400).
- `deploy`: `mode` is `wrangler` or `none`; the optional `skipPattern` is a regular expression
  over the paths changed in the pushed range (the previous remote `main` to the pushed SHA). A push
  whose every changed path matches it skips deployment.
- `reports`: `project` (must equal the game's `name` in `config.json`), `scheduledTicks`, and
  `recipient` and `workerParents`, each a registered role key. `recipient` receives the game's
  events and, when the game hosts the route, its scheduled reviews.

## Registry

`var/registry.json` (schema 1) is shared by delivery-kit and the game-sessions skills. It records
ownership and the conversation ID of each role per harness. It never proves activation on its
own: `transfers` carries the hold, acceptance and activation markers.

| Field                             | Content                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `revision`, `updatedAt` | `1`, a non-negative integer incremented on every write, and a UTC timestamp.                                                                                                                  |
| `harness`                         | `claude` or `codex`: the default harness for roles without an override.                                                                                                                       |
| `host`                            | `nativeProjectId` and `root` (relative to game-dev).                                                                                                                                          |
| `roles.<key>`                     | `ownership`, `worktree` (relative to game-dev), `conversations` (`claude` and `codex`, each an ID or null), and optional `harness`, `branch`, `phase`, `activation` (`marker`, `checkpoint`). |
| `operations.<game>`               | `busOwner` (a role key), optional `activation.marker` and `lastAdoption` (`at`, `version`, `cliSha256`, optional `integrity`).                                                                |
| `transfers[]`                     | `marker`, `from`, `to`, `phase` (`source-held`, `accepted` or `active-confirmed`), `roles` and `checkpoint`.                                                                                  |

- Every role key must be a role key in `config.json`, and every `operations` key a game.
- Every role reference (`busOwner`, `reports.recipient`, `reports.workerParents`, `--requester`,
  `--role`, `--recipient`, `--parent`) is a registered role key; there are no aliases.
- Every writer holds `var/registry.lock`, rejects a changed `revision`, validates the result,
  writes durably and increments `revision`.
- The skills own every field except `operations.*.lastAdoption`, which is reserved for
  delivery-kit. The harness-selection CLI changes only selected roles' `harness` overrides and
  registry revision metadata; it preserves all other fields, including `operations`.

### Scoped harness selection

`roles.<role>.harness`, when present, is `claude` or `codex`. An absent override falls back to the
top-level `harness`, preserving the global-only schema 1 behaviour. Selection records an adapter
choice, not activation, target startup, ownership acceptance, delivery control or permission to
clear a hold or question. Changing selection requires the caller's explicit authority for that
exact scope.

Older schema 1 readers reject the new role field. Upgrade every reader of the shared registry
through a reviewed consumer pin before writing any override. A successful readiness probe does
not authorize adoption or mutation.

After explicit approval and the reader upgrades, probe the selected target and apply one atomic,
revision-checked selection, using the freshly read registry revision for `N`:

```sh
delivery-kit claude ready \
  --game archies-dog-walks \
  --game chibis-way-home
delivery-kit harness select \
  --harness claude \
  --expected-revision N \
  --game archies-dog-walks \
  --game chibis-way-home
```

Each `--game` selects every configured role for that game. Repeat `--role` to select additional
registered role names; the union is changed once. Missing or invalid roles,
an unknown game, an unavailable selected conversation ID, or a changed revision refuse the entire mutation. At least one scope is
required, so this command never implicitly switches the global default. `--harness default`
removes only the selected overrides. Unselected games, shared roles, conversation IDs, worktrees,
activation markers, operations, delivery state and schedules remain unchanged. No provider is
started and no runner is restarted by selection.

### Send-time resolution

Route, configuration, briefs and events name roles, never conversation IDs. Each wake, event
delivery, inbox snapshot, acknowledgement and readiness probe reads `var/registry.json` when it
sends: the role's optional `harness` override, otherwise the registry default, selects the adapter;
`roles.<role>.conversations.<effective harness>` gives the ID.
Nothing is cached across sends. A missing or null ID is reported `unavailable` for that role,
never as clearance.

A scoped harness handoff selects only its approved roles, with no configuration edit, runner
restart or delivery-state change. The other harness's IDs stay in place. Activation still needs
its separate hold, acceptance and activation checks.

Recipient decision records (`unblock/decisions/<conversation>.json`) stay keyed by conversation
ID, because a pending question belongs to one conversation. Their owner writes them; delivery-kit
only reads them, and a missing or invalid record is never clearance.

### Readiness probe

`claude ready` and `codex ready` send nothing and reports whether that adapter can deliver now:

- Claude: `claude agents --json` returns a listing.
- Codex: `CODEX_CONTROL_SOCKET` names an absolute socket path that accepts a connection.
- The route's recipient and every target, or every game's `reports.recipient` when there is no
  route, have a conversation ID for that harness. An invalid route is never ready.

Output is one JSON line:

```json
{
  "harness": "codex",
  "adapter": { "status": "available", "reason": null },
  "roles": [{ "role": "dev-manager", "conversation": "<uuid>", "status": "resolved" }],
  "ready": true
}
```

Unscoped `claude ready` and `codex ready` retain this output and probe every route role against
the requested target harness. With `--game` or `--role`, they probe only the selected roles and
add `current_harness` and `probed_harness` to each role row. Unselected games and kits need no
conversation ID for that target. Scopes never create or modify a registry entry.

`harness ready` probes the current effective harness for each selected role. Without a scope it
uses the route recipient and targets, or every game's recipient without a route. Its output contains
`harness: "mixed"`, an `adapters` object keyed by each required harness, the role rows with
`current_harness` and `probed_harness`, and `ready`. Each distinct adapter is probed once. Missing
IDs or unavailable adapter capabilities make the result not ready; an invalid selection fails
closed. These are adapter-and-conversation probes, not proof that questions, queues or ownership
checks are clear.

Readiness exits 0 when ready and 1 when not, including when the registry is missing or the layout
cannot be read. Malformed command options exit 2. It sends nothing and activates nothing.

## Review route

`var/route.json` (schema 2) names the scheduled review's host game and its targets by role:

```json
{
  "schema": 2,
  "state": "active",
  "host": "archies-dog-walks",
  "targets": ["archies-dog-walks/tech", "chibis-way-home/tech", "art-kit"]
}
```

- `state` is `active` or `held`. A held route, or no route, delivers no scheduled review, and a
  held route also defers events addressed to its recipient.
- `host` is the game whose runner dispatches the scheduled review at the `config.json`
  `wakeMinutes`. The review goes to the host's `reports.recipient`, which must be a role key in
  `config.json`.
- Every target must be a role key in `config.json`. Targets are distinct, an active route needs at
  least one target, and an active route's targets exclude its recipient.
- The file has exactly these four keys. A schema 1 route is refused with the edit it needs.

## Harness adapters

- **Claude:** briefs and events are spooled under the bus's `unblock/` directory with a `sending`
  receipt written first. `delivery-kit claude channel` claims each entry, delivers it once to the
  recipient session, records the delivery, marks the receipt `accepted`, then removes the entry. A
  `sending` receipt with no spool entry becomes `ambiguous` and is never resent. The channel server
  is configured in the recipient session's MCP settings; see `examples/claude-channel.mcp.json`.
- **Codex:** turns are steered through the control socket at `CODEX_CONTROL_SOCKET`, which must be
  set to an absolute path, with the same receipt rules. Without it Codex delivery is deferred.

Claude session listings do not provide native history, queue contents or authoritative question
state. Unavailable capabilities remain explicitly unknown. A Claude conversation ID is never
queried through Codex, and unavailable native data is never presented as an empty queue or as
permission to acknowledge work. Mixed selection preserves exact payload guards, ambiguous-delivery
handling and the existing same-slot review deduplication.

Mixed inbox snapshots expose `harnesses` (the provider per conversation), `native_queues`
(native queue availability), `channel_queues` (delivered local-channel entries) and `queue_sources`
(inventory origin). `complete` means the requested available inventories were collected without
actual collection errors, preserving the legacy exit-0 success semantics. It proves neither
native visibility nor clearance.

CLI `channel_queues` rows expose only `count`, `queue_ids` and `status`. Full original payloads
remain in the persisted snapshot for acknowledgement validation and are not printed on stdout.

`native_complete` is true only when every requested recipient is Codex and its native queue was
captured. Any requested Claude recipient makes it false, even when its available delivered-channel
inventory is empty. An unrequested Claude peer's diagnostics do not make a Codex recipient's
`native_complete` false. Unsupported Claude APIs remain explicitly unknown; their absence adds
neither collection errors nor scheduled-wake blockers. Actual inventory collection failures remain
errors.

`CLAUDE_BIN` overrides the `claude` executable. Events dedupe on `sha256(kind:key)`, and every
`blocked-*` kind shares one identity, so a changed block reason is not reported again. Each
`blocked-*` report states its own remedy: `blocked-load` clears by itself, `blocked-gate` is gated
again at the next departure, `blocked-fetch` and a failed push are retried, a red gate needs a fix
merged on main, a non-fast-forward needs Tech to merge the remote `main`, and an unreadable local
`main` needs an operator fix. Events are
delivered in creation order and marked sent only after the adapter accepts them; the first
refusal stops a flush and the next flush resumes there.

## State

All mutable state lives in game-dev's ignored `var/`:

- `registry.json` and `registry.lock`.
- `route.json`: the review route.
- `handoffs/<scope>/`: checkpoints the registry references.
- `game-dev/`: review and inbox snapshots, health history, acknowledgements and retentions.
- `games/<g>/bus/`: the bus. It holds `runner.lock`, `loop.lock`, `departure.lock`,
  `active-departure`, `gate-failed/`, the detached `gate-<sha>` worktree kept for a pending
  deployment, `gate-logs/`, `ci/`, `deploy/`, `deploy-pending`, `last-push*`, `last-deploy*`,
  `events/`, `requests/`, `unblock/` (the delivery spool), `runner.json`, `runner.identity.json`,
  `resources.log`, `runner.log`, `delivery-control.json` and `control.lock`.

The gate's npm cache is the Docker volume `delivery-kit-npm-<game>`.

Every state write is a temp file, fsync, rename, then a directory fsync. Locks are `flock(1)` on
files under `var/`. Runners read `<game>/delivery-kit.json` and write only to their own
`var/games/<g>/bus/`. delivery-kit writes nothing under any `.claude/` directory.

### Desired and observed delivery control

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

### Adopt persistent control

Tech installs the upgraded package and replaces its runner only while idle. Before starting
the new runner, game-dev uses the upgraded CLI to explicitly initialize the approved desired
states. An older installed CLI does not implement `control`:

```bash
delivery-kit control --game archies-dog-walks --state paused \
  --reason 'Approved initial Archie pause' --requester dev-manager
delivery-kit control --game chibis-way-home --state enabled \
  --reason 'Approved initial Chibi enablement' --requester dev-manager
```

These are explicit adoption operations, not built-in defaults. Preserve an existing upgraded
control record and its desired state on later upgrades. Check `status` before and after Tech's
idle replacement, including singleton identity, desired/observed control, drain state and
blockers. Observe the next normal scheduled slot; adoption starts no manual departure.

## Resident runner

Launch one runner per game from that game's canonical checkout, in its own session, so it
resolves the game's own `node_modules`:

```bash
cd /absolute/path/to/game \
  && DELIVERY_KIT_ROOT=/absolute/path/to/game-dev setsid npx delivery-kit run --game GAME_ID
```

The runner holds `runner.lock` and `loop.lock` (a second runner is refused), records its identity,
and runs the scheduled and requested departure loop, the 60 s observer (scheduled reviews,
scheduled-slot reports and event flushes), the 1800 s resource sampler and the CI watches
in-process. No timer outlives it, and no systemd unit, cron entry or other timer is involved. A
missed scheduled slot is never replayed.

Each distinct scheduled review slot attempts a guarded review, including when queues are empty,
unchanged since an accepted review, or explicitly retained. Accepted inventory signatures are
health diagnostics, not permission to suppress later scheduled reviews. Repeated observations
of the same slot use its persisted receipt without another send; an interrupted send becomes
ambiguous and is never resent. An explicit stale-turn rejection permits one refreshed attempt.
Queue inventory errors block the review, and recipient clearance and native question guards
still apply. Worker failure and question notice deduplication remain independent of the review.
Acceptance does not acknowledge queue work: acknowledgements still validate unchanged originals,
and retention remains bound to the exact payload.

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
a real merge or a fast-forward, and never pushes. There is no queue, batch merge,
cherry-pick, rewrite or revert. Each scheduled or requested departure, under `departure.lock`:

1. Restarts the CI watch of the pending deployment or the last push when it timed out or lost
   GitHub authentication, then retries a pending deployment whose CI has passed.
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

- **Fix forward:** a red gate (install or a gate step exiting non-zero inside the running
  container) leaves `main` unpushed and records `gate-failed/<sha>`, so that SHA is never gated
  again; the next departure runs once Tech merges a fix. Red CI or a failed deployment is fixed the
  same way, with no automatic CI rerun.
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
  rules and receipts. A HEAD that is the last pushed SHA or failed its gate is refused, and a
  request whose HEAD moved before it departs is rejected.

### Gate container

One container per gated SHA, named `delivery-kit-gate-<game>-<short sha>` and labelled
`delivery-kit-gate=<game>`:

- runs `gate.image` as `--user 19001:19001` with `HOME=/tmp`, `--group-add` of the worktree's
  group and `--cpus` from `resources.cpus`;
- binds the worktree read-only at `/src` (`--mount type=bind,...,readonly`) and the npm cache
  volume at `/var/tmp` (`npm_config_cache=/var/tmp/npm`), and sets `WORKERS_CI_COMMIT_SHA`;
- checks that the image has `git`, `tar`, `ls` and `tail`, then copies `/src` without `.git`
  into `/tmp/work` and checks that the copy's tree is the commit's tree;
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
`run` and `status --resources` honour them; an invalid value stops the command.

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
  `UnknownRole` for a name that is not a registered role key.
- `resolveHarness(registry, role)` returns a registered role's override or the registry default.
  `selectHarness(layout, expectedRevision, {harness, games?, roles?}, options?)` validates the
  entire explicit selection and changes only those overrides under `registry.lock`.
- `RegistrySchema`, `validateRegistry`, `HARNESSES` and `TRANSFER_PHASES`, with the record types.

## Upgrading to 3.0

3.0.0 removes duties and the route's `monitor` field. A game's scheduled review goes to the role
its `delivery-kit.json` names as `reports.recipient`, the same role that receives its events.
A 2.x reader cannot use a schema 2 route or resolve a duty after the edits, so every pin (each
game and game-dev) moves to 3.0.0 in the same idle replacement window.

- `var/registry.json`: remove `duties` from every role, and replace each duty name with the role
  key that held it, in `operations.<game>.busOwner` and anywhere else a role is named. A role that
  still has `duties` fails validation with this edit. The registry schema stays 1.
- `var/route.json`: remove `monitor` and set `schema` to 2. The host game's `reports.recipient`
  receives the review. A schema 1 route defers every review and is reported by `check-config`.
- Each `delivery-kit.json`: `reports.recipient` and `reports.workerParents` name registered role
  keys (for example `dev-manager`), never a duty.
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

### Removed command forms

A removed form exits 2 with a one-line hint naming its replacement; there are no aliases.

| Removed form                             | Removed in | Current form                         |
| ---------------------------------------- | ---------- | ------------------------------------ |
| `channel ...`                            | 2.0.0      | `claude channel ...`                 |
| `monitor-snapshot ...`                   | 2.0.0      | `inbox snapshot ...`                 |
| `monitor-ack ...`                        | 2.0.0      | `inbox ack ...`                      |
| `resource-report --game ID`              | 2.0.0      | `status --game ID --resources`       |
| `status --harness claude`                | 2.0.0      | `claude ready`                       |
| `status --harness codex`                 | 2.0.0      | `codex ready`                        |
| `request --game ID --request-id ID`      | 2.0.0      | `request --game ID --id ID`          |
| `migrate ...`, `migrate --remove-legacy` | 2.0.0      | removed; upgrade 0.9.x through 1.0.3 |
| `monitor snapshot ...`                   | 3.0.0      | `inbox snapshot ...`                 |
| `monitor ack ...`                        | 3.0.0      | `inbox ack ...`                      |
| `claude channel --monitor UUID`          | 3.0.0      | `claude channel --conversation UUID` |

## Development

`make check` runs the complete gate in stock images: the Node version pinned in `.nvmrc` and
`koalaman/shellcheck:v0.11.0`. `make lint`, `make test` and `make build` run one category. No
image is built. Each container binds the checkout read-only, runs as the host user with four
CPUs and 4 GiB memory (`CHECK_MEMORY`), a read-only root filesystem and no capabilities. The
Node container copies the source without `.git`, dependencies or build output into tmpfs,
installs the root and contract dependencies with `npm ci`, then runs the native npm checks.
ShellCheck reads the bound source directly with no network.

Native npm commands run directly wherever they are invoked. Local prerequisites are the
pinned Node version, root and contract dependencies, and ShellCheck 0.11.0.
Install dependencies with `npm ci` and `npm --prefix tests/contract ci`.

WORKAROUND: root overrides keep `markdownlint-cli2` 0.24.0 on patched Markdown and math
dependencies for [GHSA-gg6h-894w-4m9c](https://github.com/advisories/GHSA-gg6h-894w-4m9c)
and [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
Remove them when upstream resolves the patched versions without overrides.

| Command                 | Checks                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `make check`            | Complete verification in stock Node and ShellCheck images.                                               |
| `npm run verify`        | Root and contract types, lint, wrapper syntax, build, unit tests, full contracts and package inspection. |
| `npm run check`         | Root and contract types.                                                                                 |
| `npm run lint`          | Prettier, ESLint, Markdown and ShellCheck with `-x -P SCRIPTDIR`.                                        |
| `npm run build`         | Build the CLI and registry bundles and declarations.                                                     |
| `npm test`              | Unit tests, using at most four workers by default; build first.                                          |
| `npm run contract`      | Build, contract types and the complete native contract suite.                                            |
| `npm run package:check` | Inspect built package contents, CLI version and registry declarations/exports.                           |

Explicit source or contract paths passed to `npm run verify --` select the corresponding
suite; unscoped filters apply to both. Standalone `npm run contract -- --lock` regenerates
the contract lockfile with native npm. Ordinary Git commits run serial local lint-staged,
with direct Prettier and ESLint fixes that preserve Git's staged/unstaged workflow.

CI runs the same native npm commands directly on the runner with the pinned Node version and
the pinned ShellCheck step.

Package inspection always reports `immutableCommitClaim: false`. Snapshot metadata retains
`CHECK_REVISION`, `CHECK_SOURCE_SHA256` and `CHECK_SOURCE_DIRTY` when supplied; native
inspection without that metadata invents no commit or source hash. Inspection writes its
archive and `CHECK_CONTEXT.json` to a fresh temporary directory and prints that location.

The thin wrappers `scripts/check.sh` and `tests/contract/run.sh` invoke native Node helpers.
The separately invoked `npm run pack -- EXACT_COMMIT_SHA /new/absolute/directory` is the
explicit host release-controller exception: it archives the requested commit and starts
its own offline release container with the pinned Node image and the read-only
`delivery-kit-npm-check` cache volume (`DELIVERY_KIT_NPM_VOLUME` names another); a missing
volume or dependency fails without fallback. The controller retains the source epoch and copies
the exact revision's `SOURCE_COMMIT` and `SHA256SUMS` out with the archive. CI fills the cache
volume from the lockfile, then invokes this controller after the checks.

## Compatibility and releases

`VERSION` and `package.json` carry the version, and `pack` refuses a mismatch. The CLI,
`delivery-kit.json`, `config.json`, the registry schema, the route schema, the registry module API
and the `var/` layout follow semver: an incompatible change needs a major version. 2.0.0 removes
the `migrate` command; a 0.9.x installation upgrades through 1.0.3 first.

A release is three files from `pack`:

- `delivery-kit-VERSION.tgz`, the npm package (`dist/`, `README.md`, `LICENSE`, `SOURCE_COMMIT`);
- `SOURCE_COMMIT`, the exact commit it was built from, also inside the archive;
- `SHA256SUMS`, covering the archive and `SOURCE_COMMIT`.

The release owner pushes the release commit to `main`, verifies every required CI workflow
succeeded for that exact commit, then tags `vVERSION` there and attaches the `pack` output. A
published tag is never moved.

## Licence

MIT; see `LICENSE`. The licence does not cover consumer art assets or game values.
