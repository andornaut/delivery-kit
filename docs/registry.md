# Registry

The shared role registry `var/registry.json`, scoped harness selection, send-time conversation resolution, the readiness probe and the scoped harness doctor.

`var/registry.json` (schema 1) is shared by delivery-kit and the game-sessions skills. It records
ownership and the conversation ID of each role per harness. It never proves activation on its
own: `transfers` carries the hold, acceptance and activation markers.

| Field                             | Content                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `revision`, `updatedAt` | `1`, a non-negative integer incremented on every write, and a UTC timestamp.                                                                                                                          |
| `harness`                         | `claude` or `codex`: the default harness for roles without an override.                                                                                                                               |
| `host`                            | `nativeProjectId` and `root` (relative to game-coordinator).                                                                                                                                          |
| `roles.<key>`                     | `ownership`, `worktree` (relative to game-coordinator), `conversations` (`claude` and `codex`, each an ID or null), and optional `harness`, `branch`, `phase`, `activation` (`marker`, `checkpoint`). |
| `operations.<game>`               | `busOwner` (a role key), optional `activation.marker` and `lastAdoption` (`at`, `version`, `cliSha256`, optional `integrity` and `evidenceRef: "protocol-artifact:<audit hash>"`).                    |
| `transfers[]`                     | `marker`, `from`, `to`, `phase` (`source-held`, `accepted` or `active-confirmed`), `roles` and `checkpoint`.                                                                                          |

