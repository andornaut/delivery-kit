# delivery-kit

Delivery Kit runs scheduled and ad hoc trunk-based Git delivery. A full departure gates the
app's local `main` HEAD in an isolated container, pushes that exact commit, watches CI and deploys
the gated build when CI passes and deployment is enabled. Eligible
[docs-only ranges](docs/reference/runner.md#departures) push and watch CI without gating or deploying.

## Install and pin

[Install or replace a pinned release](docs/guides/upgrading.md#install-and-pin).

## Commands

[CLI command reference](docs/reference/commands.md).

## Configuration

[Workspace and app configuration](docs/reference/configuration.md).

## Documentation

[Documentation index](docs/README.md).

## Developing

[Source checks, CI and packaging](docs/guides/developing.md).

## Compatibility and releases

[Versioned interfaces and release procedure](docs/guides/developing.md#compatibility-and-releases).

## Licence

[MIT](LICENSE). The licence does not cover consumer art assets or game values.
