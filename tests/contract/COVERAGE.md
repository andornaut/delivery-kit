# Contract coverage

Every case under `cases/` runs against the built bundle.

Fixture defaults: the fake `gh` reports the default required check (`Test`) completed and successful unless a case scripts it, because a departure deploys only after CI passes. A case that names no report recipient gets a registered `game-coordinator` role with a fixture conversation, because a recipient must resolve through the registry. A route fixture sets its host game's `reports.recipient`, because the review recipient is that field. The adapter installs the built bundle as the game's pinned package and replays `runner.log` as resident output. The Claude channel consumer is coordination-kit's CLI from this checkout's `node_modules`. A gate worktree gets the fake `node_modules/wrangler/bin/wrangler.js` only from the `docker cp` of `node_modules/` out of a passing gate.

Decisions the cases assert:

- Routes carry no harness: a route names roles, and brief target lines name the registry role key (`briefTarget`).
- Native health events: health events such as review-stuck are delivered natively to the recipient. Cases that count slot sends count only slot requests (`slotMutations`) or only connections that delivered no event (`ownConnections`).
- CI poll interval: `ci.pollSeconds` must be at least 1; cases poll every second under the test clock.
- Resource caps: `resources.maxWorkers` is an unknown key.
- Invalid configuration: `check-config` exits 1 (`EXIT_INVALID`); usage errors exit 2.
- Bundled coordination-kit: the game installs no coordination-kit package, and `status` reports the version the bundle inlines with the supported range.
- Refused runner start: `run` exits 3 (`EXIT_REFUSED`) while another runner holds `runner.lock` or `loop.lock`.
- CI decision: only the runs named in `ci.requiredNames` decide a watch.
- Docs-only departures: departure "a range under docs/ pushes without a gate container, watches CI and never deploys" expects one push, no gate container, no deployment and a `complete` report that names the skipped gate.

fsync calls themselves are not observable from outside the process without syscall tracing (the offline image has no `strace`). The durable-write cases assert the observable half of the durable primitive: replacement by rename (a new inode) and no leftover temporary files.
