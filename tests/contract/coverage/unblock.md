## Scheduled Codex monitor delivery, Codex events and legacy triage

Cases drive the resident runner (`run`) under the virtual clock: a monitor wake slot or a
departure is reached by jumping the clock, and native responses come from the fake control
socket. Files: `cases/unblock-delivery.test.ts`, `cases/unblock-guards.test.ts`,
`cases/unblock-briefs.test.ts`, `cases/codex-events.test.ts`, `cases/codex-triage.test.ts`.

| Original | New case | Tag |
| --- | --- | --- |
| test_unblock.py::test_confirmed_question_first_slot_then_one_distinct_slot_escalation | unblock briefs: a confirmed question is briefed at its first slot, escalated once at a distinct slot, then quiet | contract (a second reconcile of the same slot is a module call; at CLI level a repeated slot is deduplicated, covered below) |
| test_unblock.py::test_unknown_answered_and_unproven_questions_never_brief_or_clear_guard | unblock briefs: unknown, answered and unproven questions are never briefed, and a pending guard still defers | contract |
| test_unblock.py::test_new_question_state_dedup_does_not_resurrect_old_pending_body | unblock briefs: an answered question is not resurrected; a replacement question is briefed as initial | contract |
| test_unblock.py::test_own_confirmed_question_wait_never_fails_health_by_itself | unblock briefs: the monitor's own confirmed question wait never fails health by itself | contract |
| test_unblock.py::test_answered_identity_and_older_snapshots_cannot_resurrect_pending | unblock briefs: an answered question identity cannot become pending again | contract (replaying an older snapshot at a lower slot is excluded: runner slots only advance) |
| test_unblock.py::test_question_brief_bound_never_slices_original_options_or_dedups_omitted_rows | unblock briefs: the question brief is bounded without slicing original options | contract |
| test_unblock.py::test_confirmed_process_stall_requests_owner_closure_once_and_keeps_guard | unblock briefs: a confirmed process stall requests owner closure once and keeps the guard | contract |
| test_unblock.py::test_process_receipts_protected_and_unknown_never_duplicate_closure_request | unblock briefs: closure receipts, protected and unknown jobs never request closure | contract (`identity_provenance: native_verified` is excluded: the collector only emits `owner_attested`) |
| test_unblock.py::test_ambiguous_send_is_not_accepted_closure_or_owner_outcome | unblock briefs: an ambiguous send is neither an accepted closure request nor an owner outcome | contract |
| test_unblock.py::test_interrupted_process_send_is_guarded_across_future_slots | unblock briefs: an interrupted process send stays guarded across later slots | contract (interruption is a runner stopped mid-send) |
| test_unblock.py::test_explicit_native_rejection_does_not_permanently_guard_process_request | unblock briefs: an explicit native rejection does not permanently guard the closure request | contract |
| test_unblock.py::test_invalid_parent_scope_defers_without_native | unblock guards: worker parents outside the active route defer before any native connection; duplicate or noncanonical worker parents stop the runner before any native connection; unblock delivery: an empty MONITOR_ROUTE_FILE with worker parents defers without a native connection | contract, contract, bash-config |
| test_unblock.py::test_new_worker_failure_bypasses_unchanged_queue_and_preserves_guard | unblock briefs: a new worker failure bypasses an unchanged queue and preserves the guard | contract |
| test_unblock.py::test_worker_scope_run_duplicate_slot_collects_without_redelivery | unblock delivery: the same slot after a runner restart collects worker health again without redelivery | contract |
| test_unblock.py::test_active_reminder_reads_all_peer_queue_pages_and_retains_only_ids | unblock delivery: an active reminder reads every peer queue page and persists only IDs | contract |
| test_unblock.py::test_completed_idle_starts_reminder_without_model_or_permission_overrides | unblock delivery: a completed idle monitor gets turn/start without model or permission overrides | contract |
| test_unblock.py::test_questions_approvals_and_ambiguous_or_interrupted_idle_are_preserved | unblock delivery: questions, approvals and ambiguous or interrupted states defer without mutation | contract |
| test_unblock.py::test_only_explicit_stale_turn_rejection_refreshes_once | unblock delivery: only an explicit stale-turn rejection refreshes once with the same request ID | contract |
| test_unblock.py::test_timeout_and_unexpected_acceptance_never_resend | unblock delivery: a lost response or unexpected acceptance is ambiguous and never resent | contract (timeout is a dropped connection and a hung reply) |
| test_unblock.py::test_other_rpc_rejections_are_not_stale_retries | unblock delivery: other native rejections are rejected without a stale retry | contract |
| test_unblock.py::test_sending_state_is_durable_before_mutation | unblock delivery: the receipt is durable at sending before the native mutation | contract |
| test_unblock.py::test_prior_accepted_or_interrupted_send_still_snapshots_without_resending | unblock delivery: a prior accepted or interrupted send is deduplicated without resending and still snapshots | contract |
| test_unblock.py::test_missing_malformed_mismatched_and_unknown_recipient_records_fail_closed | unblock guards: missing, malformed, mismatched and unknown decision records fail closed | contract |
| test_unblock.py::test_art_pending_does_not_block_tech_clear_or_modify_legacy_evidence | unblock guards: another recipient's pending record neither blocks the monitor nor changes any record | contract |
| test_unblock.py::test_non_uuid_recipient_is_never_clear | unblock guards: a non-UUID monitor identity is never a clear recipient | contract (proxy: a non-UUID monitor never reaches the guard; route validation rejects it) |
| test_unblock.py::test_explicit_pending_marker_overrides_empty_active_flags | unblock guards: an explicit pending marker overrides empty active flags | contract |
| test_unblock.py::test_marker_is_rechecked_after_metadata_before_native_mutation | unblock guards: the marker is rechecked after native metadata and before the mutation | contract |
| test_unblock.py::test_native_question_on_later_page_overrides_empty_flags_and_clear_marker | unblock guards: a native question on a later history page overrides empty flags and a clear marker | contract |
| test_unblock.py::test_unknown_truncated_or_question_tool_history_defers | unblock guards: unknown, truncated or question-tool history defers | contract |
| test_unblock.py::test_later_user_message_does_not_prove_question_resolution | unblock guards: a later user message does not prove question resolution | contract |
| test_unblock.py::test_unavailable_socket_defers_without_native_connection | unblock delivery: unavailable absolute socket paths defer without a native connection; a missing or relative socket path defers before the helper runs | contract |
| test_unblock.py::test_explicit_socket_is_forwarded_to_mock_transport_with_guards_intact | unblock delivery: the explicit control socket carries the delivery with guards intact | contract (closing the connection exactly once is not observable through the fake socket) |
| test_unblock.py::test_rpc_ignores_notifications_and_server_questions_without_answering_them | unblock delivery: notifications and server requests interleaved with a response are skipped, never answered | contract (skipping is proven by acceptance; the absence of a client reply frame is not recorded by the fake socket) |
| test_unblock.py::test_omitted_optional_questions_defaults_to_no_question | unblock guards: an omitted optional questions field means no question | contract |
| test_unblock.py::test_exact_answer_attestation_resolves_only_its_bound_question | unblock guards: an exact answer attestation resolves only its bound question | contract |
| test_unblock.py::test_latest_turn_compaction_defers_even_with_visible_exact_proof | unblock guards: latest-turn compaction defers even with visible exact proof | contract |
| test_unblock.py::test_older_turn_compaction_does_not_poison_clear_latest_turn | unblock guards: older-turn compaction does not poison a clear latest turn | contract |
| test_unblock.py::test_stdout_includes_history_status_without_private_state | unblock delivery: runner output reports only status fields, never queue contents | contract |
| test_unblock.py::test_unrelated_old_resolution_does_not_fetch_or_poison_current_clear_turn | unblock guards: an unrelated old resolution neither fetches its turns nor blocks the current clear turn | contract |
| test_unblock.py::test_same_turn_answer_must_follow_exact_question | unblock guards: a same-turn answer must follow its exact question | contract |
| test_event_native.py::test_active_delivery_persists_attempt_before_mutation_and_deduplicates | codex events: an active delivery persists its attempt before the mutation and deduplicates by receipt | contract |
| test_event_native.py::test_completed_idle_starts_and_interrupted_idle_does_not | codex events: a completed idle monitor gets turn/start; an interrupted idle one gets nothing | contract |
| test_event_native.py::test_pending_local_native_questions_and_guard_race_never_send | codex events: a pending local guard, native question or guard race never sends | contract |
| test_event_native.py::test_stale_rejection_refreshes_turn_once_with_same_request_identity | codex events: a stale-turn rejection refreshes once with the same request identity | contract |
| test_event_native.py::test_ambiguous_and_rejected_outcomes_never_retry_even_after_restart | codex events: ambiguous and rejected outcomes are never retried, even after a restart | contract |
| test_event_native.py::test_monitor_route_validation_does_not_require_reporter_to_be_dispatch_host | codex events: monitor routing needs no dispatch host; other recipients and no route keep the Codex queue | contract |
| test_event_native.py::test_invalid_unavailable_empty_and_held_routes_never_fall_back_to_queue | codex events: invalid, malformed and held routes never fall back to the Codex queue; an empty or missing MONITOR_ROUTE_FILE never falls back to the Codex queue | contract, bash-config |
| test_event_native.py::test_subprocess_config_exports_selected_interpreter_and_unset_semantics | codex events: configuration exports the selected interpreter, route and socket to event and monitor subprocesses | bash-config (the exported default `CODEX_PYTHON=/usr/bin/python3` is excluded: only an interpreter-spawned child could observe it, and that child is the interpreter itself) |
| test_event_native.py::test_nonmonitor_retains_codex_queue_contract | codex events: a non-monitor reporter keeps the Codex queue under active, held and absent routes | contract |
| test_codex_adapter.py::test_shared_role_configuration_and_host_guards | codex triage: shared roles respect host, harness, coordinator and ownership guards | bash-config (SESSION_MAP_FILE, SHARED_TARGETS_FILE and CODEX_SHARED_ROLES retire in 1.0) |
| test_codex_adapter.py::test_monitor_route_rejects_relative_project_root_even_while_held | codex triage: a monitor route rejects a relative project root even while held | bash-config (REPO is derived from config.json in 1.0) |
| test_entry.py::test_missing_adapter_configuration_defers_without_native_helper_call | codex triage: missing socket or shared-role configuration defers triage without the native helper | bash-config |
| test_entry.py::test_host_matching_library_targets_are_deduplicated | codex triage: host-matching library targets are deduplicated and held targets excluded | bash-config |

Counts: 53 original tests ported into 57 cases (50 contract, 7 bash-config, 0 bash-only,
0 hardened); no test is excluded outright. Partial exclusions are noted inline.
