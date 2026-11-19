# Review and events

What the resident runner hands to the coordinator-installed coordination-kit CLI: the scheduled review slots and the bus events.

## Scheduled reviews

The review route `var/route.json`, the brief, the inbox inventory and the Claude and Codex
adapters are coordination-kit's. The runner's observer decides when a `config.json`
`wakeMinutes` slot is due and spawns the coordinator root's `coordination-kit review deliver` for
it, which decides whether this game hosts the route, delivers the brief and records the slot.
`check-config` still validates `var/route.json`. Cadence, the observer and the seam are in
[runner.md](runner.md#coordinator-cli-seam).

## Events

The runner appends each bus event to `bus/events.jsonl` ([Event log](runner.md#event-log)). Each
observer pass and each appended event request the coordinator root's `coordination-kit events
ingest`, which stores new lines, advances `bus/events.cursor`, delivers the events to the game's
`reports.recipient` and forms each commit's COMPLETE report.

Events are appended at most once per `(type, key)`. Each `blocked-*` report states its own remedy:
`blocked-load` (a load still at or above `loadLimit` 15 minutes after the slot) clears by
itself, `blocked-gate` is gated again at the next departure, `blocked-fetch` and a failed push
are retried, a red gate needs a fix merged on main, a non-fast-forward needs Tech to merge the
remote `main`, and an unreadable local `main` needs an operator fix.

Reference: [coordination-kit review](https://github.com/andornaut/coordination-kit/blob/main/docs/review.md),
[upgrading to 6.1](upgrading.md#upgrading-to-61).
