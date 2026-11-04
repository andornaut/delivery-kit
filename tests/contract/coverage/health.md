# Coverage: question, process and child health

Cases drive `monitor-snapshot` (public observation) or one scheduled monitor slot of `run`, with native responses from the fake control socket. Collector output is asserted in the persisted `STATE/unblock/snapshots/<id>.json` record and the snapshot stdout. Python mocks of `time.time()` become timestamps relative to the real clock; boundary ages keep a margin (1790 instead of 1800 seconds, future stamps 120 seconds ahead) for the delay before the collector runs. Patched `MAX_CALLS` and `max_pages` values are replaced by the production bounds (256 calls, ten pages).

## tests/test_question_state.py (cases/health-questions.test.ts)

| Original test | New case | Tag |
| --- | --- | --- |
| test_exact_fresh_owner_confirmation_and_current_native_proof_pending | exact fresh owner confirmation and current native proof is pending | contract |
| test_generic_pending_waitflag_and_absent_reply_never_prove_pending | generic pending, wait flag and absent reply never prove pending | contract |
| test_stale_future_non_utc_and_missing_attestations_are_unknown | stale, future, non-UTC and missing attestations are unknown | contract |
| test_wrong_recipient_mismatch_index_options_title_and_duplicate_attestation | wrong recipient, mismatched index, options, title and duplicate attestation stay unknown | contract |
| test_newer_turn_changed_turn_missing_waitflag_and_later_reply_unknown | newer turn, changed turn, missing wait flag and later reply stay unknown | contract |
| test_visible_newer_turn_and_partial_exact_answer_proof_remain_unknown | visible newer turn and partial exact answer proof remain unknown | contract |
| test_complete_paginated_history_can_prove_pending_without_body_capture | complete paginated history can prove pending without capturing bodies | contract |
| test_compaction_unknown_malformed_and_partial_pages_never_establish_pending_or_answered | compaction, unknown, malformed and partial pages never establish pending or answered | contract |
| test_answered_requires_exact_attestation_reply_type_and_native_order | answered requires exact attestation, reply type and native order | contract |
| test_cross_turn_resolution_pagination_proves_order_and_recipient_binding | cross-turn resolution pagination proves order and recipient binding | contract |
| test_verified_resolution_conflicts_with_pending_and_user_prose_never_answers | verified resolution conflicts with pending and user prose never answers | contract |
| test_only_titles_options_rendered_and_sensitive_tool_payloads_stay_opaque | only rendered titles and options are kept; sensitive tool payloads stay opaque | contract |
| test_cancellation_request_id_or_tool_acceptance_never_prove_lifecycle | cancellation, request ID or tool acceptance never prove lifecycle | contract |
| test_unknown_capability_timeout_deadline_and_budget_are_safe_and_read_only | unknown capability and timeout are safe and read only | contract (partial): the expired-deadline and `MAX_CALLS=1` parts are excluded: the deadline is the CLI connection's 25-second monotonic deadline and one recipient's history (two captures of at most ten pages plus four context reads) cannot reach 256 calls |
| test_old_compaction_or_partial_history_does_not_taint_complete_current_proof | old compaction or partial history does not taint complete current proof | contract |
| test_stable_context_requires_integer_updated_at | stable context requires an integer updatedAt | contract |
| test_content_limits_omit_exact_fields_without_truncating_options | content limits omit exact fields without truncating options | contract |
| test_rendered_question_count_is_bounded_with_explicit_omission | rendered question count is bounded with explicit omission | contract |
| test_input_bounds_and_malformed_resolution_records_fail_closed | noncanonical recipients are refused before any native call; malformed resolutions fail closed | contract (partial): duplicate recipients and `max_pages` bounds are excluded: the CLI takes one `--recipient` and has no page-bound input |

## tests/test_process_health.py (cases/health-process.test.ts)

