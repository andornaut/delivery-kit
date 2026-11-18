# Commands

Per-command semantics for the `delivery-kit` CLI, beyond the command table in the [README](../README.md#commands), and the commands that moved to coordination-kit.

## Command semantics

- `request`: `SAFE_ID` is an ASCII letter or digit, then up to 63 letters, digits, underscores or
  hyphens.
- `control`: `game-coordinator` writes desired control; Tech owns runner adoption. The command changes
  admission for subsequent departures without starting a runner or terminating an active batch.
  `reason` must be non-empty and `requester` resolves through the registry to a role. Stdout is
  the desired record as one JSON line.
- `status --game`: an unreadable `ci/`, `events/`, `requests/` or `gate-failed/` directory is a
  blocker, never an empty one, and a corrupt `runner.identity.json` reports `identity_status`
  `unreadable` with the `identity_unreadable` blocker. The runner loads `delivery-kit.json` once
  at startup; `config_status` is `loaded` while the file still matches, `changed` when it differs
  (the runner keeps the loaded copy until an idle restart), `unknown` when either digest is
  unavailable, and `null` without a current runner.
  `observer_adoption` compares the running identity token with the last observer adoption; see
  [Observer adoption](runner.md#observer-adoption). `coordination_kit` reports the bundled
  coordination-kit version and the supported range; see [Pin guard](runner.md#pin-guard).
  `coordinator_cli` reports the last coordinator CLI identity a seam result carried, from
  `bus/seam.json`: `{version, distSha256, seenAt, supported}`, where `supported` tests `version`
  against `>=1.2.0 <2.0.0`, and every field is null before the runner has seen one; see
  [Coordinator CLI seam](runner.md#coordinator-cli-seam).
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
