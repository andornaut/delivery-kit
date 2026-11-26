# Review and events

What the resident runner hands to the coordinator-installed coordination-kit CLI: the scheduled review slots and the bus events.

## Scheduled reviews

The review route `var/route.json`, the brief, the inbox inventory and the Claude and Codex
adapters are coordination-kit's. The runner's observer decides when a `config.json`
`wakeMinutes` slot is due and spawns the coordinator root's `coordination-kit review deliver` for
it. Coordination Kit resolves the route, stores the brief for the recipient when due and
records the slot result. `check-config` validates `var/route.json` when present. Cadence, the
observer and the seam are in
[runner.md](runner.md#coordinator-cli-seam).

The observer keeps the exact slot epoch in memory when the CLI returns a valid deferred
`compaction-reserved` result. On each existing minute pass it attempts a fresh due slot first,
then retries at most one older pending slot with its original `--slot`. Another
`compaction-reserved` deferral retains the slot. Any other outcome, including an ambiguous
receipt or a failed CLI call, ends the retry. Starting the runner begins with an empty retry
queue and skips scheduled slots already underway or missed. Coordination Kit owns the durable
result and deduplication for each slot.

## Events

The runner appends each bus event to `bus/events.jsonl` ([Event log](runner.md#event-log)). Each
observer pass and each appended event request the coordinator root's `coordination-kit events
ingest`. Coordination Kit stores the events and advances `bus/events.cursor`. It sends the
named recipient actionable outcomes and one COMPLETE report for each successful departure.
Routine progress stays in event history.

Events are appended at most once per `(type, key)`. Each `blocked-*` report states its own remedy:
`blocked-load` skips the attempt when its 15-minute load window expires at or above
`loadLimit`. A later departure can retry `blocked-load`, `blocked-gate`, `blocked-fetch` and
transient push failures. A red gate needs a fix merged on main, a non-fast-forward needs Tech
to merge the remote `main`, and an unreadable local `main` needs an operator fix.

Reference: [coordination-kit review](https://github.com/andornaut/coordination-kit/blob/main/docs/review.md),
[upgrading to 6.1](upgrading.md#upgrading-to-61).
