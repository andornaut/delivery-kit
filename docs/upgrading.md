# Upgrading

Breaking changes between major versions, the edits each one needs, and the removed command forms.

## Upgrading to 5.0

5.0.0 moves the coordination commands, libraries and docs to `@andornaut/coordination-kit` and
keeps the game operations: `run`, `runner unit`, `status`, `control`, `check-config` and
`request`. State does not move: both kits read and write the `var/` layout and byte formats of
4.7.0.

- Pins: a game pins only delivery-kit, which bundles coordination-kit; delivery-kit 5 bundles
  coordination-kit 1.x; 5.0.1 supports `>=1.0.1 <2.0.0` ([Pin guard](runner.md#pin-guard)).
  game-coordinator pins coordination-kit directly for the roles' CLI and the channel MCP server,
  beside its delivery-kit pin for `check-config` and `status`. The two installs exchange data only
  through the on-disk formats, which stay compatible within coordination-kit 1.x. Pin each release
  asset as a devDependency, commit the lockfile integrity, run `npm ci`, then replace the runner
  while idle:

  ```json
  "devDependencies": {
    "@andornaut/delivery-kit": "https://github.com/andornaut/delivery-kit/releases/download/v5.0.1/delivery-kit-5.0.1.tgz"
  }
  ```

  game-coordinator adds:

  ```json
  "devDependencies": {
    "@andornaut/coordination-kit": "https://github.com/andornaut/coordination-kit/releases/download/v1.0.1/coordination-kit-1.0.1.tgz"
  }
  ```

  From 5.0.0 to 5.0.1, a game only reinstalls delivery-kit 5.0.1, which bundles
  coordination-kit 1.0.1. game-coordinator's coordination-kit pin may stay on any 1.0.x release:
  1.0.1 changes only tests and docs, so its runtime, CLI, exports and formats match 1.0.0.

- Commands: each moved command keeps its options, JSON output and exit codes under
  `coordination-kit`. delivery-kit 5 refuses the old form with exit 2 and a one-line hint naming
  the new one. Update scripts and agent instructions:

  | delivery-kit 4.x command                           | coordination-kit 1.x command            |
  | -------------------------------------------------- | --------------------------------------- |
  | `delivery-kit inbox snapshot`                      | `coordination-kit inbox snapshot`       |
  | `delivery-kit inbox ack`                           | `coordination-kit inbox ack`            |
  | `delivery-kit message send`                        | `coordination-kit message send`         |
  | `delivery-kit message dispatch`                    | `coordination-kit message dispatch`     |
  | `delivery-kit message status`                      | `coordination-kit message status`       |
  | `delivery-kit message reconcile`                   | `coordination-kit message reconcile`    |
  | `delivery-kit message retire-spool`                | `coordination-kit message retire-spool` |
  | `delivery-kit ledger intake`                       | `coordination-kit ledger intake`        |
  | `delivery-kit ledger apply`                        | `coordination-kit ledger apply`         |
  | `delivery-kit ledger show`                         | `coordination-kit ledger show`          |
  | `delivery-kit ledger report`                       | `coordination-kit ledger report`        |
  | `delivery-kit ledger history`                      | `coordination-kit ledger history`       |
  | `delivery-kit ledger coverage`                     | `coordination-kit ledger coverage`      |
  | `delivery-kit ledger reconcile`                    | `coordination-kit ledger reconcile`     |
  | `delivery-kit ledger boundary`                     | `coordination-kit ledger boundary`      |
  | `delivery-kit harness doctor`                      | `coordination-kit harness doctor`       |
  | `delivery-kit harness ready`                       | `coordination-kit harness ready`        |
  | `delivery-kit harness select`                      | `coordination-kit harness select`       |
  | `delivery-kit claude ready`                        | `coordination-kit claude ready`         |
  | `delivery-kit claude channel`                      | `coordination-kit claude channel`       |
  | `delivery-kit codex ready`                         | `coordination-kit codex ready`          |
  | `delivery-kit protocol VERB` (every protocol verb) | `coordination-kit protocol VERB`        |

- Channel MCP configuration: run `coordination-kit ... claude channel` in place of
  `delivery-kit ... claude channel`. The server still identifies itself as
  `delivery-kit-channel`, so an existing server key needs no change.
- Root: delivery-kit resolves `--root`, then `DELIVERY_KIT_ROOT`. coordination-kit also accepts
  both and prefers a nonempty `COORDINATION_KIT_ROOT`.
- Library imports: delivery-kit no longer exports `/build/registry`, `/build/transport`,
  `/build/accounting` or `/build/protocol`, nor their unprefixed aliases `/registry`,
  `/transport`, `/accounting` and `/protocol`, under `@andornaut/delivery-kit`. Import the same
  symbols from `@andornaut/coordination-kit/build/registry`, `/build/transport`,
  `/build/accounting` and `/build/protocol`; coordination-kit has no unprefixed aliases.
  `@andornaut/delivery-kit/build/source-identity` and its alias are unchanged.

## Upgrading to 4.7

`run --game` now exits 3, not 1, when another runner holds `runner.lock` or `loop.lock`.
Invalid configuration still exits 1. Scripts that treat 1 as "already running" must check 3.

## Upgrading to 4.0

Version 4.0 requires an explicit `resources.memoryMiB` in every game configuration, including
configurations created with 3.x. The value must be an integer from 6 through 8192 because
[Docker requires at least 6 MiB](https://docs.docker.com/engine/containers/resource_constraints/#limit-a-containers-access-to-memory).
Missing or invalid values fail configuration validation before a gate container starts.
There is no default or automatic configuration rewrite. The 3.x validators reject the new field,
so the owning Tech must coordinate the configuration and package pin changes in a controlled
idle adoption. Do not edit the live configuration early. Preserve delivery controls, locks,
reports and departure cadence during adoption.

## Upgrading to 3.0

3.0.0 removes duties and the route's `monitor` field. A game's scheduled review goes to the role
its `delivery-kit.json` names as `reports.recipient`, the same role that receives its events.
A 2.x reader cannot use a schema 2 route or resolve a duty after the edits, so every pin (each
game and game-coordinator) moves to 3.0.0 in the same idle replacement window.

- `var/registry.json`: remove `duties` from every role, and replace each duty name with the role
  key that held it, in `operations.<game>.busOwner` and anywhere else a role is named. A role that
  still has `duties` fails validation with this edit. The registry schema stays 1.
- `var/route.json`: remove `monitor` and set `schema` to 2. The host game's `reports.recipient`
  receives the review. A schema 1 route defers every review and is reported by `check-config`.
- Each `delivery-kit.json`: `reports.recipient` and `reports.workerParents` name registered role
  keys (for example `game-coordinator`), never a duty.
- Channel MCP configuration: replace `--monitor UUID` with `--conversation UUID`, or omit it to
  serve the selected games' `reports.recipient`. The example server key is `delivery-kit-channel`.
- Scripts and instructions: `inbox snapshot` and `inbox ack` replace `monitor snapshot` and
  `monitor ack`, with the same options. Role arguments (`--requester`, `--role`, `--recipient`,
  `--parent`) take role keys, not duties.
- Output: runner lines read `bus: scheduled review SLOT:` and `bus: review deferred:`; slot and
  health fields are `review_status`, `review_reason` and `recipient_session_status`, slot receipts
  carry `recipient`, and the health event kind is `review-stuck`. Claude review briefs are spooled
  with kind `review`; an entry a 2.x runner spooled is still delivered. Inbox state changes
  serialize on `unblock/inbox.lock`.
- Registry module: `AmbiguousRole` is removed, `resolveRole` accepts only registered role keys, and
  `Layout.monitorDir` is `Layout.reviewDir`.

## Removed command forms

A removed form exits 2; there are no aliases. Each prints a one-line hint naming its replacement,
except `migrate`, which prints the usage text, and `request --request-id`, which is refused as an
unknown option with the `request` usage line.

| Removed form                                                                       | Removed in | Current form                                                                 |
| ---------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `channel ...`                                                                      | 2.0.0      | `coordination-kit claude channel ...`                                        |
| `monitor-snapshot ...`                                                             | 2.0.0      | `coordination-kit inbox snapshot ...`                                        |
| `monitor-ack ...`                                                                  | 2.0.0      | `coordination-kit inbox ack ...`                                             |
| `resource-report --game ID`                                                        | 2.0.0      | `status --game ID --resources`                                               |
| `status --harness claude`                                                          | 2.0.0      | `coordination-kit claude ready`                                              |
| `status --harness codex`                                                           | 2.0.0      | `coordination-kit codex ready`                                               |
| `request --game ID --request-id ID`                                                | 2.0.0      | `request --game ID --id ID`                                                  |
| `migrate ...`, `migrate --remove-legacy`                                           | 2.0.0      | removed; upgrade 0.9.x through 1.0.3                                         |
| `monitor snapshot ...`                                                             | 3.0.0      | `coordination-kit inbox snapshot ...`                                        |
| `monitor ack ...`                                                                  | 3.0.0      | `coordination-kit inbox ack ...`                                             |
| `claude channel --monitor UUID`                                                    | 3.0.0      | `coordination-kit claude channel --conversation UUID`                        |
| `inbox`, `message`, `ledger`, `harness`, `protocol`, `claude` and `codex` commands | 5.0.0      | `coordination-kit GROUP VERB ...` (see [Upgrading to 5.0](#upgrading-to-50)) |