| Original test | New case | Tag |
| --- | --- | --- |
| test_running_is_owner_attested_never_liveverified_and_only_scoped_metadata_read | running is owner attested, never live verified, and reads only scoped metadata | contract |
| test_explicit_fresh_owner_stall_requests_exact_job_episode_only | explicit fresh owner stall requests the exact job episode only | contract |
| test_protected_service_question_wait_and_terminal_never_request_closure | protected, service, question wait and terminal never request closure | contract |
| test_same_owner_timestamp_across_slots_is_not_new_progress_evidence | the same owner timestamp across slots is not new progress evidence | contract (scheduled slot; prior slot sample supplied as the health record) |
| test_two_distinct_owner_observations_need_expected_progress_and_corroborated_block | two distinct owner observations need expected progress and a corroborated block | contract (one scheduled slot, one job per variant) |
| test_prior_owner_evidence_fresh_at_capture_survives_thirty_minute_jitter | prior owner evidence fresh at capture survives thirty-minute jitter | contract (one scheduled slot, one job per variant) |
| test_public_observation_none_slot_does_not_synthesize_scheduled_samples | public observation (no slot) never synthesizes scheduled samples or two-sample stalls | contract |
| test_confirmation_references_do_not_depend_on_scheduled_sample_emission | confirmation references do not depend on scheduled sample emission | contract (late slot observed through a lagging scheduled run) |
| test_stasis_duration_native_status_and_exit_never_imply_stall_or_closed | stasis, native status and exit never imply a stall or closure | contract |
| test_wrong_scope_lineage_invocation_and_missing_identity_fail_closed | wrong scope, lineage, invocation and missing identity fail closed | contract |
| test_freshness_provenance_owner_and_identity_confirmation_are_mandatory | freshness, provenance, owner and identity confirmation are mandatory | contract |
| test_closure_outcomes_separate_delivery_report_and_ownerverified_result | closure outcomes separate delivery, report and owner-verified result | contract |
| test_closure_receipts_bind_exact_identity_and_preserve_blocker_retention | closure receipts bind exact identity and preserve blocker retention | contract |
| test_bounds_duplicate_job_and_unsafe_extras_never_echo_raw_fields | bounds, duplicate jobs and unsafe extras never echo raw fields | contract (the collector's 101-job `omitted_jobs` path is unreachable through the CLI, which refuses a manifest above 100 jobs as `process_manifest_schema_unavailable`; asserted instead, with 100 jobs fully inspected) |
| test_denied_visibility_deadline_and_shared_budget_never_bypass_or_mutate | denied visibility and the shared call budget never bypass or mutate | contract (partial): the expired-deadline part is excluded (connection deadline is not an input); the budget part runs 100 verified closures (300 reads) against the shared 256-call budget, whose `collection_call_budget_exhausted` trips before the collector's own equal cap because worker inventory calls share it |
| test_timeout_latches_budget_and_new_native_failure_never_leaks | a timeout latches the budget and never leaks native failure | contract |
| test_parent_owned_invocation_needs_no_child_scan_and_input_scope_validates_first | a parent-owned invocation needs no child read; out-of-scope parents make no calls | contract (duplicate and `None` parent scopes are refused by CLI argument validation) |

## tests/test_child_health.py (cases/health-children.test.ts)

| Original test | New case | Tag |
| --- | --- | --- |
| test_typed_failures_and_private_fields_discarded | typed failures are classified and private fields discarded | contract |
| test_no_status_or_untyped_error_inference | no status or untyped error inference | contract |
| test_waiting_retrying_and_long_busy_are_not_terminal | waiting, retrying and long busy children are not terminal | contract |
| test_newer_success_or_resumed_work_supersedes_failure | newer success or resumed work supersedes a failure | contract |
| test_invalid_lineage_never_reads_unrelated_child | invalid lineage never reads an unrelated child | contract |
| test_active_and_archived_pagination_and_deduplication | active and archived pagination deduplicates children | contract |
| test_partial_inventory_keeps_safe_verified_facts | a partial inventory keeps safe verified facts | contract (ten-page production bound instead of `max_pages=1`) |
| test_partial_latest_history_never_searches_older_failures | partial latest history never searches older failures | contract |
| test_unavailable_reads_and_schema_are_explicit_and_private | unavailable reads and schema are explicit and private | contract |
| test_repeated_cursor_and_oversized_pages_are_bounded | repeated cursors and oversized pages are bounded | contract |
| test_conflicting_duplicate_lineage_is_excluded | conflicting duplicate lineage is excluded | contract |
| test_empty_or_overfull_latest_turn_page_is_explicit | empty or overfull newest-turn pages are explicit | contract |
| test_shared_deadline_stops_calls_and_preserves_all_parent_results | (none) | excluded: requires an already expired monotonic deadline; the CLI connection deadline is fixed at 25 seconds and is not an input |
| test_timeout_halts_native_work_and_marks_omissions | a timeout halts native work and marks every parent | contract |
| test_all_parent_inventories_precede_child_reads_and_call_cap | every parent inventory precedes child reads, and the call cap is exact | contract (cap observed at the production 256 calls with 300 children) |
| test_expiring_deadline_during_call_never_alerts | (none) | excluded: requires the deadline to expire between two calls; not controllable through the CLI |
| test_recognized_rate_capacity_errors_require_terminal_failed_turn | recognized rate and capacity errors require a terminal failed turn | contract |
| test_unknown_recent_error_clears_earlier_typed_metadata | an unknown recent error clears earlier typed metadata | contract |
| test_125_children_ten_parents_complete_with_eight_exact_failures | 125 children across ten parents complete with eight exact failures | contract |
| test_inventory_pages_round_robin_before_any_parent_second_page | inventory pages round-robin before any parent's second page | contract (order asserted on the call log; the reduced-cap counts are excluded) |
| test_child_observations_round_robin_under_call_bound | child observations round-robin across parents | contract (order asserted on the call log; the reduced-cap counts are excluded) |
| test_discovered_counts_include_listed_beyond_child_inspection_bound | discovered counts include listed children beyond the inspection bound | contract |
| test_nonfailed_and_unknown_children_need_only_latest_turn_read | nonfailed and unknown children need only the newest-turn read | contract |
| test_invalid_inventory_metadata_cannot_validate_failure | invalid inventory metadata cannot validate a failure | contract |
| test_invalid_scope_and_bounds_make_no_calls | an invalid parent scope makes no native calls | contract (partial): `max_pages` bounds excluded, no CLI input |
| test_repeated_observations_keep_exact_dedup_identity_without_delivery | repeated observations keep the exact dedup identity without delivery | contract |
| test_notloaded_idle_and_system_error_without_failure_are_unknown | notLoaded, idle and systemError without a failure are not actionable | contract |
