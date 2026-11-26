# Configuration

Commit `config.json` at the workspace root and `delivery-kit.json` at each app's repository root.
Coordination Kit reads these files for the registry, review route and message routing.

Configuration never holds secret values. Use the operator's existing authentication and
credential references.

## Workspace `config.json`

Schema 1 requires `timezone` (an IANA zone), `wakeMinutes` (unique integers 0 to 59),
`kits` (a map of kit IDs to `{path}`), `sharedRoles` (role keys) and exactly one of
`apps` or `games`. Paths resolve relative to the workspace root. An empty `wakeMinutes`
schedules no review.

### App mode

Each `apps.<id>` entry has a display `name`, repository `path` and a non-empty list of
exact registry role keys in `roles`. A solo repo can set `path` to `"."`. Role keys such as
`operator` and `reports/operator` are used verbatim by the registry, the route and reports.

Declare grants under `permissions.<role>` with a `workspace` array and an `apps` map from
app IDs to grant arrays. Use an empty `workspace` array for a role whose grants apply only
to named apps. Set the app's `operations.<id>.busOwner` in the registry and grant that role
`delivery:operate`, `review:deliver` and `events:ingest` for the app to run its resident.
See [authorization](commands.md#app-mode-authorization) for command requirements.

New workspaces default to `var/apps/<id>/bus/`. When upgrading a `games` workspace, set
`"appStateDir": "games"` to keep its existing state paths. See the
[solo configuration](../examples/solo/config.json) and the [upgrade procedure](upgrading.md#opt-in-to-app-mode).

To try the solo example, copy its two configuration files to the app root and its
`route.json` to `var/route.json`. Keep `var/` out of Git. Set the GitHub repository, CI
check names and gate commands for your project. Create the [registry binding](registry.md)
and validate the configuration with `delivery-kit --root WORKSPACE check-config --app reports`.

### Legacy game mode

Keep the existing [`games` configuration](../examples/config.json) to retain legacy behaviour.
Each `games.<id>` entry has `name`, `path` and unqualified `roles`. The corresponding registry
role keys are `<id>/<role>`, plus the shared role names. `permissions` and `appStateDir` are
app-mode fields.

## App `delivery-kit.json`

Each app uses schema 1. See the [solo example](../examples/solo/delivery-kit.json) or the
[legacy example](../examples/delivery-kit.json).

- `git`: `main`, `remote` and `github` (the GitHub `owner/name`).
- `schedule`: `departures`, a non-empty list of unique two-digit minute strings such as `"00"`, and
  `timezone`, which defaults to the `config.json` timezone.
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
  per departure slot. Reports use the app's `name` from `config.json`. The optional legacy
  `project` must match that name when supplied. Keep it while a current or rollback reader
  requires it. When `var/registry.json` exists, `check-config` resolves the recipient and each
  worker parent as registry roles. Every listed worker parent must have a canonical conversation
  UUID that no other listed parent shares.