- Every role key must be a role key in `config.json`, and every `operations` key a game.
- Role references (`busOwner`, `reports.recipient`, `reports.workerParents`, `--requester`,
  `--role`, `--recipient`, `--parent`) use registered role keys; explicit inbox conversation UUID
  selectors follow the [inbox validation rules](commands.md#command-semantics). There are no role aliases.
- Every writer holds `var/registry.lock`, rejects a changed `revision`, validates the result,
  writes durably and increments `revision`.
- The skills own every field except `operations.*.lastAdoption`, which is reserved for
  supported resident-adoption recording. The harness-selection CLI changes only selected roles' `harness` overrides and
  registry revision metadata; it preserves all other fields, including `operations`.

`protocol observer-adoption` durably records the owner's resident-inspection evidence and its
audit, binds the command in the role journal, then updates `lastAdoption` under registry revision
CAS. Managed activation verifies the committed command, `evidenceRef` pointer, audit and referenced
resident proof together. A package pin, matching
version/hash or returned-only result is not that durable adoption evidence. See
[declaration, enrollment and rollout](work-protocol.md#declaration-enrollment-and-rollout)
for the supported producer and partial-update reconciliation contract.

## Scoped harness selection

`roles.<role>.harness`, when present, is `claude` or `codex`. An absent override falls back to the
top-level `harness`, preserving the global-only schema 1 behaviour. Selection records an adapter
choice, not activation, target startup, ownership acceptance, delivery control or permission to
clear a hold or question. Changing selection requires the caller's explicit authority for that
exact scope.

Older schema 1 readers reject the new role field. Upgrade every reader of the shared registry
through a reviewed consumer pin before writing any override. A successful readiness probe does
not authorize adoption or mutation.

After explicit approval and the reader upgrades, probe the selected target and apply one atomic,
revision-checked selection, using the freshly read registry revision for `N`:

```sh
delivery-kit claude ready \
  --game archies-dog-walks \
  --game chibis-way-home
delivery-kit harness select \
  --harness claude \
  --expected-revision N \
  --game archies-dog-walks \
  --game chibis-way-home
```

Each `--game` selects every configured role for that game. Repeat `--role` to select additional
registered role names; the union is changed once. Missing or invalid roles,
an unknown game, an unavailable selected conversation ID, or a changed revision refuse the entire mutation. At least one scope is
required, so this command never implicitly switches the global default. `--harness default`
removes only the selected overrides. Unselected games, shared roles, conversation IDs, worktrees,
activation markers, operations, delivery state and schedules remain unchanged. No provider is
started and no runner is restarted by selection.

## Send-time resolution

Route, configuration, briefs and events name roles, never conversation IDs. Each wake, event
delivery, inbox snapshot, acknowledgement and readiness probe reads `var/registry.json` when it
sends: the role's optional `harness` override, otherwise the registry default, selects the adapter;
`roles.<role>.conversations.<effective harness>` gives the ID.
Nothing is cached across sends. A missing or null ID is reported `unavailable` for that role,
never as clearance.

A scoped harness handoff selects only its approved roles, with no configuration edit, runner
restart or delivery-state change. The other harness's IDs stay in place. Activation still needs
its separate hold, acceptance and activation checks.

Recipient decision records (`unblock/decisions/<conversation>.json`) stay keyed by conversation
ID, because a pending question belongs to one conversation. Their owner writes them; delivery-kit
only reads them, and a missing or invalid record is never clearance.

## Readiness probe

`claude ready` and `codex ready` send nothing and reports whether that adapter can deliver now:

- Claude: `claude agents --json` returns a listing.
- Codex: `CODEX_CONTROL_SOCKET` names an absolute socket path that accepts a connection.
- The route's recipient and every target, or every game's `reports.recipient` when there is no
  route, have a conversation ID for that harness. An invalid route is never ready.

Output is one JSON line:

```json
{
  "harness": "codex",
  "adapter": { "status": "available", "reason": null },
  "roles": [{ "role": "game-coordinator", "conversation": "<uuid>", "status": "resolved" }],
  "ready": true
}
```

Unscoped `claude ready` and `codex ready` retain this output and probe every route role against
the requested target harness. With `--game` or `--role`, they probe only the selected roles and
add `current_harness` and `probed_harness` to each role row. Unselected games and kits need no
conversation ID for that target. Scopes never create or modify a registry entry.

`harness ready` probes the current effective harness for each selected role. Without a scope it
uses the route recipient and targets, or every game's recipient without a route. Its output contains
`harness: "mixed"`, an `adapters` object keyed by each required harness, the role rows with
`current_harness` and `probed_harness`, and `ready`. Each distinct adapter is probed once. Missing
IDs or unavailable adapter capabilities make the result not ready; an invalid selection fails
closed. These are adapter-and-conversation probes, not proof that questions, queues or ownership
checks are clear.

Readiness exits 0 when ready and 1 when not, including when the registry is missing or the layout
cannot be read. Malformed command options exit 2. It sends nothing and activates nothing.

## Scoped harness doctor

`delivery-kit harness doctor --role ROLE` diagnoses only the role's current effective harness.
Repeat `--role` or `--game ID` to select more roles. At least one nonempty explicit scope is
required; an invalid selection fails before any probe. It sends nothing, performs no queue
writes, starts no frontend and changes no registry, HOLD, activation or draft state.

Output is one JSON line with `schema: 1` and `roles`. Each row includes the exact `role`,
`effective_harness`, `native_id`, `endpoint` path and source, registry `config_reference`,
`channel_reference`, `native_session`, and `layers` for adapter, service, frontend, bridge and channel. Layer
statuses distinguish `available`, `unavailable`, `unknown` and `held`; a registry entry alone
never proves a native HOLD or activation. Inactive bindings are skipped as unknown, and
unselected harnesses are not probed. `failed_layer`, `recovery_owner` and
`supported_next_action` identify an observed failure and its supported diagnostic follow-up.
Recovery actions are reported, never executed. Unknown capabilities remain unknown even when
`failed_layer` is null. Exit 0 means the report has no observed failed layer, not that all
layers are healthy or delivery is safe. Observed failures or invalid configuration exit 1;
malformed options or missing scope exit 2.

Read-only probe eligibility requires `ownership: "active"` and excludes phases `held` and
`source-held`. Other phases, including `prototype-approved`, describe product scope and do not
disable probes. Eligibility never proves native HOLD clearance or activation.

Codex endpoint selection uses `resolveCodexControlSocket({env?, home?, controlSocket?})`:
explicit option, then `CODEX_CONTROL_SOCKET`, then the managed socket under
`~/.codex/app-server-control/app-server-control.sock`. The result is `{path, source}`, where
source is `option`, `environment` or `managed`. Selection performs no probe; an invalid
explicit path never falls back. Doctor uses environment or managed selection and performs only
control connect/initialization and exact `thread/read` with `includeTurns: false` for selected
active bindings. A readable native thread does not prove a healthy TUI, HTTP MCP bridge,
channel, native HOLD clearance or activation. Bridge diagnosis and recovery require the native
owner; doctor never probes authenticated HTTP ports or opens private configuration.

Claude diagnosis uses only `claude agents --json` and an exact session ID match. Session
reported state does not provide native history, queue or authoritative question state. Channel
connection remains unknown: a configured spool or receipt alone does not prove a connected
channel, acceptance or handling. Reports contain normalized codes and nonsecret references,
never message bodies, raw errors, environments or authentication material.

`messageChannelStateDir(layout, conversationId)` returns
`<reviewDir>/messages/recipients/<conversationId>/unblock` on the legacy path, or
`<stateRoot>/transport/messages/recipients/<conversationId>/unblock` with an active work protocol,
without creating state. An already
active Claude session's existing channel process includes its exact conversation's generic bus
alongside game bus directories by default. Explicit `--state-dir` is exclusive: configure
`claude channel --conversation UUID --state-dir DIR` with existing absolute directories only.
Doctor reports the generic reference even if absent; neither the reference nor directory
presence proves a connected channel. No inactive frontend or additional channel is started.
