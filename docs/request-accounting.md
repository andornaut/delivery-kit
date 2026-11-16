# Request accounting

Request accounting tracks requested outcomes separately from message delivery. A request can
have several transport references, clauses and targets. A delivered or handled message does not
prove that the requested work is complete.

The [filesystem work protocol](work-protocol.md) adds role-owned publications and recipient-owned
handling receipts under an explicitly configured external root. The request ledger remains the
request-state authority. A reviewed migration changes storage location and writer generation;
it does not create a second writable request ledger or turn old transport handling into a new
recipient attestation. Unmanaged callers without protocol configuration retain the existing
compatibility paths. A required managed workspace cannot create a separate legacy accounting
island while its external-root activation or enrollment remains pending.

Managed coverage includes all current, upcoming and future work for registered owners and
verified workers. Missing owner/native history or partial worker census remains an explicit
parent-owned UNKNOWN with evidence, reason and next review boundary. Representation is not
active adoption or complete capture; an empty manifest is not a completeness attestation.
See [managed workspace coverage](work-protocol.md#managed-workspace-coverage).

## CLI and reusable API

Run the installed CLI with an explicit coordinator root, including from another working
directory. JSON input files carry the full transaction rather than actor or provenance flags.

```sh
delivery-kit --root /path/to/game-coordinator ledger intake --input-file intake.json
delivery-kit --root /path/to/game-coordinator ledger apply --input-file update.json
delivery-kit --root /path/to/game-coordinator ledger show --id REQUEST_ID
delivery-kit --root /path/to/game-coordinator ledger history --id REQUEST_ID
delivery-kit --root /path/to/game-coordinator ledger report --at 2026-11-16T00:00:00Z
delivery-kit --root /path/to/game-coordinator ledger coverage --owner game-kit
```

`intake` accepts a `register` transaction. `apply` and `reconcile` accept the same transaction
port; reconciliation records supplied evidence rather than inferring an outcome from transport.
Mutations return an event; `show` returns the request, `history` its events, `report` a projection
and coverage assessment, and `coverage` the declared coverage entries. `report` requires `--at`;
`report` and `coverage` accept optional `--owner ROLE`. Errors contain a normalized code instead
of the input payload or a raw underlying error.

Each transaction carries `schema: 1`, a stable `commandId`, the observed global
`expectedRevision`, `actor`, `at`, asserted `source` and a typed `command`. A new ledger starts
at revision zero. Reuse the exact transaction to reconcile an uncertain result: identical
command replay returns its event, while conflicting reuse or a stale new command is refused.
The revision belongs to the whole ledger, including updates to other requests.

When the work protocol is active, every ledger mutation additionally requires
`writer: { harness, nativeId, epoch }` from the actor's current protocol claim. The writer is
audited in the committed event; it is optional only on the unconfigured compatibility path.
Unknown or unsupported native bindings remain unknown, not permission to invent a writer.

The reusable `LedgerStore` and transaction types are exposed through
`@andornaut/delivery-kit/build/accounting`. Its constructor accepts a `directory` and an optional
`resolveOwner` callback. In unmanaged compatibility mode, the CLI uses
`<coordinator-root>/var/accounting`; an active work protocol uses `<stateRoot>/accounting`,
with intake offers in its `intake` child directory. Assignment requires
fresh exact role, harness and native binding. The CLI verifies Codex workers through the existing
read-only worker inbox port, matching both native parent references and rechecking the registered
parent route. A worker verification reference supplied in JSON is insufficient. Unsupported or
unavailable lineage is refused. A reusable caller must supply a resolver that actually
corroborates the binding; verification performs no queue or native lifecycle operation.

Production callers construct `LedgerStore` with `ledgerStorageOptions(layout, io?)`, which
captures the directory and generation guard together. Do not resolve a directory and its fence
separately. A post-action writer error with `actionMayHaveCommitted: true` requires reading the
journal for the exact command before retrying; failure does not prove the mutation was absent.

The CLI checks that the actor names a registered role. This is attribution, not authentication of
the person invoking the command or independent verification of an approval reference.

`show` and each `report.requests` entry add an `ownerBinding` view without changing the recorded
assignment or native ID. `registryRevision` identifies the current registry read; `currentRole`
is the permanent role, or the registered parent for a worker. `current` means registry agreement,
not native availability. A worker with a matching parent still reports `unavailable` with reason
`worker-lineage-unverified` and `workerLineage: "not-checked"`; this read-only projection performs
no native verification. The reusable `projectOwnerBinding` helper exposes the same distinction.
`report --at` selects the stalled-work cutoff, not a historical registry view.

Accounting readiness diagnoses unassigned open work and stale or unavailable bindings on open work
or protected questions. Binding drift on other terminal records is informational. Neither view
rewrites assignment history or performs an ownership transfer.

After an externally approved ownership handoff, a `handoff` transaction reconciles ledger
metadata. It carries `id`, the exact `previousAssignment`, the new `assignment`, `sourceHoldRef`,
`targetAcceptanceRef` and `activationRef`. The recorded owner's actor and owner-attested source
are required, with revision CAS and an exact previous-assignment match. This operation freshly
verifies the new binding without requiring the stale old binding to resolve; ordinary `assign`
remains strict. It preserves work state, evidence and protected questions. These references attest
an external handoff: the transaction performs no native hold, acceptance, activation or transfer.

`ledger boundary --role ROLE --phase startup|resume|review|handoff` captures the explicitly
selected role's supported references and local-message metadata. Codex history reads are bounded;
Claude history remains unavailable. The command returns its accounting summary. Outside managed
mode, its exit status follows `accounting_ready`. With required management, it instead follows
`enrollment.ready` for the selected role; `enrollment.required` identifies that contract.

Managed enrollment readiness requires an active declaration and the selected owner's own current
active adopted receipt. An own receipt may explicitly retain UNKNOWN scopes without blocking
startup or adoption. Another owner's missing receipt or a global `coverageComplete: false` is
not a prerequisite for that owner's action. `accounting_ready` remains the strict coverage and
protection diagnostic, including pending intake and missing owner coverage. Pending or stale
enrollment fails closed while supported repair paths remain available. None of these views is
a game departure gate or native dispatch authority.

## Provenance and authority

Keep the exact original reference and distinguish observed native identifiers from owner
attestations. Leave unavailable thread, turn and item identifiers unknown. Similar wording does
not establish that two inputs are the same request, and a native user-message item does not
authenticate a human approval.

Questions, suggestions and proposed work retain their meaning until an explicit authorized
decision changes it. Recording an actor, source reference or registry owner does not itself grant
approval, prove native question clearance or transfer responsibility. A verified worker's binding
must identify its registered parent; worker readiness does not close its parent's request.

Use references to approved evidence instead of ingesting private transcripts, authentication
material or unrelated state. Never store or hash secret values as accounting evidence.

## Completion and protection

Assess every required clause and target against its own criteria. Source implementation,
integration, focused checks, publication, consumer adoption, deployment and acceptance are
different evidence where the request requires them. Some requests need only an answer or a
review. Do not require a code commit for those outcomes.

Keep partial work and unresolved dependencies visible with an owner and next boundary. Scope
cancellation, supersession and reopening to the exact affected work while preserving unrelated
targets and history. None of these accounting operations answers a pending question, releases an
independent HOLD or authorizes native delivery.

Progress can record `open`, `started`, `blocked`, `waiting`, `ready`, `checked`, `integrated` or
`delivered`; explicit evidence closure produces `completed`. `cancelled` and `superseded` retain
their distinct terminal meanings. Started, blocked and waiting work requires an owner and next
boundary. Checked, integrated and delivered progress requires passed check, integration and
delivery evidence respectively. Progress labels alone do not supply missing closure evidence.

Use separately scoped child requests for independently cancellable clauses. Cancellation names
the exact request and descendant scope, reason and authority reference. Reopen a completed
ancestor before reopening its required child. An `amend` command changes the summary, targets
and dependencies with an explicit reason; source identity and event history remain preserved.
Use explicit source links for originals, relays and attestations rather than rewriting unknown
original provenance or merging records by text similarity.

Pending or unknown questions remain listed in `protectedQuestions`, including on cancelled or
superseded work. A work cancellation is not evidence that the native question was answered.

## Capture and adoption limits

An inventory of known requests is not proof that every historical human request was captured.
Codex item references can be bounded by pagination, compaction, unsupported schemas and call
budgets. Native message type alone does not distinguish actual human input from peer or harness
input. Claude session metadata and channel receipts do not supply native conversation history
or pending-question truth. Unavailable coverage remains unavailable.

Backfill requires explicit owner review and trustworthy source references. Retain gaps and
owner-attestation limits rather than reconstructing unknown native identifiers. An empty queue,
idle session, completed goal or successful delivery cannot establish complete human coverage.

`coverageState: "declared-complete"` refers only to the explicitly declared windows. It does not
claim full historical coverage or coverage of every registered owner. Accounting readiness also
checks the current registered roles, or an explicitly selected role scope, and reports absent
coverage as `missingOwners` with `accounting_ready: false`. A role-scoped boundary does not attest
unselected roles. Full native human history remains unattested even when a returned page is
complete.

Existing snapshot and message-ingress hooks register unreviewed candidates and explicit coverage
gaps. Native snapshots are persisted before accounting admission. Automatic intake admits one
owner's unknown references and coverage together as one atomic `capture` event under revision
CAS; a conflicting source rejects the whole owner batch. Matching existing records retain their
owner's classification and history. This is per-owner atomicity, not one transaction across all
registered roles.

Before reading the event journal, automatic boundary intake durably retains primitive offers in
the selected accounting directory's `intake` child (`<coordinator-root>/var/accounting/intake`
without protocol configuration). Construct `IntakeStore` with that `directory`; its
`offer({ actor, source, command })` method accepts an unknown-reference `capture` payload and
returns an immutable content-addressed offer. Its
fixed summaries and unknown-question metadata contain no native message body, question text or
choices. Offer presence proves input retention, not journal admission, approval or completion.
Events remain the sole current projection; there is no separate mutable processed marker.

