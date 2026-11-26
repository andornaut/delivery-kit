# Commands

Per-command semantics for the `delivery-kit` CLI, beyond the command table in the [README](../README.md#commands), and the commands that moved to coordination-kit.

## App-mode authorization

In an `apps` workspace, `run`, `runner start`, `runner stop`, `request` and `control`
require an active registry binding for the caller's exact native conversation ID
(`CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`). Its role must match
`operations.<appId>.busOwner` and have `delivery:operate` for the app. `run` and
`runner start` also require `review:deliver` and `events:ingest` for the same app.
`control --requester ROLE` must match the resolved caller role.

Both selector spellings apply these checks before mutation. A legacy `games` workspace
retains its existing operating rules, including the registered requester on `control`.
See [Configuration](configuration.md#app-mode) to declare the grants and
[Supervision](runner.md#supervision) to provision the resident's environment.

## Command semantics

- `request` takes a `SAFE_ID` starting with an ASCII letter or digit, followed by up to 63
  ASCII letters, digits, underscores or hyphens. Reusing an ID returns its existing receipt.
  An invalid ID exits 1. Omitting `--id` exits 2.
- `control` persists the desired state approved for the app. The command changes
  admission for subsequent departures without starting a runner or terminating an active batch.
  `reason` must be non-empty and `requester` resolves through the registry to a role. Stdout is
  the desired record as one JSON line.
- `status --app ID --resources` prints the resource report in place of the JSON status.
- `status --app ID`: an unreadable `ci/`, `requests/` or `gate-failed/` directory or event log is
  a blocker, never an empty one, and a corrupt `runner.identity.json` reports `identity_status`
  `unreadable` with the `identity_unreadable` blocker. The runner loads `delivery-kit.json` once
  at startup; `config_status` is `loaded` while the file still matches, `changed` when it differs
  (the runner keeps the loaded copy until an idle restart), `unknown` when either digest is
  unavailable, and `null` without a current runner.
  The JSON report includes `appId` with the primary selector. The legacy selector preserves its original report.
  `observer_adoption` is `current`, `stale` or `unknown`, derived from bus/ alone: `current` when
  the latest `runner.started` carries the running token, the cursor shows that line ingested and
  the last seen coordinator CLI is in range, and `stale` when that token differs.
  `observer_adoption_reason` is null for `current` and otherwise one of `runner_not_current`,
  `log_unreadable`, `no_runner_started`, `token_differs`, `cli_unseen`, `cli_out_of_range` or
  `not_ingested`; see [Observer adoption](runner.md#observer-adoption). `coordination_kit` reports the bundled
  coordination-kit version and the supported range; see [Pin guard](runner.md#pin-guard).
  `coordinator_cli` reports the last coordinator CLI identity a seam result carried, from
  `bus/seam.json`: `{version, distSha256, seenAt, supported}`, where `supported` tests `version`
  against the workspace's supported CLI range, and every field is null before the runner has seen one; see
  [Coordinator CLI seam](runner.md#coordinator-cli-seam).
  `events` reports `{file, size, cursorOffset, rotated, torn, drained}`. `size` is 0 without a log
  and null when unreadable. `cursorOffset` is null without a valid cursor. `rotated` lists logs
  awaiting ingest, and `torn` is true when the last line has no newline. `events.drained` is true
  when the log and cursor have no blockers. An absent or empty log can be drained without a
  cursor when the bus directory is readable. Reporter blockers include `events_uningested:BYTES`,
  `events_rotated:N`,
  `events_torn`, `events_cursor_invalid`, `events_cursor_ahead`, `events_cursor_rotated` (the
  cursor names a rotated log), `events_cursor_unmatched` (it names no file present),
  `events_unreadable` and `events_dir_unreadable` (the bus directory is missing or unreadable). The reporter blocker `events_legacy_outbox`
  indicates a 6.0 `bus/events` outbox that needs the [6.1.2 migration](upgrading.md#upgrading-to-80).
  `events_legacy_outbox_unreadable` means the path could not be checked. Top-level `drained`
  requires no reporter or idle blockers. See [Event log](runner.md#event-log).
- `runner stop --app ID [--timeout SECONDS]`: waits up to `SECONDS` (default 900) until the
  runner is idle and drained, then stops it through its active systemd user unit or with
  `SIGTERM` to the `runner.json` PID while that PID holds the runner identity token. After the
  stop action it waits up to another 150 s for `runner.lock` and `loop.lock` to be free. The
  result is one JSON line `{schema, appId, pid, method, stopped, locksFree}` with `method`
  `systemd`, `signal` or `none`.
  Exit 0 when stopped with the locks free or when no runner runs; 1 on a timeout, a PID that does
  not hold the identity or a runner that does not exit, leaving the runner untouched in the first
  two cases. `--timeout` accepts 1 to 9999999 seconds in decimal without leading zeros. See
  [Supervision](runner.md#supervision).
- `run --app ID`: exits 3 before writing runner state if the legacy outbox check fails. A
  refused singleton start also exits 3.
- `runner start --app ID`: exits 1 and starts nothing while either lock is held or the legacy
  outbox check fails. Starts the systemd user unit when its file is installed, otherwise spawns
  the app's installed Delivery Kit CLI detached with output appended to
  `bus/runner.out`. Stdout is one JSON line `{schema, appId, pid, method, status}` with
  `method` `systemd` or `spawn` and `status`
  `{running, idle, coordinator_cli}`. After the launch call returns, the command waits up to
  30 s to attest startup. It exits 1 if attestation fails.
- `runner unit`: prints the systemd user unit for the app's resident runner to stdout and writes
  nothing: no unit file, no `systemctl` call. It resolves the workspace root, the app's
  canonical checkout and installed `dist/cli.js`, the running Node binary and the directories of
  `gh`, `docker`, `git`, `flock` and `claude` on `PATH`. A missing installed CLI or tool exits 1
  with no stdout. Install and upgrade steps are in [Supervision](runner.md#supervision).

## Moved commands

The `inbox`, `message`, `ledger`, `harness`, `protocol`, `claude` and `codex` groups moved to
Coordination Kit in 5.0. From 8.0, their former Delivery Kit forms exit 2 with standard usage.
See the command mapping in [Upgrading to 5.0](upgrading.md#upgrading-to-50).
