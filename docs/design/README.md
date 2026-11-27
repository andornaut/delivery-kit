# Design

Each area summarizes the design and indexes its work items. The [documentation index](../README.md)
links to the detailed reference. Work-item links open the source repository. Start at the
[work index](https://github.com/andornaut/delivery-kit/tree/main/docs/work) for the convention and file list.

| Area                              | Covers                                                                                     | Topic docs                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [runner](runner.md)               | The resident runner, departures, the gate container, the observer and supervision          | [runner](../reference/runner.md), [configuration](../reference/configuration.md), [state](../reference/state.md)   |
| [messages](messages.md)           | Moved to coordination-kit: common messages, delivery guards and the Claude spool           | [messages](../reference/messages.md), [commands](../reference/commands.md)                                         |
| [review](review.md)               | The review seam the runner calls and its bus events; the route and adapters moved          | [review](../reference/review.md), [commands](../reference/commands.md)                                             |
| [registry](registry.md)           | Moved to coordination-kit: the role registry, harness selection and readiness              | [registry](../reference/registry.md)                                                                               |
| [work-protocol](work-protocol.md) | Moved to coordination-kit: the work protocol, enrollment and request accounting            | [work-protocol](../reference/work-protocol.md), [request-accounting](../reference/request-accounting.md)           |
| [packaging](packaging.md)         | The CLI bundle, the coordination-kit dependency, checks, CI, package contents and releases | [libraries](../reference/libraries.md), [upgrading](../guides/upgrading.md), [developing](../guides/developing.md) |
