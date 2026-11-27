# Review

The review route, the brief, the inbox inventory and the Claude and Codex adapters moved to
coordination-kit in 5.0 ([ck-0001](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0001.md)). The dependency runs one way: the
runner's observer decides when a `wakeMinutes` slot is due and, from 6.0, spawns the
coordinator-installed `coordination-kit review deliver` ([dk-0022](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0022.md)) and, from
6.1, appends its bus events to a per-game log that `coordination-kit events ingest` reads
([dk-0025](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0025.md)).

Reference: [review](../reference/review.md), [coordination-kit review](https://github.com/andornaut/coordination-kit/blob/main/docs/design/review.md).

## Work items

| ID      | Title                                                 | Link                                                                                   |
| ------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| dk-0001 | Accept Claude route targets in inbox snapshot and ack | [dk-0001.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0001.md) |
| dk-0005 | Accept shell and waiting Claude session statuses      | [dk-0005.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0005.md) |
| dk-0041 | Retry reviews deferred by store compaction            | [dk-0041.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0041.md) |
