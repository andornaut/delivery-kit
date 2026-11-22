# Commands

Per-command semantics for the `delivery-kit` CLI, beyond the command table in the [README](../README.md#commands), and the commands that moved to coordination-kit.

## Command semantics

- `request`: `SAFE_ID` is an ASCII letter or digit, then up to 63 letters, digits, underscores or
  hyphens.
- `control`: `game-coordinator` writes desired control; Tech owns runner adoption. The command changes
  admission for subsequent departures without starting a runner or terminating an active batch.
  `reason` must be non-empty and `requester` resolves through the registry to a role. Stdout is
  the desired record as one JSON line.
- `status --game`: an unreadable `ci/`, `requests/` or `gate-failed/` directory or event log is
  a blocker, never an empty one, and a corrupt `runner.identity.json` reports `identity_status`
  `unreadable` with the `identity_unreadable` blocker. The runner loads `delivery-kit.json` once
  at startup; `config_status` is `loaded` while the file still matches, `changed` when it differs
  (the runner keeps the loaded copy until an idle restart), `unknown` when either digest is
  unavailable, and `null` without a current runner.
  `observer_adoption` is `current`, `stale` or `unknown`, derived from bus/ alone: `current` when
  the latest `runner.started` carries the running token, the cursor shows that line ingested and
  the last seen coordinator CLI is in range, and `stale` when that token differs.
  `observer_adoption_reason` is null for `current` and otherwise one of `runner_not_current`,
  `log_unreadable`, `no_runner_started`, `token_differs`, `cli_unseen`, `cli_out_of_range` or
  `not_ingested`; see [Observer adoption](runner.md#observer-adoption). `coordination_kit` reports the bundled
  coordination-kit version and the supported range; see [Pin guard](runner.md#pin-guard).
  `coordinator_cli` reports the last coordinator CLI identity a seam result carried, from
  `bus/seam.json`: `{version, distSha256, seenAt, supported}`, where `supported` tests `version`
  against `>=3.0.0 <5.0.0`, and every field is null before the runner has seen one; see
  [Coordinator CLI seam](runner.md#coordinator-cli-seam).
  `events` reads the event log and its cursor, read-only: `{file, size, cursorOffset, rotated,
torn, drained}`. `size` is 0 without a log and null when unreadable, `cursorOffset` is null
  without a valid cursor, `rotated` lists rotated logs awaiting ingest, `torn` is true while the
  last line has no newline, and `drained` is true when the cursor names the live log and reaches
  its end, with no rotated log and no torn line. Its reporter blockers are `events_uningested:BYTES`, `events_rotated:N`,
  `events_torn`, `events_cursor_invalid`, `events_cursor_ahead`, `events_cursor_rotated` (the
  cursor names a rotated log), `events_cursor_unmatched` (it names no file present),
  `events_unreadable` and `events_dir_unreadable`. The reporter blocker `events_legacy_outbox`
  indicates a 6.0 `bus/events` outbox that needs the [6.1.2 migration](upgrading.md#upgrading-to-80).
  `events_legacy_outbox_unreadable` means the path could not be checked. Top-level `drained`
  requires no reporter or idle blockers. See [Event log](runner.md#event-log).
- `runner stop --game ID [--timeout SECONDS]`: waits up to `SECONDS` (default 900) until the
  runner is idle and drained, then stops it through its active systemd user unit or with
  `SIGTERM` to the `runner.json` PID while that PID holds the runner identity token, and waits
  for `runner.lock` and `loop.lock` to be free. Stdout is one JSON line
  `{schema, game, pid, method, stopped, locksFree}` with `method` `systemd`, `signal` or `none`.
  Exit 0 when stopped with the locks free or when no runner runs; 1 on a timeout, a PID that does
  not hold the identity or a runner that does not exit, leaving the runner untouched in the first
  two cases. A `--timeout` that is not a positive whole number is a usage error. See
  [Supervision](runner.md#supervision).
- `run --game ID`: exits 3 before writing runner state if the legacy outbox check fails.
- `runner start --game ID`: exits 1 and starts nothing while either lock is held or the legacy
  outbox check fails. Starts the systemd user unit when its file is installed, otherwise spawns
  the game's installed `dist/cli.js run --game ID` detached with output appended to
  `bus/runner.out`. Stdout is one JSON line `{schema, game, pid, method, status}` with
  `method` `systemd` or `spawn` and `status`
  `{running, idle, coordinator_cli}`; a runner that is not up within 30 s exits 1.
- `runner unit`: prints the systemd user unit for the game's resident runner to stdout and writes
  nothing: no unit file, no `systemctl` call. It resolves the coordinator root, the game's
  canonical checkout and installed `dist/cli.js`, the running Node binary and the directories of
  `gh`, `docker`, `git`, `flock` and `claude` on `PATH`. A missing installed CLI or tool exits 1
  with no stdout. Install and upgrade steps are in [Supervision](runner.md#supervision).

## Moved commands

The `inbox`, `message`, `ledger`, `harness`, `protocol`, `claude` and `codex` groups moved to
Coordination Kit in 5.0. From 8.0, their former Delivery Kit forms exit 2 with standard usage.
See the command mapping in [Upgrading to 5.0](upgrading.md#upgrading-to-50).
