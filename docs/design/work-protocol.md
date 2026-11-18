# Work protocol

An explicitly activated work protocol keeps fenced role publications, canonical message
originals and recipient handling receipts under one external `stateRoot`, outside every source
checkout. Each role writes only its own namespace under its claimed epoch. Enrollment receipts
reference existing records rather than copying their state. Representation, active adoption
and coverage completeness are reported separately, and runtime admission is role-local: a role
needs its own current active receipt and the specific approved work reference. Request
accounting tracks requested outcomes separately from message delivery and handling. Migration
copies legacy state byte-exact after a verified backup and restore.

Reference: [work-protocol](../work-protocol.md), [request-accounting](../request-accounting.md).

## Work items

| ID      | Title                                                                | Link                             |
| ------- | -------------------------------------------------------------------- | -------------------------------- |
| dk-0004 | Carry recipient transport state in legacy message migration          | [dk-0004.md](../work/dk-0004.md) |
| dk-0010 | Anchor enrollment adoption to receipt-covered references             | [dk-0010.md](../work/dk-0010.md) |
| dk-0011 | Validate an enrollment only against the enrolling role's own inputs  | [dk-0011.md](../work/dk-0011.md) |
| dk-0012 | Document work receipt binding, source pin and cleanup artifact rules | [dk-0012.md](../work/dk-0012.md) |
