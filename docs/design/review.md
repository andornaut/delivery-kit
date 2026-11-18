# Review

`var/route.json` names the scheduled review's host game and its target roles. The host game's
runner sends each scheduled review to that game's `reports.recipient` at the `config.json`
`wakeMinutes`. Each game sends its events to its own `reports.recipient`. A held route, or no
route, delivers no scheduled review.

The Claude adapter spools briefs and events for `claude channel` while the recipient session is
listed as interactive. The Codex adapter steers turns through the control socket. Inbox snapshots
and acknowledgements reconcile exact unchanged originals. Unavailable native capabilities stay
explicitly unknown and are never reported as an empty queue or as clearance.

Reference: [review](../review.md), [commands](../commands.md#command-semantics).

## Work items

| ID      | Title                                                 | Link                             |
| ------- | ----------------------------------------------------- | -------------------------------- |
| dk-0001 | Accept Claude route targets in inbox snapshot and ack | [dk-0001.md](../work/dk-0001.md) |
| dk-0005 | Accept shell and waiting Claude session statuses      | [dk-0005.md](../work/dk-0005.md) |
