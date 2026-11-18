# delivery-kit

Local scheduled trunk-based Git delivery. Each departure gates the game's local `main` HEAD in an
isolated container, pushes that exact commit, watches its CI and deploys the already-gated build
on a pass. The kit owns the mechanisms. Each game owns its repository, `delivery-kit.json`,
credentials and schedule; `game-coordinator` owns `config.json`, the registry and mutable state.
The legacy default is `var/`; an explicitly activated work protocol stores its publications,
accounting and message transport state under an external `stateRoot`.

The `game-coordinator` role coordinates from the `game-coordinator` repository.

The package is `@andornaut/delivery-kit`. Its operator build tool is the `delivery-kit` CLI,
bundled into `dist/cli.js`. The bundle imports only `node:` builtins, has no dynamic `import()`,
relative `require`, worker threads or source maps, never spawns its own files, and reads nothing
from disk after startup except configuration and state. Its child processes are `git`, `docker`,
`gh`, `flock`, `claude agents --json` and the game's own Wrangler run by the same Node binary.

## Install and pin

Games and game-coordinator pin the release asset as a devDependency and commit the lockfile integrity:

```json
"devDependencies": {
  "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v4.0.0/delivery-kit-4.0.0.tgz"
}
```

A pin changes only by a devDependency bump, `npm ci`, then an idle runner replacement. Each game's
runner runs from that game's own `node_modules`; game-coordinator's copy runs `check-config`, `status`,
`claude channel`, the readiness probes and the inbox commands.

## Commands

Top-level verbs are game operations; `inbox`, `harness`, `claude` and `codex` are noun groups that take a
verb. Every command resolves game-coordinator from `--root DIR`, else `DELIVERY_KIT_ROOT`, else the working
directory. `--root` may appear anywhere on the command line, at most once. `--game` is always
explicit; it is never inferred from the working directory.

