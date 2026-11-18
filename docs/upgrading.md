# Upgrading

Breaking changes between major versions, the edits each one needs, and the removed command forms.

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

A removed form exits 2 with a one-line hint naming its replacement; there are no aliases.

| Removed form                             | Removed in | Current form                         |
| ---------------------------------------- | ---------- | ------------------------------------ |
| `channel ...`                            | 2.0.0      | `claude channel ...`                 |
| `monitor-snapshot ...`                   | 2.0.0      | `inbox snapshot ...`                 |
| `monitor-ack ...`                        | 2.0.0      | `inbox ack ...`                      |
| `resource-report --game ID`              | 2.0.0      | `status --game ID --resources`       |
| `status --harness claude`                | 2.0.0      | `claude ready`                       |
| `status --harness codex`                 | 2.0.0      | `codex ready`                        |
| `request --game ID --request-id ID`      | 2.0.0      | `request --game ID --id ID`          |
| `migrate ...`, `migrate --remove-legacy` | 2.0.0      | removed; upgrade 0.9.x through 1.0.3 |
| `monitor snapshot ...`                   | 3.0.0      | `inbox snapshot ...`                 |
| `monitor ack ...`                        | 3.0.0      | `inbox ack ...`                      |
| `claude channel --monitor UUID`          | 3.0.0      | `claude channel --conversation UUID` |
