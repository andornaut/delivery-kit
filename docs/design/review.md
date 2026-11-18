# Review

The review route, the brief, the inbox inventory and the Claude and Codex adapters moved to
coordination-kit in 5.0 ([ck-0001](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0001.md)). The dependency runs one way: the
runner's observer decides when a `wakeMinutes` slot is due and calls `deliverScheduledReview`, and
records its bus events through `recordEvent`, tracking each pushed commit under the outbox lock
until its `complete` event. The work items below shipped in delivery-kit before the move.

Reference: [review](../review.md), [coordination-kit review](https://github.com/andornaut/coordination-kit/blob/main/docs/design/review.md).

## Work items

| ID      | Title                                                 | Link                             |
| ------- | ----------------------------------------------------- | -------------------------------- |
| dk-0001 | Accept Claude route targets in inbox snapshot and ack | [dk-0001.md](../work/dk-0001.md) |
| dk-0005 | Accept shell and waiting Claude session statuses      | [dk-0005.md](../work/dk-0005.md) |
