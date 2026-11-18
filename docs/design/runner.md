# Runner

One resident runner per game runs from that game's own `node_modules`. It holds `runner.lock`
and `loop.lock`, so a second runner is refused, and writes only to its own bus directory. The
departure loop, the per-minute observer (scheduled reviews, slot reports and event flushes), the
resource sampler and the CI watches run in-process. A missed slot is never replayed.

Each departure gates local `main` HEAD in an isolated container, pushes that exact SHA without
force, watches CI for it and deploys on a pass. Fixes go forward: a red gate records
`gate-failed/<sha>` and the next departure waits for a new commit. Only the one-minute load
admits a departure; CPU and memory settings cap execution. The package check refuses a build
whose bundled coordination-kit is outside the supported range, and `status` reports the bundled
version; before each departure the runner compares the loaded package with the installed one
and finishes on the loaded code until an idle replacement. Desired delivery control is a persistent record that the runner observes.

Reference: [runner](../runner.md), [configuration](../configuration.md), [state](../state.md).

## Work items

| ID      | Title                                                   | Link                             |
| ------- | ------------------------------------------------------- | -------------------------------- |
| dk-0006 | Arm the contract runner before its review slot          | [dk-0006.md](../work/dk-0006.md) |
| dk-0013 | Wake the review observer at the start of each minute    | [dk-0013.md](../work/dk-0013.md) |
| dk-0016 | Supervise the runner with a generated systemd user unit | [dk-0016.md](../work/dk-0016.md) |
| dk-0017 | Report resident identity changes                        | [dk-0017.md](../work/dk-0017.md) |
