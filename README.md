# delivery-kit

Delivery Kit runs scheduled and ad hoc trunk-based Git delivery. A full departure gates the
app's local `main` HEAD in an isolated container, pushes that exact commit, watches CI and deploys
the gated build when CI passes and deployment is enabled. Eligible
[docs-only ranges](docs/runner.md#departures) push and watch CI without gating or deploying.

## Install and pin

[Install or replace a pinned release](docs/upgrading.md#install-and-pin).

## Commands

[CLI command reference](docs/commands.md).

## Configuration

[Workspace and app configuration](docs/configuration.md).

## Documentation

[Documentation index](docs/README.md).

## Developing

[Source checks, CI and packaging](docs/developing.md).

## Compatibility and releases

[Versioned interfaces and release procedure](docs/developing.md#compatibility-and-releases).

## Licence

[MIT](LICENSE). The licence does not cover consumer art assets or game values.
