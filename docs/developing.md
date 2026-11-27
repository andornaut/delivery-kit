# Developing

The `@andornaut/delivery-kit` package provides the operator CLI,
bundled into `dist/cli.js` with the Coordination Kit modules it uses. The bundle imports only
`node:` builtins and has no dynamic `import()`, relative `require`, worker threads or source maps.

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
Its `changes` and `lint` jobs run on pushes to `main` and `release-*` branches and on pull
requests. `lint` checks types, Prettier, ESLint and Markdown. The separate attribution workflow
runs on branch pushes and pull requests. The `build`, `test`, `contract` and `package` jobs
skip when the classifier finds a non-empty diff entirely under `docs/`. A change to the
[root README](../README.md), an empty diff, a forced push, a new branch or an unverified base runs every job.

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

- `delivery-kit-VERSION.tgz`, the npm package (`dist/`, `README.md`, [operator and design docs](README.md), `LICENSE` and `SOURCE_COMMIT`);
- `SOURCE_COMMIT`, the exact commit it was built from, also inside the archive;
- `SHA256SUMS`, covering the archive and `SOURCE_COMMIT`.

The release owner pushes the release commit to `main`, verifies every required CI workflow
succeeded for that exact commit, then tags `vVERSION` there and attaches the `pack` output. A
published tag is never moved.

Work items are available in the [repository work index](https://github.com/andornaut/delivery-kit/tree/main/docs/work).
