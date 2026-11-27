# Registry

Coordination Kit owns schema-1 `var/registry.json`, harness selection, send-time resolution
and readiness probes. Delivery Kit reads the registry for `check-config`, runner startup and
[command authorization](commands.md#app-mode-authorization).

In an app workspace, register exact keys from `apps.<id>.roles` or `sharedRoles`. Set
`operations.<id>.busOwner` to the registered role that operates delivery for that app. For
the [solo example](https://github.com/andornaut/delivery-kit/blob/main/examples/solo/config.json), set `operations.reports.busOwner` to
`operator`, with its actual native conversation under the selected harness and active
ownership. Use the workspace root for its worktree path (`"."`) when the session runs there.
Seed the registry using the workspace owner's actual native project and conversation IDs.
See the [Coordination Kit app workspace setup](https://github.com/andornaut/coordination-kit/blob/v7.8.0/docs/configuration.md#start-an-app-workspace).

An in-place migration preserves the existing registry keys and bus owner. Legacy
`control --requester` continues to resolve a registered role. See the
[Coordination Kit registry reference](https://github.com/andornaut/coordination-kit/blob/main/docs/registry.md)
and [upgrading to 5.0](upgrading.md#upgrading-to-50).
