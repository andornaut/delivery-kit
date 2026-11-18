# Commands

Per-command semantics for the `delivery-kit` CLI, beyond the command table in the [README](../README.md#commands), and worker inbox reconciliation.

## Command semantics

- `request`: `SAFE_ID` is 1 to 64 ASCII letters, digits, underscores or hyphens.
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
  the active harness, with the worker recipient exception below. With Claude the recipient must
  be the active route's recipient, whose parents may be any route member, or a registered route
  target whose selected harness is Claude. A route target's snapshot and ACK cover only its own
  delivered entries and retentions, with no peer or target rows, and its snapshot accepts no other
  conversation as a parent. Any other Claude recipient is refused. With Codex every parent must
  belong to the active route. `--history-cursor` applies to Codex. An unreadable Claude channel
  spool is reported under the snapshot's `errors`, with
  `complete` false and exit 1; only a missing spool counts as empty.

## Worker inbox reconciliation

The 4.1.0 candidate adds worker inbox reconciliation; using it requires a reviewed package pin
containing this support. Public 4.0.0 lacks the supported worker path and rejects unregistered
worker UUIDs. Candidate status does not establish publication or adoption.
Use the existing inbox commands with a canonical worker UUID and exactly one registered parent
role whose current Codex conversation belongs to the active review route:

```bash
delivery-kit inbox snapshot --game GAME_ID \
  --recipient WORKER_UUID --parent REGISTERED_ROLE
delivery-kit inbox ack --game GAME_ID \
  --recipient WORKER_UUID --parent REGISTERED_ROLE \
  --snapshot SNAPSHOT_UUID --queue-id QUEUE_ID --disposition handled
```

Snapshot capture verifies fresh native Codex lineage against that exact parent and persists the
worker/parent binding. ACK requires the same binding and uses one connection to verify lineage on
open, inspect the current queue and recheck lineage immediately before deletion. Wrong parents,
reparenting or refused reads fail closed and preserve originals. Unchanged-payload and ambiguous
acknowledgement guards remain in force. Use `handled` or `superseded` only with evidence; use
`--disposition retained --reason TEXT` for retained work. This is explicit owner reconciliation, not automatic
worker deletion; it never forces session loads or mutates native question state. Unavailable
visibility remains unknown and must be reported, without bypassing refusals.
