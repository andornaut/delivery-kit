# Common messages

Sending, reading, dispatching and reconciling common messages with the `message` commands, and the delivery guards they apply.

The installed CLI accepts `--root COORDINATOR_ROOT` once, in any argument position. Use it
from another working directory; body-file paths remain relative to the caller's working
directory. Without `--root`, resolution uses `DELIVERY_KIT_ROOT`, then the working directory.

`message send --from ROLE --recipient ROLE_OR_UUID --id UUID --body-file PATH` stores the
entire valid UTF-8 file locally, including whitespace and trailing newlines. Invalid UTF-8
is rejected without storing altered text. It defaults to `--intent queue`;
`--intent unblock` also stores locally. Sending never dispatches. Reusing an ID with changed
payload or target fails; create a new ID for a different message. Output omits the body.

`--parent ROLE` binds a worker UUID recipient to its registered parent role. Dispatch uses
only the parent hop, preserving the exact original payload and child target. Parent acceptance
is not child delivery or handling.

Pull full stored payloads explicitly:

```bash
delivery-kit --root /path/to/game-coordinator message status --id UUID --include-body
delivery-kit message status --recipient game-kit --include-body --root /path/to/game-coordinator
```

Status requires exactly one of `--id UUID` or `--recipient ROLE`; `--include-body` opts into
full original text. Reading does not acknowledge, dispatch or modify the message.

For local blocker diagnosis, `message status --id UUID --include-retention` returns a cloned
retention view, including its owner, reason and next review boundary, or null. This opt-in does
not include the body or evidence. Default status and scheduled health remain metadata-only;
retention detail grants no retry, ACK or question clearance.

`message dispatch --id UUID` explicitly requests guarded delivery. It checks registered
ownership, routing and supported recipient decision guards. It does not inspect frontend
drafts or independently attest native HOLD state. Callers preserve known drafts and holds,
leaving messages local when their clearance is unknown. Local `state: "queued"` is durable
pending work, not native acceptance. Native acceptance is not handling. A queued Claude spool
also does not prove channel acceptance. Inspect the returned state: exit 0 reports a completed
operation, including a guarded or still-pending result, not proof of delivery.

The Claude channel consumer checks each queued message entry under `unblock.lock` with one
message-store index per drain, then rereads the exact record, binding, decision clearance and
recipient readiness before claiming it. An entry whose parent message is `handled` or
`superseded` stays blocked and unclaimed without another store scan, because a terminal message
takes no further attempt.

`message retire-spool --recipient ROLE_OR_UUID [--dry-run]` retires unclaimed Claude spool
entries of terminal messages for one conversation: a role selects its registered Claude
conversation, and a canonical UUID selects that conversation directly, including an earlier one.
It holds the generation lease and then `unblock.lock`, as the consumer does. An entry is retired
only when its receipt matches the entry at `sending` and exactly one message record holds its
request ID, is `handled` or `superseded`, and binds the same Claude recipient and transport text.
Every other entry is retained with a reason such as `parent-not-terminal`, `parent-missing`,
`receipt-mismatch` or `receipt-not-sending`. Retired entries move by rename, with identical
bytes, to `unblock/claude-retired/` beside `claude-delivered/`; receipts stay at their bound path
and nothing is deleted. Output is one JSON object with `retired` and `retained` counts, `reasons`
counts and per-entry outcomes. `--dry-run` reports the same outcomes and moves nothing. If
`unblock.lock` stays held for 60 seconds the command fails with `spool-busy` and moves nothing.

Status and outbox entries may include `diagnostic`: allowlisted `stage`, `category` and
`classification`, with optional known native `method` and `rpcCode`. Service attempt counts
do not count accepted native sends. A local or question-guard refusal is distinct from a
native-send rejection or an unknown send outcome. Raw native messages, context and unknown
codes are not exposed. Older receipts without diagnostics remain readable; absence supplies
no historical cause or clearance. `DeliveryDiagnostic` and `NativeRpcCode` are type-only
exports from `@andornaut/delivery-kit/build/transport` and its compatibility alias.
A `pending-question` diagnostic means clearance was not proved, not that a user question is
necessarily unanswered. An adapter receipt of `deduplicated` means the recipient already holds
that exact request: the transport reports it as `accepted` with a `deduplicated` diagnostic and
sends nothing new. An `unchanged` receipt sent nothing and stays `blocked` with an `unchanged`
diagnostic. Both use classification `guarded` and stage `receipt`.

