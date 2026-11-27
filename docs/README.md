# Documentation

Each app has a repository, `delivery-kit.json`, credentials and a schedule. The workspace root
holds `config.json`, the registry and runner state under `var/`. A single app can use its own
repository as the workspace root.

[Coordination Kit](https://github.com/andornaut/coordination-kit) owns the role registry, durable
role messages, harness adapters, inbox review and the work store. The resident runner calls the
workspace-installed Coordination Kit CLI for scheduled reviews and [event ingestion](runner.md#event-log).
Delivery Kit has no direct access to the Coordination Kit store or work protocol state.

| Doc                                            | Covers                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [commands.md](commands.md)                     | CLI options, command semantics, authorization and moved commands           |
| [configuration.md](configuration.md)           | Workspace and app configuration, including schedules, gates and deployment |
| [registry.md](registry.md)                     | Registry role bindings and delivery ownership                              |
| [messages.md](messages.md)                     | Common role messaging in Coordination Kit                                  |
| [review.md](review.md)                         | Scheduled review calls, bus events and remedies                            |
| [state.md](state.md)                           | State layout, durable writes and delivery control                          |
| [runner.md](runner.md)                         | Runner operation, supervision, pin checks, departures and gate containers  |
| [libraries.md](libraries.md)                   | Public source identity API, its alias and moved subpaths                   |
| [request-accounting.md](request-accounting.md) | The request ledger in Coordination Kit                                     |
| [work-protocol.md](work-protocol.md)           | The work protocol in Coordination Kit                                      |
| [upgrading.md](upgrading.md)                   | Installation and pins, version upgrades and removed commands               |
| [developing.md](developing.md)                 | Source checks, CI, packaging and releases                                  |

## Design and work

- [Design](design/README.md) summarizes each design area and links to its reference pages and work items.
- [Work items](https://github.com/andornaut/delivery-kit/tree/main/docs/work) documents the work-file convention and lists the source repository's work files. The npm package excludes this directory.
