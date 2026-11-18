# Registry

`var/registry.json`, harness selection, send-time resolution, the readiness probes and the
harness doctor moved to coordination-kit in delivery-kit 5.0. delivery-kit still reads the
registry through coordination-kit: `check-config` validates it, `run` refuses a registry with
non-canonical conversation IDs, and `control` resolves `--requester` through it.

Reference: [coordination-kit registry](https://github.com/andornaut/coordination-kit/blob/main/docs/registry.md),
[upgrading to 5.0](upgrading.md#upgrading-to-50).