In unmanaged compatibility mode, existing boundaries replay pending offers for selected owners,
including references no longer present in a later compacted snapshot. With an active protocol,
boundaries retain safe offers but do not assume a role's writer authority: pending offers report
`pendingIntake.reason: "protocol-writer-required"`. The responsible role explicitly admits an
offer with `ledger reconcile --input-file FILE`, using its exact intake `commandId`, actor,
source and command payload, the current ledger revision, and `writer` from its protocol claim.
This reconciles accounting only, not native input or recipient handling.
While required management is pending, safe offers remain retained with
`protocol-enrollment-pending` diagnostics; they are not admitted to a legacy journal. Repair
declaration/enrollment and activate the prepared root before fenced journal admission.

The store's `pending(events, ownerRoles?)` derives
pending work from exact journal command-ID, actor, source and payload matches. Conflicting matches
remain pending. Replayed observations preserve matching covered owner attestations instead of
overwriting them. Replay changes local accounting only, never native queues or
questions.

`show` and `report` include `pendingIntake` metadata: `status`, `reason` and offers containing only
`id`, `commandId` and `requiredOwner`. An unavailable backend reports `offers: null`, not an empty
inbox. Pending or unavailable intake prevents accounting readiness; it grants no dispatch, ACK or
blind retry authority.

Automatic writes use nonblocking admission: contention reports `ledger-busy` rather than waiting
for the ledger lock. Saved native snapshots and immutable intake offers remain available when
accounting admission fails. A verified worker snapshot carries its exact worker and parent
binding; it does not turn
native input into authenticated human approval. Accounting failure after durable local message
enqueue retains that original ID and grants no native send or blind retry authority. Inspect the
same original before reconciliation. Existing reviews include accounting summaries; no new timer
or schedule is created.

The existing approval ledger, message receipts and request accounting have distinct meanings.
Cross-reference their evidence without treating message acknowledgement as request acceptance
or changing approval-ledger writer authority. Consumer configuration and operational adoption
require their own reviewed changes; accounting does not change delivery controls, provider
ownership or schedules.
