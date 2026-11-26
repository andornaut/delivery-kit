# Design

Each area has a short design summary and an index of its work items. The topic docs in
[docs/](..) remain the detailed reference. Work items and their convention are in
[docs/work/](../work/README.md). Work-item links require the repository checkout because the
npm archive omits `docs/work/`.

| Area                              | Covers                                                                                     | Topic docs                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [runner](runner.md)               | The resident runner, departures, the gate container, the observer and supervision          | [runner](../runner.md), [configuration](../configuration.md), [state](../state.md)               |
| [messages](messages.md)           | Moved to coordination-kit: common messages, delivery guards and the Claude spool           | [messages](../messages.md), [commands](../commands.md)                                           |
| [review](review.md)               | The review seam the runner calls and its bus events; the route and adapters moved          | [review](../review.md), [commands](../commands.md)                                               |
| [registry](registry.md)           | Moved to coordination-kit: the role registry, harness selection and readiness              | [registry](../registry.md)                                                                       |
| [work-protocol](work-protocol.md) | Moved to coordination-kit: the work protocol, enrollment and request accounting            | [work-protocol](../work-protocol.md), [request-accounting](../request-accounting.md)             |
| [packaging](packaging.md)         | The CLI bundle, the coordination-kit dependency, checks, CI, package contents and releases | [libraries](../libraries.md), [upgrading](../upgrading.md), [README](../../README.md#developing) |
