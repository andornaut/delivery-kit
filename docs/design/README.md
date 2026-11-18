# Design

Each area has a short design summary and an index of its work items. The topic docs in
[docs/](..) remain the detailed reference. Work items and their convention are in
[docs/work/](../work/README.md).

| Area                              | Covers                                                                                 | Topic docs                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [runner](runner.md)               | The resident runner, departures, the gate container, the observer and supervision      | [runner](../runner.md), [configuration](../configuration.md), [state](../state.md)               |
| [messages](messages.md)           | Common message send, dispatch, delivery guards, the Claude spool and reconciliation    | [messages](../messages.md), [commands](../commands.md)                                           |
| [review](review.md)               | The review route, the Claude and Codex adapters and inbox snapshots                    | [review](../review.md), [commands](../commands.md)                                               |
| [registry](registry.md)           | The role registry, harness selection, send-time resolution and readiness               | [registry](../registry.md)                                                                       |
| [work-protocol](work-protocol.md) | Fenced publications, message originals, handling receipts, enrollment and accounting   | [work-protocol](../work-protocol.md), [request-accounting](../request-accounting.md)             |
| [packaging](packaging.md)         | The CLI bundle, public build APIs, checks, CI, package contents, releases and the docs | [libraries](../libraries.md), [upgrading](../upgrading.md), [README](../../README.md#developing) |
