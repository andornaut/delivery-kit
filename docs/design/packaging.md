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

Reference: [libraries](../libraries.md), [upgrading](../upgrading.md),
[Developing](../../README.md#developing), [Compatibility and releases](../../README.md#compatibility-and-releases).

## Work items

| ID      | Title                                                       | Link                             |
| ------- | ----------------------------------------------------------- | -------------------------------- |
| dk-0003 | Move design documentation from the README into docs         | [dk-0003.md](../work/dk-0003.md) |
| dk-0014 | Run only attribution and lint checks for docs-only changes  | [dk-0014.md](../work/dk-0014.md) |
| dk-0015 | Adopt the work-file convention                              | [dk-0015.md](../work/dk-0015.md) |
| dk-0018 | Split the coordination kit out of delivery-kit              | [dk-0018.md](../work/dk-0018.md) |
| dk-0019 | Leave the event delivery contract cases to coordination-kit | [dk-0019.md](../work/dk-0019.md) |
| dk-0020 | Check the bundled coordination-kit range at build time      | [dk-0020.md](../work/dk-0020.md) |
