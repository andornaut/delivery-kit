# Runner

One resident runner per game runs from that game's own `node_modules`. It holds `runner.lock`
and `loop.lock`, so a second runner is refused. Runner state and gate worktrees live under its
bus directory. The departure loop, the per-minute observer (scheduled reviews, slot reports
and event ingests), the
resource sampler and the CI watches run in-process. Reviews and event ingest are child processes
of the coordinator-installed coordination-kit CLI with a typed result, a 45 s deadline and a
process-group kill; a failed call claims no delivery and never holds a departure. A missed slot
is never replayed. The runner is the only writer of its append-only event log; the CLI's ingest
cursor is the only state it reads back, so `status` reports drain without the store. Every start
appends `runner.started` with its identity token, and `status` derives observer adoption from
that line, the cursor and the last seen CLI, reading no store or work protocol.

Each departure gates local `main` HEAD in an isolated container, pushes that exact SHA without
force, watches CI for it and deploys on a pass. Fixes go forward: a red gate records
`gate-failed/<sha>` and the next departure waits for a new commit. An install that exits 0 but
leaves out an optional package the commit's lock lists for the container's platform blocks the
gate as infrastructure, so the next departure retries it. Only the one-minute load
admits a departure; CPU and memory settings cap execution. The package check refuses a build
whose bundled coordination-kit is outside the supported range, and `status` reports the bundled
version; before each departure the runner compares the loaded package with the installed one
and finishes on the loaded code until an idle replacement. Desired delivery control is a persistent record that the runner observes.

Reference: [runner](../runner.md), [configuration](../configuration.md), [state](../state.md).

## Work items

| ID      | Title                                                                              | Link                             |
| ------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| dk-0006 | Arm the contract runner before its review slot                                     | [dk-0006.md](../work/dk-0006.md) |
| dk-0013 | Wake the review observer at the start of each minute                               | [dk-0013.md](../work/dk-0013.md) |
| dk-0016 | Supervise the runner with a generated systemd user unit                            | [dk-0016.md](../work/dk-0016.md) |
| dk-0017 | Report resident identity changes                                                   | [dk-0017.md](../work/dk-0017.md) |
| dk-0022 | Call the coordinator-installed coordination-kit CLI for reviews and event delivery | [dk-0022.md](../work/dk-0022.md) |
| dk-0025 | Record runner events in a per-game append-only log                                 | [dk-0025.md](../work/dk-0025.md) |
| dk-0026 | Derive observer adoption from the runner's own start record                        | [dk-0026.md](../work/dk-0026.md) |
| dk-0027 | Report the slot's own departure correctly in scheduled-slot status                 | [dk-0027.md](../work/dk-0027.md) |
| dk-0028 | Stop and start a game's runner with one command                                    | [dk-0028.md](../work/dk-0028.md) |
| dk-0031 | Bind the stock gate to the verified source identity                                | [dk-0031.md](../work/dk-0031.md) |
| dk-0034 | Log a gate_passed event so every passed departure completes                        | [dk-0034.md](../work/dk-0034.md) |
| dk-0035 | Word the slot report so an idle check does not read as a departure                 | [dk-0035.md](../work/dk-0035.md) |
| dk-0036 | Expose the verified SHA captured for a departure                                   | [dk-0036.md](../work/dk-0036.md) |
| dk-0038 | Fix departure, retry and verification review findings                              | [dk-0038.md](../work/dk-0038.md) |
| dk-0040 | Qualify Coordination Kit 4.x at the runner seam                                    | [dk-0040.md](../work/dk-0040.md) |
| dk-0042 | Qualify Coordination Kit 5.x at the runner seam                                    | [dk-0042.md](../work/dk-0042.md) |
| dk-0043 | Qualify Coordination Kit 6.x at the runner seam                                    | [dk-0043.md](../work/dk-0043.md) |
| dk-0044 | Refactor for structure, encapsulation and simplicity                               | [dk-0044.md](../work/dk-0044.md) |
| dk-0045 | Finish the refactor follow-ups                                                     | [dk-0045.md](../work/dk-0045.md) |
| dk-0048 | Qualify Coordination Kit 7.x at the runner seam                                    | [dk-0048.md](../work/dk-0048.md) |
| dk-0049 | Block a gate whose install skipped a locked optional package                       | [dk-0049.md](../work/dk-0049.md) |
