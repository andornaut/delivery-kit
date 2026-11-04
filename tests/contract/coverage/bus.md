## Bus, entry, requests, status, events and packaging

| Original | New case | Tag |
| --- | --- | --- |
| verify-scripts.py: real awk load guard below/equal/above thresholds | departure: a high-load departure retains its queue and persists attempt and blocked events | contract (partial: the `<` boundary at an exact load equal to the limit needs a controlled `/proc/loadavg`, not expressible at CLI level) |
| verify-scripts.py: `-v load=` absent from bus-common.sh | excluded: source-text check of a Bash internal | |
| verify-scripts.py: shell syntax | excluded: `bash -n` of internals stays in scripts/check.sh until Bash is retired | |
| verify-scripts.py: documentation-only and mixed-batch deployment scope | departure: a documentation-only batch skips deployment; a mixed batch deploys | contract |
| verify-scripts.py: gated build SHA, push once, deploy retry without tests/build/push | departure: a failed deployment retains the gated build and retries without another gate or push | contract |
| verify-scripts.py: explicit none mode leaves deployment state untouched | departure: deployment mode none leaves deployment state and commands untouched | contract |
| verify-scripts.py: failed gate blocks push/deploy | departure: a failed gate never pushes, stages deployment or deletes the batch branch; a failed install never pushes, stages deployment or deletes the batch branch | contract |
| verify-scripts.py: failed batch retains its commit branch and never deploys | departure: a failed gate never pushes, stages deployment or deletes the batch branch | contract |
| verify-scripts.py: repair rejects wrong base/tip/tree/extra branch and preserves failed approval | departure: repair approval rejects (8 cases: branch tip, extra queued branch, remote base, failed gate, failed push, base moved during gate, approval changed during gate, scratch tree) | contract |
| verify-scripts.py: one-shot repair requires full gate, consumes only after push, rejects replay | departure: a one-shot repair requires the full gate, is consumed only after push and rejects replay | contract |
| verify-scripts.py: scheduled-only entry point and singleton runner/loop locks | departure: run accepts no departure arguments and enforces singleton runner and loop locks | contract |
| verify-scripts.py: high-load departure retains queue and persists attempt/blocked events | departure: a high-load departure retains its queue and persists attempt and blocked events | contract |
| verify-scripts.py: empty scheduled ticks add no events | departure: empty scheduled departures add no events; events: empty departures are silent | contract |
| verify-scripts.py: scheduled red departure rejects extra queue and consumes exact repair after gate | departure: repair approval rejects an extra queued branch (queue retained, no container); a one-shot repair requires the full gate (queue drained, consumed) | contract |
| verify-scripts.py: background CI success/failure metadata states | departure: the exact-commit CI watch records success, failure, an unrelated failed workflow, a timeout | contract |
| verify-scripts.py: background CI releases inherited runner/merge locks | departure: a detached CI watch does not hold the runner, loop or merge locks | contract |
| verify-scripts.py: resource sampler performs reporting only | departure: the resource report is reporting only | contract |
| (plan: merge.sh last-push and post-push last-deploy writes without fsync) | departure: push and deployment stamps are replaced by rename, never rewritten in place | hardened (Node: new inode, no `.tmp` left; Bash: in-place truncation keeps the inode) |
| verify-events.py: empty silence | events: empty departures are silent | contract |
| verify-events.py: durable failed delivery, retry/dedupe | events: failed delivery stays durable, retries in order and delivers each event once | contract |
| verify-events.py: CI/deployment completion truth | events: completion is reported once, only after CI success and deployment success | contract |
| verify-events.py: blocked-full-gate and blocked-batch share one attempt identity | events: blocked events for one attempt deduplicate across stages | contract |
| verify-events.py: subprocess path closes inherited flock descriptors | events: a blocked delivery holds no runner or loop lock | contract |
| verify-events.py --delivery-only: long Unicode delivery fits 900 UTF-8 bytes | events: long Unicode delivery fits 900 UTF-8 bytes including the event ID; local metadata is retained | contract (the SHA-in-body assertion becomes the project prefix: a CLI-produced attempt message carries branches, not a SHA) |
| verify-events.py --quiet-only: quiet kinds and stale noise suppressed | events: quiet pending and retry kinds are never delivered and stale queued noise is suppressed | contract |
| verify-once.py (all checks) | packaging: [retired] scheduled-once group (5 named, skipped cases) | retired (decision 6) |
| test_requests.py: test_concurrent_idempotent_capture_and_single_claim | requests: concurrent capture is idempotent and the runner claims a request once; a started request found at runner start becomes interrupted and is never claimed again | contract |
| test_requests.py: test_queue_then_receipt_lock_order_does_not_deadlock_capture | requests: capture takes the queue lock before the request lock | contract |
| test_requests.py: test_stale_queue_and_tip_reject_without_consumption | requests: a changed queue / tip after capture rejects the request without consuming the queue | contract |
| test_requests.py: test_change_between_queue_reads_rejected | requests: a queue change between the departure's two queue reads rejects the request | contract (the change is injected by a pending deployment retry between the reads instead of a patched `load_ok`) |
| test_requests.py: test_failed_request_once_and_later_schedule_has_no_leaked_context | requests: a failed request finishes once and a later scheduled departure carries no request context | contract |
| test_requests.py: test_resident_keeps_hourly_deadline_and_skips_crossed_slot | requests: a 0s / 40s / 120s request keeps the hourly deadline and skips a crossed slot | contract (durations scaled for the virtual clock; the slot is observed in runner output) |
| test_requests.py: test_batch_integrates_captured_tip_and_retains_advanced_branch | requests: a request integrates its captured tip and retains a branch advanced during the gate | contract (the branch advances after validation, the only point a CLI request can integrate a stale tip) |
| test_requests.py: test_public_cli_captures_only_and_refuses_invalid_or_empty_requests | requests: the public request command captures only and refuses invalid or empty requests | contract |
| test_requests.py: test_missing_ref_is_reported_while_valid_work_still_integrates | requests: a missing ref is reported while valid queued work still integrates | contract |
| test_status.py: test_stale_record_with_free_lock_is_not_running | status: a stale record with a free lock is not running, idle and drained | contract |
| test_status.py: test_held_lock_with_matching_token_is_running_with_record | status: a held lock with the matching token is running with its record | contract |
| test_status.py: test_older_runner_lock_holder_is_running_but_unattested | status: an older runner holding the lock is running but unattested | contract |
| test_status.py: test_missing_lock_and_record_are_not_created | status: a missing lock and record are reported absent and not created | contract |
| test_status.py: test_active_departure_and_pending_work_are_not_idle | status: an active departure and pending work are not idle | contract |
| test_status.py: test_unsent_events_and_running_flush_are_not_drained | status: unsent events and a running flush are not drained | contract |
| test_status.py: test_runner_records_identity_after_lock_without_truncation | status: a refused duplicate start leaves the holder's identity token intact | contract (behavioural replacement for the source-order check) |
| test_status.py: test_public_status_command | status: every case uses the public command; status: queued branches are counted | contract |
| test_entry.py: test_help_requires_no_configuration_state_or_runtime_writes | entry: help requires no configuration, state or runtime writes | contract (`request-once` on Bash, `request` on Node, decision 2) |
| test_entry.py: test_config_validation_has_no_runtime_side_effects | entry: check-config has no runtime side effects | contract |
| test_entry.py: test_worker_parent_config_validates_canonical_unique_whitespace_list_offline | entry: worker parents must resolve to canonical, unique conversation IDs offline; WORKER_PARENT_THREADS accepts whitespace-separated lists | contract; bash-config |
| test_entry.py: test_snapshot_forwards_only_explicit_repeated_parent_flags_to_native_entrypoint | entry: monitor-snapshot forwards only explicit repeated --parent flags to the native entrypoint | bash-only (Python argv; `--parent UUID` in help is a contract) |
| test_entry.py: test_manual_and_unpinned_snapshot_commands_are_rejected | entry: manual departure and unpinned revision flags are rejected | contract |
| test_entry.py: test_exported_snapshot_enforces_its_exact_revision_and_refuses_overwrite | entry: exported snapshot enforces its exact revision and refuses overwrite | bash-only (1.0 pins through node_modules) |
| test_entry.py: test_deployment_mode_requires_explicit_supported_configuration | entry: deployment mode requires an explicit supported value | contract |
| test_entry.py: test_resource_caps_require_positive_bounded_integers_without_runtime_activity | entry: resource caps require integers from 1 through 4 without runtime activity | contract |
| test_entry.py: test_missing_adapter_configuration_defers_without_native_helper_call | see the unblock section | |
| test_entry.py: test_host_matching_library_targets_are_deduplicated | see the unblock section | |
| test_package.py: test_pinned_archive_is_reproducible_and_excludes_dirty_and_local_files | packaging: a pinned archive is reproducible and excludes dirty and local files | bash-only (P2 owns the npm pack replacement) |
