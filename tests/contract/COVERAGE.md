# Contract coverage

Every case under `cases/` runs against the built bundle.

Fixture defaults: the fake `gh` reports the default required check (`Test`) completed and successful unless a case scripts it, because a departure deploys only after CI passes. A case that names no report recipient gets a registered `game-coordinator` role with a fixture conversation, because a recipient must resolve through the registry. The adapter installs the built bundle as the game's pinned package and replays `runner.log` as resident output. A gate worktree gets the fake `node_modules/wrangler/bin/wrangler.js` only from the `docker cp` of `node_modules/` out of a passing gate. Every coordinator root holds the fake coordination-kit CLI (`lib/fake-coordination-kit.mjs`) at `node_modules/@andornaut/coordination-kit/dist/cli.js`; unscripted, it skips every review with `nothing-due`, ingests the event log per the cursor contract (rotated logs first, a torn last line left in place, a malformed line quarantined), and it records each call and each ingested event.

Review delivery and event delivery are coordination-kit's contract (2.0.1 and later): the route, the brief, the store, receipts, deduplication, the COMPLETE projection, guards and route fallback. The cases here assert the runner side of the seam: one `review deliver` call per due wall minute with the ISO slot start, no replay of a missed slot, the runner line for each typed outcome and the stderr deferral line, deferral while the CLI is missing or outside `>=2.0.1 <3.0.0` with departures unaffected, the spawn's root, Node binary and identity report, the events a load-blocked or gate-failed departure appends, `runner.started`, one `events ingest` call per virtual minute, a deferred ingest, and, through the fake ingest, status drained, rotation, torn-line repair and the 6.0 outbox import.

Decisions the cases assert:

- CI poll interval: `ci.pollSeconds` must be at least 1; cases poll every second under the test clock.
- Resource caps: `resources.maxWorkers` is an unknown key.
- Invalid configuration: `check-config` exits 1 (`EXIT_INVALID`); usage errors exit 2.
- Bundled coordination-kit: the game installs no coordination-kit package, and `status` reports the version the bundle inlines with the supported range.
- Coordinator CLI: `status` reports the last identity a seam result carried as `coordinator_cli`, with `supported` against `>=2.0.1 <3.0.0`. The pinned coordination-kit 2.0.1 release, run in a synthetic coordinator root, answers the version probe inside the range, skips the review with `nothing-due` (no route), ingests the runner's event log with no quarantined line, and prints schema 1 `review deliver` and `events ingest` results with its identity; the fake CLI covers the error cases.
- Refused runner start: `run` exits 3 (`EXIT_REFUSED`) while another runner holds `runner.lock` or `loop.lock`.
- CI decision: only the runs named in `ci.requiredNames` decide a watch.
- Docs-only departures: departure "a range under docs/ pushes without a gate container, watches CI and never deploys" expects one push, no gate container, no deployment and the COMPLETE inputs: `gate_skipped` (gate, skipped), `push` (ok), `deploy_skipped` (skipped) and `ci_success` (ok), with no `complete` line.

fsync calls themselves are not observable from outside the process without syscall tracing (the offline image has no `strace`). The durable-write cases assert the observable half of the durable primitive: replacement by rename (a new inode) and no leftover temporary files.
