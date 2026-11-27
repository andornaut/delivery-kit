# Messages

Common role messages, their delivery guards, the Claude spool and reconciliation moved to
coordination-kit in 5.0 ([ck-0001](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0001.md)). The work items below shipped in
delivery-kit before the move.

Reference: [messages](../messages.md), [coordination-kit messages](https://github.com/andornaut/coordination-kit/blob/main/docs/design/messages.md).

## Work items

| ID      | Title                                                                   | Link                                                                                   |
| ------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| dk-0002 | Report deduplicated and unchanged delivery receipts with diagnostics    | [dk-0002.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0002.md) |
| dk-0007 | Bound the Claude channel consumer guard to one store index per drain    | [dk-0007.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0007.md) |
| dk-0008 | Record a busy Claude spool as a retryable transport-busy refusal        | [dk-0008.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0008.md) |
| dk-0009 | Retire terminal Claude spool entries with `message retire-spool`        | [dk-0009.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0009.md) |
| dk-0029 | Recover guarded communication safely after send failures and compaction | [dk-0029.md](https://github.com/andornaut/delivery-kit/blob/main/docs/work/dk-0029.md) |
