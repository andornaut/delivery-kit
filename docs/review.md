# Review route and harness adapters

The scheduled review route `var/route.json` and how the Claude and Codex adapters deliver briefs and events.

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
`blocked-*` report states its own remedy: `blocked-load` (a load still at or above `loadLimit` 15
minutes after the slot) clears by itself, `blocked-gate` is gated again at the next departure,
`blocked-fetch` and a failed push are retried, a red gate needs a fix merged on main, a
non-fast-forward needs Tech to merge the remote `main`, and an unreadable local `main` needs an
operator fix. Events are delivered in creation order and marked sent only after the adapter
accepts them; the first refusal stops a flush and the next flush resumes there.
