# Contract coverage

Every case under `cases/` runs against the built bundle.

Fixture defaults: the fake `gh` reports the default required check (`Test`) completed and successful unless a case scripts it, because a departure deploys only after CI passes. A case that names no report recipient gets a registered `dev-manager` role with a fixture conversation, because a recipient must resolve through the registry. A route fixture sets its host game's `reports.recipient`, because the review recipient is that field. The adapter installs the built bundle as the game's pinned package and replays `runner.log` as resident output. A gate worktree gets the fake `node_modules/wrangler/bin/wrangler.js` only from the `docker cp` of `node_modules/` out of a passing gate.

Decisions the cases assert:

- Adapter selection: the recipient's selected harness chooses the adapter, not the route. claude-route "the registry's harness, not the route, selects the adapter" expects a malformed or schema 1 route under a Claude registry to be rejected without the Codex path.
- Route deferral wording: an unusable `var/route.json` defers with "review route is unavailable or invalid; its owner must verify identities and ownership" (`ROUTE_INVALID_MESSAGE`).
- Routes carry no harness: a route names roles, and brief target lines name the registry role key (`briefTarget`).
- Native health events: health events such as review-stuck are delivered natively to the recipient. Cases that count slot sends count only slot requests (`slotMutations`) or only connections that delivered no event (`ownConnections`).
- CI poll interval: `ci.pollSeconds` must be at least 1; cases poll every second under the test clock.
- Resource caps: `resources.maxWorkers` is an unknown key.
- Invalid configuration: `check-config` exits 1 (`EXIT_INVALID`); usage errors exit 2.
- Receive timeouts: a native reply that never arrives is classified and latched as a timeout (child health, question state and the review history transport failure).
- CI decision: only the runs named in `ci.requiredNames` decide a watch.

fsync calls themselves are not observable from outside the process without syscall tracing (the offline image has no `strace`). The durable-write cases assert the observable half of the durable primitive: replacement by rename (a new inode) and no leftover temporary files.
