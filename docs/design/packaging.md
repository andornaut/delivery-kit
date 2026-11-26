# Packaging

The package is `@andornaut/delivery-kit`. `dist/cli.js` is the only runtime entry point; it
inlines the coordination-kit modules it uses and imports only `node:` builtins. The one public
build API is `build/source-identity`, with a deprecated compatibility alias. delivery-kit
depends one way on `@andornaut/coordination-kit` through its `build/` subpaths, pinned as a
devDependency on the release asset like a game pins delivery-kit, and declares the coordination-kit
range it supports once. The npm package ships `dist/`, the README, the topic docs, the
design summaries, `LICENSE` and `SOURCE_COMMIT`; work files are not packaged. The `make` targets
run every check in stock containers with the checkout bound read-only, and CI runs the same npm
commands natively. Releases are cut from `main` only after every
required CI workflow passes on the exact commit, and a published tag is never moved. Public
interfaces follow semver.

The source is layered, and each module imports only its own group and lower layers: `src/lib/`
(child processes, files, clock, zoned time and the test clock and load overrides),
`src/compatibility.ts` and `src/source-identity.ts`; then `src/state/` (the bus directory's files);
then `src/status/` (the read-only report), `src/seam/` (the coordinator CLI) and `src/gate/` (the
gate container); then `src/runner/` (the resident process, departures, CI and deployment) and
`src/supervision/` (runner start, stop and the systemd unit); then `src/commands/`, `src/cli.ts` and
`src/bin.ts`. A group is a directory or a module directly in `src/`, and groups in one layer do not
import each other. `src/testing/` holds test fixtures; shipped code never imports it, `scripts/` or
`tests/`. ESLint guards the layers with `no-restricted-imports`, type-only imports included, and
rejects runtime import cycles in `src/`, `scripts/` and `tests/` with `import-x/no-cycle`. Imports
of only types are written `import type`, so the cycle rule sees every runtime import.

Reference: [libraries](../libraries.md), [upgrading](../upgrading.md),
[Developing](../../README.md#developing), [Compatibility and releases](../../README.md#compatibility-and-releases).

## Work items

| ID      | Title                                                                 | Link                             |
| ------- | --------------------------------------------------------------------- | -------------------------------- |
| dk-0003 | Move design documentation from the README into docs                   | [dk-0003.md](../work/dk-0003.md) |
| dk-0014 | Run only attribution and lint checks for docs-only changes            | [dk-0014.md](../work/dk-0014.md) |
| dk-0015 | Adopt the work-file convention                                        | [dk-0015.md](../work/dk-0015.md) |
| dk-0018 | Split the coordination kit out of delivery-kit                        | [dk-0018.md](../work/dk-0018.md) |
| dk-0019 | Leave the event delivery contract cases to coordination-kit           | [dk-0019.md](../work/dk-0019.md) |
| dk-0020 | Check the bundled coordination-kit range at build time                | [dk-0020.md](../work/dk-0020.md) |
| dk-0021 | Release 5.0.2 with coordination-kit 1.0.2                             | [dk-0021.md](../work/dk-0021.md) |
| dk-0023 | Audit the documentation after the coordination-kit split              | [dk-0023.md](../work/dk-0023.md) |
| dk-0024 | Run path-filtered CI jobs unless the classification reports docs-only | [dk-0024.md](../work/dk-0024.md) |
| dk-0030 | Prune redundant tests and measure the result                          | [dk-0030.md](../work/dk-0030.md) |
| dk-0037 | Cap release packaging containers at 4 GiB                             | [dk-0037.md](../work/dk-0037.md) |
| dk-0039 | Simplify Delivery Kit without changing active contracts               | [dk-0039.md](../work/dk-0039.md) |
| dk-0046 | Reject import cycles in scripts and tests                             | [dk-0046.md](../work/dk-0046.md) |
| dk-0047 | Guard the module layers with ESLint                                   | [dk-0047.md](../work/dk-0047.md) |
| dk-0050 | Write type-only imports as import type                                | [dk-0050.md](../work/dk-0050.md) |
| dk-0051 | Audit Delivery Kit 8.5 documentation                                  | [dk-0051.md](../work/dk-0051.md) |
| dk-0052 | Add Dependabot coverage for Actions and npm                          | [dk-0052.md](../work/dk-0052.md) |
