# Work protocol

The filesystem work protocol, enrollment, migration and request accounting moved to
coordination-kit in 5.0 ([ck-0001](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0001.md)). From 7.0 delivery-kit
reads no work protocol state and imports nothing from coordination-kit's `build/protocol`;
observer adoption comes from the runner's own `runner.started` record. The work items below
shipped in delivery-kit before the move.

Reference: [work-protocol](../work-protocol.md),
[coordination-kit work protocol](https://github.com/andornaut/coordination-kit/blob/main/docs/design/work-protocol.md).

## Work items

| ID      | Title                                                                | Link                             |
| ------- | -------------------------------------------------------------------- | -------------------------------- |
| dk-0004 | Carry recipient transport state in legacy message migration          | [dk-0004.md](../work/dk-0004.md) |
| dk-0010 | Anchor enrollment adoption to receipt-covered references             | [dk-0010.md](../work/dk-0010.md) |
| dk-0011 | Validate an enrollment only against the enrolling role's own inputs  | [dk-0011.md](../work/dk-0011.md) |
| dk-0012 | Document work receipt binding, source pin and cleanup artifact rules | [dk-0012.md](../work/dk-0012.md) |
