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
  `observer_adoption` compares the running identity token with the last observer adoption; see
  [Observer adoption](runner.md#observer-adoption). `coordination_kit` reports the bundled
  coordination-kit version and the supported range; see [Pin guard](runner.md#pin-guard).
  `coordinator_cli` reports the last coordinator CLI identity a seam result carried, from
  `bus/seam.json`: `{version, distSha256, seenAt, supported}`, where `supported` tests `version`
  against `>=2.0.1 <3.0.0`, and every field is null before the runner has seen one; see
  [Coordinator CLI seam](runner.md#coordinator-cli-seam).
  `events` reads the event log and its cursor, read-only: `{file, size, cursorOffset, rotated,
torn, drained}`. `size` is 0 without a log and null when unreadable, `cursorOffset` is null
  without a valid cursor, `rotated` lists rotated logs awaiting ingest, `torn` is true while the
  last line has no newline, and `drained` is true when the cursor names the live log and reaches
  its end, with no rotated log and no torn line. Its reporter blockers are `events_uningested:BYTES`, `events_rotated:N`,
  `events_torn`, `events_cursor_invalid`, `events_cursor_ahead`, `events_cursor_rotated` (the
  cursor names a rotated log), `events_cursor_unmatched` (it names no file present),
  `events_unreadable` and `events_dir_unreadable`, plus `events_legacy_outbox` while a 6.0 `events/` outbox awaits import.
  `drained` at the top level also requires no idle blocker; see [Event log](runner.md#event-log).
- `runner unit`: prints the systemd user unit for the game's resident runner to stdout and writes
  nothing: no unit file, no `systemctl` call. It resolves the coordinator root, the game's
  canonical checkout and installed `dist/cli.js`, the running Node binary and the directories of
  `gh`, `docker`, `git`, `flock` and `claude` on `PATH`. A missing installed CLI or tool exits 1
  with no stdout. Install and upgrade steps are in [Supervision](runner.md#supervision).

## Moved commands

The `inbox`, `message`, `ledger`, `harness`, `protocol`, `claude` and `codex` groups moved to
coordination-kit in 5.0. delivery-kit refuses each with exit 2 and a one-line hint naming the
equivalent command, for example:

```text
delivery-kit: `protocol status` moved to coordination-kit; run `coordination-kit protocol status ...`
```

The hint names the group and, for a verb that group had, the verb. Options, JSON output and exit
codes are unchanged under `coordination-kit`. The mapping is in
[Upgrading to 5.0](upgrading.md#upgrading-to-50).