A Claude spool held by another sender or the channel consumer refuses the attempt before
writing a receipt or spool entry. The message is `blocked` with reason `transport-busy` and a
`busy` diagnostic (classification `unavailable`, stage `receipt`); a later `message dispatch`
starts a new guarded attempt, as for `transport-unavailable`.

The CLI creates receipt storage before delivery. A failure proven to occur before native
admission sends nothing and permits a guarded retry of the same unchanged original. A failure
after a possible native mutation, or an unknown or corrupt prior receipt, remains ambiguous:
reconcile its bound receipt before any retry.

Native queue/add can wake a loaded idle thread through `enqueue_with_metadata` and
`wake_if_loaded`, without resume. Client message IDs do not deduplicate native adds. A lost
response, interrupted attempt or other ambiguous outcome must not produce another add. Neither
queue absence nor blocked guards prove non-delivery. TUI unsent drafts remain untouched.

Completed, error-free turns whose full native contents contain exactly one compaction item
may be skipped within a bounded question-proof lookup. The first complete semantic turn must prove
clearance through the existing exact question/answer checks, and the latest head must remain
unchanged. Pending questions and mixed, active, partial or unavailable history remain guarded.
Delivery still targets the current turn, never the older proof turn.

An existing recipient-bound clear record remains mandatory. For a single rendered asynchronous
question, the guard can derive an answer from the exact supported native reply envelope in
the same complete native turn. The tool, question ID, index, title and cardinality must match,
with one later reply and canonical JSON encoding. JSON object member order is immaterial.
Known optional native timestamps accept null or signed safe integers; malformed metadata and
unknown reply-item fields remain guarded. Timestamps do not establish question chronology.
The current head must be completed and unchanged, all read items are re-read unchanged, and
the owner's clear record must remain unchanged. Other, newer, malformed, deferred or unknown
questions remain guarded. This reads trusted native-history text, not authenticated UI-origin
metadata; an identical manually authored native user message is indistinguishable. No decision
record, native question or UI state is changed, and unsupported envelopes grant no clearance.

Reconciliation has two exclusive forms:

- `message reconcile --id UUID --receipt` reads existing bound receipt evidence. It does not
  resend an uncertain attempt or attest handling.
- `message reconcile --id UUID --expected-revision N --disposition DISPOSITION --evidence REF`
  records exact evidence at the observed revision. Disposition is `accepted`, `handled`,
  `superseded` or `retained`. Acceptance requires a verified bound receipt, never a user's
  assertion. Retained requires `--reason TEXT --next-boundary TEXT`; optional `--owner-role ROLE`
  defaults to the recipient. Retention options are exclusive to `retained`.

With an active work protocol, `handled`, `superseded` and `retained` additionally require an
already-published matching recipient-owned receipt. Its evidence anchor is exactly
`protocol-receipt:<receipt.reference.hash>`; retention metadata must match that receipt.
Caller-supplied evidence alone retains its legacy meaning only without protocol configuration.
Native acceptance remains a transport observation, not handling.

There is no `not-delivered` reconciliation authority. Stale revisions fail closed. Review
and retain ambiguous work until exact supported evidence establishes its outcome.

The existing scheduled review includes message health and outbox references; it adds no timer.
Every unresolved message observed in two distinct scheduled slots is reported with its ID,
blocker, owner and next action, including retained, held and guarded work. Valid questions,
holds and retention boundaries remain protected; a warning grants no retry, wake or ACK authority.
Before rollout to all registered roles, gate the combined feature, then verify actual installed
help and package behaviour for that exact artifact. These commands do not activate roles.
