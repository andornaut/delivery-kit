# Documentation

Each app has a repository, `delivery-kit.json`, credentials and a schedule. The workspace root
holds `config.json`, the registry and runner state under `var/`. A single app can use its own
repository as the workspace root.

[Coordination Kit](https://github.com/andornaut/coordination-kit) owns the role registry, durable
role messages, harness adapters, inbox review and the work store. The resident runner calls the
workspace-installed Coordination Kit CLI for scheduled reviews and [event ingestion](reference/runner.md#event-log).
Delivery Kit has no direct access to the Coordination Kit store or work protocol state.

- [Guides](guides/README.md) covers installation, upgrades, development and releases.
- [Reference](reference/README.md) documents the CLI, configuration, runner, state and APIs.

## Design and work

- [Design](design/README.md) summarizes each design area and links to its reference pages and work items.
- [Work items](https://github.com/andornaut/delivery-kit/tree/main/docs/work) documents the work-file convention and lists the source repository's work files. The npm package excludes this directory.
