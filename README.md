# delivery-kit

Local scheduled trunk-based Git delivery. Each departure gates the game's local `main` HEAD in an
isolated container, pushes that exact commit, watches its CI and deploys the already-gated build
on a pass. The kit owns the mechanisms. Each game owns its repository, `delivery-kit.json`,
credentials and schedule; `game-coordinator` owns `config.json`, the registry and mutable state.
The legacy default is `var/`.

The role registry, durable role messages, harness adapters, inbox review and the work store are
[coordination-kit](https://github.com/andornaut/coordination-kit), which delivery-kit builds on;
delivery-kit reads no coordination-kit store or work protocol state. The resident runner decides when a scheduled review slot is due and hands it to the
coordinator-installed coordination-kit CLI, appends its bus events to a per-game event log and asks
that CLI to ingest them ([Event log](docs/runner.md#event-log)).

The `@andornaut/delivery-kit` package provides the operator CLI,
bundled into `dist/cli.js` with the coordination-kit modules it uses. The bundle imports only
`node:` builtins, has no dynamic `import()`,
relative `require`, worker threads or source maps. The runner reads the installed package and
lockfile again before each departure. It runs the game's installed Wrangler and the coordinator
root's `coordination-kit` CLI with the same Node binary.

## Install and pin

Games and game-coordinator pin the released asset as a devDependency and commit the lockfile
integrity. The bundles inline coordination-kit's utilities, so a game pins only delivery-kit;
delivery-kit 8.4.0 bundles coordination-kit 3.4.4, inside `>=2.0.1 <4.0.0`
([Pin guard](docs/runner.md#pin-guard)). game-coordinator also pins coordination-kit directly
for the roles' CLI, the channel MCP server and the reviews and event ingest each runner spawns,
which need a release inside `>=3.0.0 <8.0.0`:

```json
"devDependencies": {
  "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v8.4.0/delivery-kit-8.4.0.tgz"
}
```

A pin changes only by a devDependency bump, `npm ci`, then an idle runner replacement. Each game's
runner runs from that game's own `node_modules`; game-coordinator's copy runs `check-config` and
`status`, and its coordination-kit copy runs the coordination commands and the runners' reviews
and event ingest.

## Commands

Every verb is a game operation; `runner` is a noun group that takes a verb. Every command resolves game-coordinator from `--root DIR`, else
`DELIVERY_KIT_ROOT`, else the working directory. `--root` may appear anywhere on the command line, at most once. `--game` is always
explicit; it is never inferred from the working directory.

| Command                                                                    | Purpose                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run --game ID`                                                            | Game operation: the resident runner for one game.                                                                                                                |
| `runner unit --game ID`                                                    | Game operation: print the optional systemd user unit for the game's resident runner; installs nothing.                                                           |
| `runner stop --game ID [--timeout SECONDS]`                                | Game operation: wait until the game's runner is idle and drained, then stop it through its unit or by signal.                                                    |
| `runner start --game ID`                                                   | Game operation: start one runner through the game's systemd user unit, or detached without one.                                                                  |
| `status --game ID [--resources]`                                           | Game operation: read-only runner identity, singleton, idle and drain report as one JSON line; with `--resources`, the reporting-only resource information.       |
| `control --game ID --state enabled\|paused --reason TEXT --requester ROLE` | Game operation: persist desired delivery control with its reason and requesting role.                                                                            |
| `check-config [--game ID]`                                                 | Game operation: validate `config.json`, `var/registry.json`, `var/route.json` and each `delivery-kit.json` together, with no Git, network or container activity. |
| `request --game ID --id SAFE_ID`                                           | Game operation: record an operator-authorized one-off departure of the current local `main` HEAD. The runner performs it.                                        |
| `help`, `--help`, `--version`                                              | Usage and version.                                                                                                                                               |

`check-config` validates the registry and route when those files are present. See the
[command reference](docs/commands.md) for details and commands moved to Coordination Kit.

Exit status is 0 on success, 1 for invalid configuration, a failed precondition or an unavailable
read, 2 for a usage error or an unexpected failure, and 3 for a refused `run` (held singleton locks or an
unmigrated legacy outbox). `run` exits 130 on `SIGINT` and 143 on `SIGTERM`. Errors, a
refused runner start and a refused request go to stderr prefixed `delivery-kit:`. `--help` is
generated from each command's parser options, so it lists every flag a command accepts.

## Configuration

Configuration never holds secret values. game-coordinator commits `config.json` and each game
commits its `delivery-kit.json`; see `examples/`. Every field and its validation:
[docs/configuration.md](docs/configuration.md).

## Documentation

| Doc                                                      | Covers                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/commands.md](docs/commands.md)                     | Per-command semantics and the commands that moved to coordination-kit                                                                                                                                                         |
| [docs/configuration.md](docs/configuration.md)           | `config.json` and `delivery-kit.json`: schedule, gate, resources, CI, deployment and reports                                                                                                                                  |
| [docs/registry.md](docs/registry.md)                     | Pointer: the registry moved to coordination-kit; what delivery-kit still reads from it                                                                                                                                        |
| [docs/messages.md](docs/messages.md)                     | Pointer: common role messages moved to coordination-kit                                                                                                                                                                       |
| [docs/review.md](docs/review.md)                         | The scheduled review seam the runner calls and the bus events it records, with their remedies                                                                                                                                 |
| [docs/state.md](docs/state.md)                           | The state layout, durable writes, desired and observed delivery control, and adopting persistent control                                                                                                                      |
| [docs/runner.md](docs/runner.md)                         | Launching, supervising and replacing the resident runner, the coordinator CLI seam, the event log, the pin guard and coordination-kit ranges, status and observer adoption, departures, the gate container and test overrides |
| [docs/libraries.md](docs/libraries.md)                   | The public build API subpath and alias and the source identity library; the subpaths that moved                                                                                                                               |
| [docs/request-accounting.md](docs/request-accounting.md) | Pointer: the request ledger moved to coordination-kit                                                                                                                                                                         |
| [docs/work-protocol.md](docs/work-protocol.md)           | Pointer: the work protocol moved to coordination-kit                                                                                                                                                                          |
| [docs/upgrading.md](docs/upgrading.md)                   | Version-specific upgrade procedures, the legacy outbox bridge and removed command forms                                                                                                                                       |
| [docs/design/](docs/design/README.md)                    | Design area summaries, each linking its topic docs and indexing its work items                                                                                                                                                |
| [docs/work/](docs/work/README.md)                        | The work-file convention and one file per approved task (repository only, not packaged)                                                                                                                                       |

## Developing

| Target               | Does                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `make`, `make check` | Complete verification: root and contract types, lint, one build, contracts, unit tests and package inspection |
| `make lint`          | Root and contract types, Prettier, ESLint and Markdown lint                                                   |
| `make test`          | Build once, then run the complete native contract suite and unit tests                                        |
| `make build`         | Build, then package inspection                                                                                |

Every target runs in the stock Node image pinned in `.nvmrc`. The container binds the checkout
read-only and runs as the host user with four CPUs, 4 GiB memory (`CHECK_MEMORY`), a read-only
root filesystem and no capabilities. It copies source into tmpfs, excluding `.git`, dependencies
and build output. It installs the root and contract dependencies with `npm ci --ignore-scripts`
and runs the native npm checks.

Native npm commands run directly wherever they are invoked. Local prerequisites are the
pinned Node version and the root and contract dependencies.
Install dependencies with `npm ci` and `npm --prefix tests/contract ci`.

WORKAROUND: root overrides keep `markdownlint-cli2` 0.24.0 on patched Markdown and math
dependencies for [GHSA-gg6h-894w-4m9c](https://github.com/advisories/GHSA-gg6h-894w-4m9c)
and [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
Remove them when upstream resolves the patched versions without overrides.

| Command                 | Checks                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `npm run verify`        | Root and contract types, lint, one build, unit tests, full contracts and package inspection. |
| `npm run check`         | Root and contract types.                                                                     |
| `npm run lint`          | Prettier, ESLint and Markdown lint.                                                          |
| `npm run build`         | Build the CLI and public build API bundles and declarations.                                 |
| `npm test`              | Unit tests, using at most four workers by default; build first.                              |
| `npm run contract`      | Build, contract types and the complete native contract suite.                                |
| `npm run package:check` | Inspect the extracted CLI, canonical/alias API identity and strict NodeNext declarations.    |

Explicit source or contract paths passed to `npm run verify --` select the corresponding
suite; unscoped filters apply to both. Standalone `npm run contract -- --lock` regenerates
the contract lockfile with native npm. Ordinary Git commits run serial local lint-staged,
with direct Prettier and ESLint fixes that preserve Git's staged/unstaged workflow.

CI runs the same native npm commands directly on the runner with the pinned Node version.
Its `lint` job (types, Prettier, ESLint and Markdown lint) runs on pushes to `main` and
`release-*` branches and on pull requests. The `build`, `test`, `contract` and `package` jobs
skip when the classifier finds a non-empty diff entirely under `docs/`. A change to the root
`README.md`, an empty diff, a forced push, a new branch or an unverified base runs every job.

Package inspection always reports `immutableCommitClaim: false`. Snapshot metadata retains
`CHECK_REVISION`, `CHECK_SOURCE_SHA256` and `CHECK_SOURCE_DIRTY` when supplied; native
inspection without that metadata invents no commit or source hash. Inspection writes its
archive and `CHECK_CONTEXT.json` to a fresh temporary directory and prints that location.

Use `npm run verify --` for the former `scripts/check.sh`, `npm run contract --` for
`tests/contract/run.sh`, and `npm run pack --` for `scripts/pack.sh`. Pass the same arguments
after `--`.

The separately invoked `npm run pack -- EXACT_COMMIT_SHA /new/absolute/directory` is the
explicit host release-controller exception: it archives the requested commit and starts
its own offline release container with the pinned Node image and the read-only
`delivery-kit-npm-check` cache volume (`DELIVERY_KIT_NPM_VOLUME` names another); a missing
volume or dependency fails without fallback. The controller retains the source epoch and copies
the exact revision's `SOURCE_COMMIT` and `SHA256SUMS` out with the archive. CI fills the cache
volume from the lockfile, then invokes this controller after the checks.

## Compatibility and releases

`VERSION` and `package.json` carry the version, and `pack` refuses a mismatch. The CLI, the source
identity module API, the supported coordination-kit range and the `var/` layout follow semver: an
incompatible change needs a major version. coordination-kit validates `delivery-kit.json`,
`config.json`, the registry and the route, so their schemas follow coordination-kit's versions. 2.0.0 removes
the `migrate` command; a 0.9.x installation upgrades through 1.0.3 first.

A release is three files from `pack`:

- `delivery-kit-VERSION.tgz`, the npm package (`dist/`, `README.md`, the topic docs and `docs/design/`, `LICENSE`, `SOURCE_COMMIT`; not `docs/work/`);
- `SOURCE_COMMIT`, the exact commit it was built from, also inside the archive;
- `SHA256SUMS`, covering the archive and `SOURCE_COMMIT`.

The release owner pushes the release commit to `main`, verifies every required CI workflow
succeeded for that exact commit, then tags `vVERSION` there and attaches the `pack` output. A
published tag is never moved.

## Licence

MIT; see `LICENSE`. The licence does not cover consumer art assets or game values.
