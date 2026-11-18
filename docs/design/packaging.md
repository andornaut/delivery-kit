# Packaging

The package is `@andornaut/delivery-kit`. `dist/cli.js` is the only runtime entry point and
imports only `node:` builtins; the public build APIs are explicit canonical subpaths with
deprecated compatibility aliases. The npm package ships `dist/`, the README, the topic docs, the
design summaries, `LICENSE` and `SOURCE_COMMIT`; work files are not packaged. The `make` targets
run every check in stock containers with the checkout bound read-only, and CI runs the same npm
commands natively. Releases are cut from `main` only after every
required CI workflow passes on the exact commit, and a published tag is never moved. Public
interfaces follow semver.

Reference: [libraries](../libraries.md), [upgrading](../upgrading.md),
[Developing](../../README.md#developing), [Compatibility and releases](../../README.md#compatibility-and-releases).

## Work items

| ID      | Title                                                      | Link                             |
| ------- | ---------------------------------------------------------- | -------------------------------- |
| dk-0003 | Move design documentation from the README into docs        | [dk-0003.md](../work/dk-0003.md) |
| dk-0014 | Run only attribution and lint checks for docs-only changes | [dk-0014.md](../work/dk-0014.md) |
| dk-0015 | Adopt the work-file convention                             | [dk-0015.md](../work/dk-0015.md) |
| dk-0018 | Split the coordination kit out of delivery-kit             | [dk-0018.md](../work/dk-0018.md) |