| Command                                                                                                                                                  | Purpose                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run --game ID`                                                                                                                                          | Game operation: the resident runner for one game.                                                                                                                |
| `status --game ID [--resources]`                                                                                                                         | Game operation: read-only runner identity, singleton, idle and drain report as one JSON line; with `--resources`, the reporting-only resource information.       |
| `control --game ID --state enabled\|paused --reason TEXT --requester ROLE`                                                                               | Game operation: persist desired delivery control with its reason and requesting role.                                                                            |
| `check-config [--game ID]`                                                                                                                               | Game operation: validate `config.json`, `var/registry.json`, `var/route.json` and each `delivery-kit.json` together, with no Git, network or container activity. |
| `request --game ID --id SAFE_ID`                                                                                                                         | Game operation: record an operator-authorized one-off departure of the current local `main` HEAD. The runner performs it.                                        |
| `inbox snapshot --game ID [--recipient ROLE] [--parent ROLE]... [--history-cursor CURSOR]`                                                               | Inbox (recipient): capture the recipient's inbox snapshot.                                                                                                       |
| `inbox ack --game ID --snapshot UUID --queue-id ID... --disposition handled\|superseded\|retained [--reason TEXT] [--recipient ROLE] [--parent ROLE]...` | Inbox (recipient): acknowledge queue items from that snapshot. `retained` requires a reason.                                                                     |
| `claude ready`, `codex ready`                                                                                                                            | Harness: the handoff readiness probe (see [Readiness probe](docs/registry.md#readiness-probe)).                                                                  |
| `claude ready [--game ID]... [--role ROLE]...`, `codex ready [--game ID]... [--role ROLE]...`                                                            | Harness: probe the requested target adapter and conversations for an explicit subset.                                                                            |
| `harness ready [--game ID]... [--role ROLE]...`                                                                                                          | Harness: read-only readiness using each selected role's effective harness.                                                                                       |
| `harness select --harness claude\|codex\|default --expected-revision N [--game ID]... [--role ROLE]...`                                                  | Harness: atomic selection for at least one explicit game or role, without activation.                                                                            |
| `claude channel [--game ID]... [--conversation UUID] [--state-dir DIR]... [--poll-seconds N]`                                                            | Harness: the stdio MCP server the Claude recipient session starts.                                                                                               |
| `help`, `--help`, `--version`                                                                                                                            | Usage and version.                                                                                                                                               |

Per-command semantics and worker inbox reconciliation are in [docs/commands.md](docs/commands.md).

Exit status is 0 on success, 1 for invalid configuration, a failed precondition, an unavailable
read or a refused runner start, and 2 for a usage error or an unexpected failure. `run` exits 130
on `SIGINT` and 143 on `SIGTERM`. Errors, a refused runner start and a refused request go to
stderr prefixed `delivery-kit:`. `inbox snapshot` and `inbox ack` keep their JSON result on
stdout and also name the error on stderr. `--help` is generated from each command's parser
options, so it lists every flag a command accepts.

## Configuration

Configuration never holds secret values. game-coordinator commits `config.json` and each game
commits its `delivery-kit.json`; see `examples/`. Every field and its validation:
[docs/configuration.md](docs/configuration.md).

## Documentation

| Doc                                                      | Covers                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/commands.md](docs/commands.md)                     | Per-command semantics and worker inbox reconciliation                                                                                                      |
| [docs/configuration.md](docs/configuration.md)           | `config.json` and `delivery-kit.json`: schedule, gate, resources, CI, deployment and reports                                                               |
| [docs/registry.md](docs/registry.md)                     | `var/registry.json`, scoped harness selection, send-time resolution, the readiness probe and the harness doctor                                            |
| [docs/messages.md](docs/messages.md)                     | Common message send, status, dispatch, delivery guards and reconciliation                                                                                  |
| [docs/review.md](docs/review.md)                         | The review route `var/route.json`, the Claude and Codex adapters, mixed inbox snapshots and event remedies                                                 |
| [docs/state.md](docs/state.md)                           | The state layout, durable writes, desired and observed delivery control, and adopting persistent control                                                   |
| [docs/runner.md](docs/runner.md)                         | Launching and replacing the resident runner, the pin guard, status provenance, departures, the gate container and test overrides                           |
| [docs/libraries.md](docs/libraries.md)                   | Public build API subpaths and aliases, the registry library, transport endpoint selection and the source identity library                                  |
| [docs/request-accounting.md](docs/request-accounting.md) | Requested outcomes tracked separately from message delivery and recipient handling: provenance, per-target closure, protected questions and capture limits |
| [docs/work-protocol.md](docs/work-protocol.md)           | Fenced role publications, canonical message originals, recipient handling receipts and external `stateRoot` activation                                     |
| [docs/upgrading.md](docs/upgrading.md)                   | Upgrading to 4.0 and 3.0, and the removed command forms                                                                                                    |
| [docs/design/](docs/design/README.md)                    | Design area summaries, each linking its topic docs and indexing its work items                                                                             |
| [docs/work/](docs/work/README.md)                        | The work-file convention and one file per approved task (repository only, not packaged)                                                                    |

## Developing

| Target               | Does                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `make`, `make check` | Complete verification: root and contract types, lint, build, unit tests, contracts and package inspection, then ShellCheck |
| `make lint`          | Root and contract types, Prettier, ESLint and Markdown lint, then ShellCheck                                               |
| `make test`          | Build, unit tests and the complete native contract suite                                                                   |
| `make build`         | Build, then package inspection                                                                                             |

Every target runs in stock images: the Node version pinned in `.nvmrc` and
`koalaman/shellcheck:v0.11.0`. No image is built. Each container binds the checkout read-only, runs as the host user with four
CPUs and 4 GiB memory (`CHECK_MEMORY`), a read-only root filesystem and no capabilities. The
Node container copies the source without `.git`, dependencies or build output into tmpfs,
installs the root and contract dependencies with `npm ci`, then runs the native npm checks.
ShellCheck reads the bound source directly with no network.

Native npm commands run directly wherever they are invoked. Local prerequisites are the
pinned Node version, root and contract dependencies, and ShellCheck 0.11.0.
Install dependencies with `npm ci` and `npm --prefix tests/contract ci`.

WORKAROUND: root overrides keep `markdownlint-cli2` 0.24.0 on patched Markdown and math
dependencies for [GHSA-gg6h-894w-4m9c](https://github.com/advisories/GHSA-gg6h-894w-4m9c)
and [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
Remove them when upstream resolves the patched versions without overrides.

| Command                 | Checks                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run verify`        | Root and contract types, lint, wrapper syntax, build, unit tests, full contracts and package inspection. |
| `npm run check`         | Root and contract types.                                                                                 |
| `npm run lint`          | Prettier, ESLint, Markdown and ShellCheck with `-x -P SCRIPTDIR`.                                        |
| `npm run build`         | Build the CLI and public build API bundles and declarations.                                             |
| `npm test`              | Unit tests, using at most four workers by default; build first.                                          |
| `npm run contract`      | Build, contract types and the complete native contract suite.                                            |
| `npm run package:check` | Inspect the extracted CLI, canonical/alias API identity and strict NodeNext declarations.                |

Explicit source or contract paths passed to `npm run verify --` select the corresponding
suite; unscoped filters apply to both. Standalone `npm run contract -- --lock` regenerates
the contract lockfile with native npm. Ordinary Git commits run serial local lint-staged,
with direct Prettier and ESLint fixes that preserve Git's staged/unstaged workflow.

CI runs the same native npm commands directly on the runner with the pinned Node version and
the pinned ShellCheck step.

Package inspection always reports `immutableCommitClaim: false`. Snapshot metadata retains
`CHECK_REVISION`, `CHECK_SOURCE_SHA256` and `CHECK_SOURCE_DIRTY` when supplied; native
inspection without that metadata invents no commit or source hash. Inspection writes its
archive and `CHECK_CONTEXT.json` to a fresh temporary directory and prints that location.

The thin wrappers `scripts/check.sh` and `tests/contract/run.sh` invoke native Node helpers.
The separately invoked `npm run pack -- EXACT_COMMIT_SHA /new/absolute/directory` is the
explicit host release-controller exception: it archives the requested commit and starts
its own offline release container with the pinned Node image and the read-only
`delivery-kit-npm-check` cache volume (`DELIVERY_KIT_NPM_VOLUME` names another); a missing
volume or dependency fails without fallback. The controller retains the source epoch and copies
the exact revision's `SOURCE_COMMIT` and `SHA256SUMS` out with the archive. CI fills the cache
volume from the lockfile, then invokes this controller after the checks.

## Compatibility and releases

`VERSION` and `package.json` carry the version, and `pack` refuses a mismatch. The CLI,
`delivery-kit.json`, `config.json`, the registry schema, the route schema, the registry module API
and the `var/` layout follow semver: an incompatible change needs a major version. 2.0.0 removes
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
