# Request accounting

Request accounting tracks requested outcomes separately from message delivery. A request can
have several transport references, clauses and targets. A delivered or handled message does not
prove that the requested work is complete.

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

The reusable `LedgerStore` and transaction types are exposed through
`@andornaut/delivery-kit/build/accounting`. Its constructor accepts a `directory` and an optional
`resolveOwner` callback. The CLI uses `<coordinator-root>/var/accounting`. Assignment requires
fresh exact role, harness and native binding. The CLI verifies Codex workers through the existing
read-only worker inbox port, matching both native parent references and rechecking the registered
parent route. A worker verification reference supplied in JSON is insufficient. Unsupported or
unavailable lineage is refused. A reusable caller must supply a resolver that actually
corroborates the binding; verification performs no queue or native lifecycle operation.

The CLI checks that the actor names a registered role. This is attribution, not authentication of
the person invoking the command or independent verification of an approval reference.

`show` and each `report.requests` entry add an `ownerBinding` view without changing the recorded
assignment or native ID. `registryRevision` identifies the current registry read; `currentRole`
is the permanent role, or the registered parent for a worker. `current` means registry agreement,
not native availability. A worker with a matching parent still reports `unavailable` with reason
`worker-lineage-unverified` and `workerLineage: "not-checked"`; this read-only projection performs
no native verification. The reusable `projectOwnerBinding` helper exposes the same distinction.
`report --at` selects the stalled-work cutoff, not a historical registry view.

Accounting readiness guards unassigned open work and stale or unavailable bindings on open work
or protected questions. Binding drift on other terminal records is informational. Neither view
rewrites assignment history or performs an ownership transfer.

`ledger boundary --role ROLE --phase startup|resume|review|handoff` captures the explicitly
selected role's supported references and local-message metadata. Codex history reads are bounded;
Claude history remains unavailable. The command returns its accounting summary and exits with a
nonzero status when accounting is not ready. It is not a native dispatch or a delivery gate.

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

Automatic writes use nonblocking admission: contention reports `ledger-busy` rather than waiting
for the ledger lock. The saved native snapshot remains available when accounting admission
fails. A verified worker snapshot carries its exact worker and parent binding; it does not turn
native input into authenticated human approval. Accounting failure after durable local message
enqueue retains that original ID and grants no native send or blind retry authority. Inspect the
same original before reconciliation. Existing reviews include accounting summaries; no new timer
or schedule is created.

The existing approval ledger, message receipts and request accounting have distinct meanings.
Cross-reference their evidence without treating message acknowledgement as request acceptance
or changing approval-ledger writer authority. Consumer configuration and operational adoption
require their own reviewed changes; accounting does not change delivery controls, provider
ownership or schedules.
