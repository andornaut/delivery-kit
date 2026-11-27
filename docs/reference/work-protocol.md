# Work protocol

The filesystem work protocol, its publications, message originals, handling receipts, enrollment
and migration moved to coordination-kit in delivery-kit 5.0. Coordination Kit 3.0 retired the
legacy `protocol` commands. See the [Coordination Kit 3.0 migration](https://github.com/andornaut/coordination-kit/blob/main/docs/guides/upgrading.md#from-21)
and [upgrading to Delivery Kit 5.0](../guides/upgrading.md#upgrading-to-50).

From Delivery Kit 7.0, `status` derives [observer adoption](runner.md#observer-adoption) from
the runner's own `runner.started` event, the ingest cursor and the last seen coordinator CLI.
