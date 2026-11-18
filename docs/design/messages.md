# Messages

`message send` stores a common message locally and never dispatches it. `message dispatch` is an
explicit guarded delivery request: it checks ownership, routing and recipient decision guards
before any native send. Each attempt writes a bound receipt first. A failure proven to occur
before native admission permits a guarded retry; any other uncertain outcome is ambiguous and
is reconciled before a retry. Native or channel acceptance is delivery, not handling.

The Claude transport is a per-recipient spool under `unblock.lock`, drained by the
`claude channel` consumer, which rechecks each entry before claiming it. Status reports an
allowlisted diagnostic for each blocked or guarded result. Reconciliation records `accepted`,
`handled`, `superseded` or `retained` against exact evidence at the observed revision.

Reference: [messages](../messages.md), [commands](../commands.md#command-semantics).

## Work items

| ID      | Title                                                                | Link                             |
| ------- | -------------------------------------------------------------------- | -------------------------------- |
| dk-0002 | Report deduplicated and unchanged delivery receipts with diagnostics | [dk-0002.md](../work/dk-0002.md) |
| dk-0007 | Bound the Claude channel consumer guard to one store index per drain | [dk-0007.md](../work/dk-0007.md) |
| dk-0008 | Record a busy Claude spool as a retryable transport-busy refusal     | [dk-0008.md](../work/dk-0008.md) |
| dk-0009 | Retire terminal Claude spool entries with `message retire-spool`     | [dk-0009.md](../work/dk-0009.md) |
