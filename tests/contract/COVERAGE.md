# Contract coverage

Every case under `cases/` runs against the built bundle.

Fixture defaults: the fake `gh` reports the default required check (`Test`) completed and successful unless a case scripts it, because a departure deploys only after CI passes. A case that names no report recipient gets a registered `game-coordinator` role with a fixture conversation, because a recipient must resolve through the registry. The adapter installs the built bundle as the game's pinned package and replays `runner.log` as resident output. A gate worktree gets the fake `node_modules/wrangler/bin/wrangler.js` only from the `docker cp` of `node_modules/` out of a passing gate. Every coordinator root holds the fake coordination-kit CLI (`lib/fake-coordination-kit.mjs`) at `node_modules/@andornaut/coordination-kit/dist/cli.js`; unscripted, it skips every review with `nothing-due`, ingests the event log per the cursor contract (rotated logs first, a torn last line left in place, a malformed line quarantined), and it records each call and each ingested event.

Review delivery and event delivery are coordination-kit's contract (3.0.0 and later). They cover the route, brief, store, receipts, deduplication, COMPLETE projection, guards and route fallback. The runner cases assert one initial `review deliver` call per due wall minute with the ISO slot start, no replay of a missed slot, runner lines for typed outcomes, stderr deferrals, the spawn's root and Node binary, CLI identity, and one `events ingest` call per virtual minute. A missing or out-of-range legacy CLI defers reviews and event delivery while departures continue, including the fake 2.0.1 and 9.0.0 releases. The cases also check `runner.started`, events from load-blocked and gate-failed departures, deferred ingest, drained status, rotation, torn-line repair, historical JSONL ingestion and startup refusal with an unmigrated 6.0 outbox.

The built runner uses scripted typed results to exercise compaction reservation retries. Cases step
the resident clock, verify fresh-slot priority and at most one older retry per pass, then lift the
reservation and check one delivery per original slot. Ambiguous, failed, malformed and non-deferred
results clear a pending retry and leave a fresh slot with the same outcome terminal. The reservation
case also checks one ingest request per pass and that ingest advances the cursor after release.

Decisions the cases assert:

- CI poll interval: `ci.pollSeconds` must be at least 1; cases poll every second under the test clock.
- Resource caps: `resources.maxWorkers` is an unknown key.
- Invalid configuration: `check-config` exits 1 (`EXIT_INVALID`); usage errors exit 2.
- Bundled coordination-kit. The game installs no coordination-kit package, and `status` reports the inlined version with the supported range `>=7.8.0 <9.0.0`.
- Coordinator CLI. `status` reports the last seam identity as `coordinator_cli`. The legacy CLI range is `>=3.0.0 <9.0.0`, with fake 3.0.0 and 8.0.0 acceptance. The app runner checks the installed CLI against `>=7.8.0 <9.0.0`. The pinned release runs in a synthetic coordinator root. A pre-3.0 pin defers with `cli-version`, receives no ingest request and reports `coordinator_cli.supported: false`. An in-range pin skips the unrouted review with `nothing-due`, ingests the full event log without quarantine, and returns schema 1 review and ingest results with its identity.
- COMPLETE projection. A gated departure with `deploy.mode` `none` ingests `gate_passed`, `push`, `ci_success` and `deploy_disabled`. The bound synthetic recipient uses read-only `msg history --include-body` to verify exactly one COMPLETE original for the pushed SHA.
- Observer adoption: `status` reports `observer_adoption` `current` once an in-range CLI has ingested the running runner's `runner.started`, and `unknown` with `cli_out_of_range` while the last seen CLI is 2.0.1; the stale, rotated-file, other-file cursor and unreadable cases are unit cases.
- Runner lifecycle: `runner start` without a unit spawns one detached runner and reports its PID, a second start exits 1 and starts nothing, `runner stop` signals the runner once it is idle and drained and reports both locks free, and a stop with no runner reports method `none`; desired control is unchanged. The systemd paths, the timeout and the recycled PID refusal are unit cases.
- Refused runner start: `run` exits 3 (`EXIT_REFUSED`) while another runner holds `runner.lock` or `loop.lock`, or when the 6.0 outbox is present. `runner start` exits 1 for an unmigrated outbox.
- CI decision: only the runs named in `ci.requiredNames` decide a watch.
- Gated departures: events "a passed gate appends gate_passed before the push and ingest receives it" expects one `gate_passed` (gate, ok) for the pushed SHA, appended before `push`.
- Docs-only departures: departure "a range under docs/ pushes without a gate container, watches CI and never deploys" expects one push, no gate container, no deployment and the COMPLETE inputs: `gate_skipped` (gate, skipped), `push` (ok), `deploy_skipped` (skipped) and `ci_success` (ok), with no `gate_passed` or `complete` line.

fsync calls themselves are not observable from outside the process without syscall tracing (the offline image has no `strace`). The durable-write cases assert the observable half of the durable primitive: replacement by rename (a new inode) and no leftover temporary files.
