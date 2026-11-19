# Work protocol

The filesystem work protocol, its publications, message originals, handling receipts, enrollment
and migration moved to coordination-kit in delivery-kit 5.0. The `protocol` commands are
`coordination-kit protocol ...` with the same options and output. From 7.0, delivery-kit reads no
work protocol state: `status` derives observer adoption from the runner's own `runner.started`
record; see [Observer adoption](runner.md#observer-adoption).

Reference: [coordination-kit work protocol](https://github.com/andornaut/coordination-kit/blob/main/docs/work-protocol.md),
[upgrading to 5.0](upgrading.md#upgrading-to-50).
