# scheduled-delivery

Local scheduled Git delivery with one isolated gate per integrated tree, exact-commit CI monitoring and deployment of the already-gated artifacts. The tool owns mechanisms; each client owns its repository, configuration, queues, locks, state, credentials and schedule.

## Structure

- `bin/scheduled-delivery`: explicit configuration/state entry point.
- `examples/`: project configuration and a thin pinned-snapshot runner adapter.
- `libexec/`: the Bash scheduler, batch preparation, gate, deployment, event outbox and optional Codex triage adapter.
- `scripts/check.sh`: isolated offline verification with fake Git, Docker, deployment, GitHub and native-protocol responses.
- `scripts/export.sh`: exports one committed source revision to a new local snapshot directory.
- `tests/`: mechanism and adapter contract tests. Consumers test only their own configuration and integration.

The repository has no publication, installation daemon or registry dependency. It uses the existing Bash scheduling mechanism. It creates no additional timer.

## Explicit project contract

```bash
/path/to/snapshot/bin/scheduled-delivery \
  --config /absolute/path/to/project/bus.conf \
  --state-dir /absolute/path/to/project/bus-state \
  --revision EXACT_COMMIT_SHA run
```

Both paths must be absolute and the state directory must already exist. Configuration is trusted Bash, not untrusted input. `REPO`, branch/remote, GitHub slug, departure minutes, container image, resource limits, installation and ordered gate commands are explicit project values. `examples/project.conf` lists the required fields. `check-config` loads and validates configuration without Git/network/container/native activity. `resource-report` prints reporting-only resource information. `scheduled-once` preserves the existing due-slot window and duplicate-slot receipts; it is not a manual departure command.

The gate mounts the scratch project checkout writable and the project state directory's `npm-cache` writable. Dependencies are installed with the configured command; all gate steps then run without network. The configured CPU and worker caps cannot exceed four. The gate compares Git-status file fingerprints before and after checking and stamps the exact build commit. Configuration and cache remain project-owned. Never place secret values in configuration: use the operator's existing authentication and credential references.

The default supported deployment adapter invokes the project's existing Wrangler executable/configuration against retained gated `dist/`, with the exact source SHA as its label. A failed deployment keeps its pointer and artifacts for a later configured departure. The CI monitor requires the configured names for the exact pushed commit. Red CI blocks later pushes unless the existing narrowly scoped one-shot repair approval protocol is satisfied.

## State and optional coordinator adapters

`--state-dir` preserves the existing filenames: `bus-queue`, queue/merge/runner/loop locks, `active-departure`, scratch batches, gate logs, CI/deployment state, event outbox and retained retry artifacts. Moving mechanisms does not move or rewrite any of these files.

`REPORT_PROJECT` and `REPORT_THREAD` select the existing Codex event sink. `SESSION_MAP_FILE` explicitly selects project role metadata; `SHARED_TARGETS_FILE` optionally selects host-scoped shared-library targets. The resolver preserves coordinator matching, distinct role identities, active ownership, host path matching and deduplication. Missing or invalid metadata defers triage. The guarded Codex adapter is unchanged: local decision clearance and native question history must both permit input; interrupted, ambiguous or unknown states defer. Its existing local control socket and queue delivery routes are unchanged. No live native connection is made by verification.

The optional Codex triage adapter retains the three-role game metadata schema and its coordinator reminder wording. That schema is an adapter contract, not a repository identifier. Other applications may omit reporting/triage rather than supplying fake identities.

## Snapshot and cutover

Prepare a new immutable local snapshot from a reviewed commit:

```bash
bash scripts/export.sh EXACT_COMMIT_SHA /new/absolute/snapshot/directory
```

The export refuses an existing destination and writes `SOURCE_COMMIT`. The project runner adapter pins both the absolute snapshot location and expected revision. Do not point running adapters at a mutable development branch. Preserve the snapshot while its runner, detached CI monitor or retained deployment artifacts need it.

For each game, its tech owner must perform the runtime cutover:

1. Confirm an idle departure boundary and record the current runner/loop identities, locks, queue, active marker, configuration and pending artifact pointers.
2. Export the reviewed tool revision and preserve the original game scripts and launcher outside the active adapter path.
3. Add explicit `SESSION_MAP_FILE` and `SHARED_TARGETS_FILE` to that game's local configuration. Keep the existing repository, gate, auth, reporting, resource limits and schedule values exactly. Dog remains hourly `00`; Chibi remains hourly `10`, both `America/Toronto`.
4. Replace only the game's runner launcher with a pinned adapter based on `examples/project-runner.sh`. Keep its existing state directory and every queue/lock/artifact file in place. Do not start a second scheduler or run a missed slot manually.
5. Stop only the verified owned idle runner/loop and its lock-holding descendants, then start one adapter through the existing background launch mechanism. Verify one runner/loop, locks, unchanged queue/state and the next normal scheduled slot. Observe actual departure/failure and CI/deployment reports before declaring operational completion.

Rollback uses the same idle-boundary procedure: stop the verified owned new runner/loop, restore the preserved launcher/scripts/configuration and start one original runner. Do not restore old queue/state copies or replay a consumed slot. Pending gated artifacts and their exact SHA remain authoritative. Never delete a snapshot used by an active detached monitor.

This source extraction does not perform cutover. A project owner must explicitly approve its reviewed pin and coordinate its runtime transition.

## Verification

```bash
bash scripts/check.sh
```

Verification requires Docker and a locally available `node:24.21.0` image. It starts only below one-minute load 24, uses at most four CPUs, mounts source read-only, copies it to container scratch, disables network and exposes no host socket or credential stores. Tests use fake commands and protocol fixtures only. No project gate, push, deployment, live queue operation or coordinator input runs.
