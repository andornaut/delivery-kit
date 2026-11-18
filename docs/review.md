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

The runner records each bus event through coordination-kit's event outbox and adds its own
per-commit tracking under the outbox lock: a pushed commit with CI success and a finished
deployment gets one `complete` event, which names a skipped gate for a docs-only departure. Each
observer pass and each recorded event request the coordinator root's `coordination-kit events
flush`, which delivers the outbox to the game's `reports.recipient`.

Events dedupe on `sha256(kind:key)`, and every `blocked-*` kind shares one identity, so a
changed block reason is not reported again. Each `blocked-*` report states its own remedy:
`blocked-load` (a load still at or above `loadLimit` 15 minutes after the slot) clears by
itself, `blocked-gate` is gated again at the next departure, `blocked-fetch` and a failed push
are retried, a red gate needs a fix merged on main, a non-fast-forward needs Tech to merge the
remote `main`, and an unreadable local `main` needs an operator fix. Events are delivered in
creation order and marked sent only after the adapter accepts them; the first refusal stops a
flush and the next flush resumes there.

Reference: [coordination-kit review](https://github.com/andornaut/coordination-kit/blob/main/docs/review.md),
[upgrading to 6.0](upgrading.md#upgrading-to-60).
