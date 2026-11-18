# Registry

`var/registry.json` records each role's ownership, worktree and conversation ID per harness.
Every writer holds `registry.lock`, rejects a changed revision and writes durably. Each send
resolves the recipient's effective harness from its role override or the registry default, then
that harness's conversation ID, and caches nothing. A missing ID is `unavailable`, never
clearance. Harness selection changes only the explicitly selected roles' overrides; readiness
probes and the harness doctor send nothing and activate nothing.

Reference: [registry](../registry.md).

## Work items

No work items yet.
