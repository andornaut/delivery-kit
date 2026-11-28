# Configuration

Commit `coordination-kit.json` at the workspace root and `delivery-kit.json` at each app's repository
root. Delivery Kit resolves the workspace, registry and review route through its bundled
Coordination Kit library.

Configuration never holds secret values. Use the operator's existing authentication and
credential references.

## Workspace configuration

Schema 1 requires `timezone` (an IANA zone), `wakeMinutes` (unique integers 0 to 59),
`kits` (a map of kit IDs to `{path}`), `sharedRoles` (role keys) and exactly one of
`apps` or `games`. Paths resolve relative to the workspace root. An empty `wakeMinutes`
schedules no review.

The canonical config selects ignored `.coordination-kit/` for registry and routing state.
An existing workspace with only `config.json` still uses `var/`. To move an existing
workspace, follow [the Coordination Kit 9 rollout](../guides/upgrading.md#move-the-workspace-reader-to-coordination-kit-9).

### App mode

Each `apps.<id>` entry has a display `name`, repository `path` and a non-empty list of
exact registry role keys in `roles`. A solo repo can set `path` to `"."`. Role keys such as
`operator` and `reports/operator` are used verbatim by the registry, the route and reports.

Declare grants under `permissions.<role>` with a `workspace` array and an `apps` map from
app IDs to grant arrays. Use an empty `workspace` array for a role whose grants apply only
to named apps. Set the app's `operations.<id>.busOwner` in the registry and grant that role
`delivery:operate`, `review:deliver` and `events:ingest` for the app to run its resident.
See [authorization](commands.md#app-mode-authorization) for command requirements.

Canonical app workspaces use `.coordination-kit/apps/<id>/bus/` by default. Set
`"appStateRoot": "var"` to keep an existing bus under `var/` during a layout migration.
Set `"appStateDir": "games"` when adopting app mode while keeping the `games/<id>/bus/`
subdirectory. These fields select the bus path independently of the registry and route.
See the [app-mode upgrade procedure](../guides/upgrading.md#opt-in-to-app-mode).

To try the [solo example](https://github.com/andornaut/delivery-kit/blob/v8.8.0/examples/solo/config.json),
save its workspace config as `coordination-kit.json` and its `delivery-kit.json` alongside it.
Place the example route at `.coordination-kit/route.json` and ignore `/.coordination-kit/`.
Set the GitHub repository, CI check names and gate commands for your project. Create the
[registry binding](registry.md) and run `delivery-kit --root WORKSPACE check-config --app reports`.

### Legacy game mode

The [`games` configuration](https://github.com/andornaut/delivery-kit/blob/v8.8.0/examples/config.json)
works in either layout. Each `games.<id>` entry has `name`, `path` and unqualified `roles`.
The corresponding registry role keys are `<id>/<role>`, plus the shared role names.
`permissions` and `appStateDir` are app-mode fields. A `games` config always uses the
`games/<id>/bus/` subdirectory. It can set `"appStateRoot": "var"` as well.

## App `delivery-kit.json`

Each app uses schema 1. See the [solo example](https://github.com/andornaut/delivery-kit/blob/v8.8.0/examples/solo/delivery-kit.json)
or the [game example](https://github.com/andornaut/delivery-kit/blob/v8.8.0/examples/delivery-kit.json).

- `git`: `main`, `remote` and `github` (the GitHub `owner/name`).
- `schedule`: `departures`, a non-empty list of unique two-digit minute strings such as `"00"`, and
  `timezone`, which defaults to the workspace timezone.
- `gate`: `image`, `install` and ordered `steps` (`name`, `run`). The image needs `sh`, `git`,
  `tar`, `ls` and `tail`. After a passing install, the optional-package check needs `node` if
  the supported npm lock lists optional packages. The install must leave every optional package
  expected for the container's platform and npm's effective omit, including flags in `install`
  ([gate container](runner.md#gate-container)). An empty `install` skips
  the install step, and an empty `steps` list
  gates with no checks. A command that assigns a secret-like variable inline (for example `TOKEN=x npm ci`) is
  rejected. Every step is treated alike: each needs a unique name (a letter or digit, then up
  to 63 letters, digits, `_`, `.` or `-`), steps run in list order, and the first failure stops
  the gate. No step name has special meaning. The
  canonical order is `check`, `lint`, `test`, `build`, then any app-specific steps (such as
  `art`), so every app lists the shared steps the same way and opts into extras by adding them.
- `resources`: `cpus` (integer 1 to 4), `memoryMiB` (integer 6 to 8192) and `loadLimit` (a
  number 0 to 30), all required. Gate containers receive `--memory <memoryMiB>m`, in MiB. CPU and
  memory limits cap execution; only the one-minute load controls admission. A departure starts only below
  `loadLimit`. At or above it, the departure re-checks the one-minute load every 60 seconds and
  starts once the load is below the limit, up to 15 minutes from the scheduled slot or the start
  of a requested departure. If the load still meets or exceeds the limit at the deadline, the
  attempt reports `blocked-load`. A `loadLimit` of 0 blocks every attempt that reaches the load check.
- `ci`: `requiredNames` (a non-empty list of unique check names that must exist and pass for
  the exact pushed commit), `pollSeconds` (1 to 3600) and `timeoutSeconds` (1 to 86400). With a
  path-filtered workflow, include its classification job (for example `changes`), since a
  skipped required run counts as passing.
- `deploy`: `mode` is `wrangler` or `none`; the optional `skipPattern` is a regular expression
  over the paths changed in the pushed range (the previous remote `main` to the pushed SHA, both
  sides of a rename). A push whose every changed path matches it skips deployment. A range that
  changes only `docs/` paths skips the gate and deployment when there is no pending deployment.
  This shortcut applies independently of `skipPattern` ([Departures](runner.md#departures)).
- `reports` requires a `scheduledTicks` boolean, a `recipient` role key and a `workerParents`
  array of unique role keys. The recipient receives delivery reports and the scheduled reviews
  when the app hosts the route. Enabling `scheduledTicks` adds one `scheduled-status` event
  per departure slot. Reports use the app's `name` from the workspace configuration. The optional legacy
  `project` must match that name when supplied. Keep it while a current or rollback reader
  requires it. When the workspace registry exists, `check-config` resolves the recipient and each
  worker parent as registry roles. Every listed worker parent must have a canonical conversation
  UUID that no other listed parent shares.
