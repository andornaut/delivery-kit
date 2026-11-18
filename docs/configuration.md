# Configuration

The committed configuration files: game-coordinator's `config.json` and each game's `delivery-kit.json`.
coordination-kit reads the same files for the registry, the review route and message routing.

Configuration never holds secret values. Use the operator's existing authentication and
credential references.

## game-coordinator `config.json`

Committed in game-coordinator, schema 1. Every path is relative to game-coordinator. See `examples/config.json`.

- `timezone` (an IANA time zone) and `wakeMinutes` (unique integers 0 to 59): the scheduled
  review minutes. An empty `wakeMinutes` schedules no review.
- `games.<id>`: `name` (the report name, for example `Archie`), `path` to the game checkout and
  `roles`.
- `kits.<id>.path` and `sharedRoles`.

Role keys are `<game>/<role>` for each game role, then each shared role name. The registry, the
route and every role reference must use these keys.

## Game `delivery-kit.json`

Committed in each game, schema 1, and owned by its Tech role. See `examples/delivery-kit.json`.

- `git`: `main`, `remote` and `github` (the GitHub `owner/name`).
- `schedule`: `departures`, a non-empty list of two-digit minute strings such as `"00"`, and
  `timezone`, which defaults to the `config.json` timezone.
- `gate`: `image`, `install` and ordered `steps` (`name`, `run`). Any image and install command
  are accepted, provided the image has `sh`, `git`, `tar`, `ls` and `tail`; a departure names
  the tool an image lacks. An empty `install` skips the install step, and an empty `steps` list
  gates with no checks. A command that assigns a secret-like variable inline (for example `TOKEN=x npm ci`) is
  rejected. Every step is treated alike: each needs a unique name (a letter or digit, then up
  to 63 letters, digits, `_`, `.` or `-`), steps run in list order, and the first failure stops
  the gate. No step name has special meaning. The
  canonical order is `check`, `lint`, `test`, `build`, then any game-specific steps (such as
  `art`), so every game lists the shared steps the same way and opts into extras by adding them.
- `resources`: `cpus` (integer 1 to 4), `memoryMiB` (integer 6 to 8192) and `loadLimit` (a
  number 0 to 30), all required. Gate containers receive `--memory <memoryMiB>m`, in MiB. CPU and
  memory limits cap execution; only the one-minute load controls admission. A departure starts only below
  `loadLimit`. At or above it, the departure re-checks the one-minute load every 60 seconds and
  starts once the load is below the limit, up to 15 minutes after its scheduled slot; a load still
  at or above the limit then skips the slot with `blocked-load`. A `loadLimit` of 0 holds every
  departure, each after the full 15 minutes.
- `ci`: `requiredNames` (a non-empty list of check names that must exist and pass for the exact
  pushed commit), `pollSeconds` (1 to 3600) and `timeoutSeconds` (1 to 86400). With a
  path-filtered workflow, include its classification job (for example `changes`), since a
  skipped required run counts as passing.
- `deploy`: `mode` is `wrangler` or `none`; the optional `skipPattern` is a regular expression
  over the paths changed in the pushed range (the previous remote `main` to the pushed SHA, both
  sides of a rename). A push whose every changed path matches it skips deployment. A range that
  changes only `docs/` paths departs without a gate or a deployment whatever this pattern says
  (see [runner.md](runner.md#departures)).
- `reports`: `project` (must equal the game's `name` in `config.json`), `scheduledTicks`, and
  `recipient` and `workerParents`, each a registered role key. `recipient` receives the game's
  events and, when the game hosts the route, its scheduled reviews. `scheduledTicks` (boolean)
  adds one `scheduled-status` report per departure slot. When `var/registry.json` exists,
  `check-config` requires each `workerParents` role to resolve to a canonical conversation UUID
  that no other parent shares.
