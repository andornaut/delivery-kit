# Filesystem work protocol

The work protocol publishes durable work and message records under one explicitly configured
external state root. Filesystem discovery works when notifications or a channel are unavailable.
Discovery is read-only; it does not deliver native input, acknowledge queues or answer questions.

## Configuration and authority

`var/work-protocol.json` names `schema: 1`, `workspaceId`, `stateRoot` and `generation`. The root
must be outside known source checkouts and task worktrees, including resolved symlink ancestors.
There is no inferred default root. Missing configuration keeps the legacy compatibility path
only outside required managed mode and when no cutover fence exists. An active cutover fence
with a missing configuration pointer fails closed as `protocol-fenced`; invalid configuration
or generation disagreement also fails closed. A required declaration awaiting activation stays
managed-pending, not legacy; ordinary admission reports `protocol-enrollment-pending`.
Deleting the pointer does not roll back activation or enable a second writable backend.

Import the public SDK APIs and types from `@andornaut/delivery-kit/build/protocol`, including
`runtimeProtocolStore`, `ProtocolMessages` and `protocolNamespace`. See the
[public build API list](../README.md#public-build-apis) for canonical subpaths and compatibility aliases.

Stable namespaces are `coordinator`, `kits/<kit>` and `games/<game>/<role>`.
The core registry-key mapper, exported publicly as `protocolNamespace(registryRole)`, maps those
keys without asserting current ownership. The runtime `protocolRole(layout, role)` additionally
checks the registry and coordinator configuration. Verified workers have a
separate parent/worker/epoch namespace; they cannot publish into their parent's namespace.

`ProtocolStore` claims and transactions require a current binding, ownership epoch and revision
CAS. Role revisions include claims and transactions; object revisions start at one. A transaction
publishes all its mutations in one immutable manifest. Exact transaction replay is idempotent;
changed payloads or stale writers fail. There is no TTL takeover. These SDK fences coordinate
cooperating writers, not adversarial filesystem access under the same OS account.

Production coordinator callers use `runtimeProtocolStore(layout, io?)`, which returns null
only for unmanaged callers without protocol configuration and refuses pending required management.
Its `claim`, `transact`, `withWriter` and `putArtifact` mutations
share the configured generation lease; `read`, `history`, `listRoles` and `readArtifact` check
the captured generation before and after reading. The raw `ProtocolStore({ directory })` is a
directory primitive: it cannot discover a coordinator's configuration pointer or its changes.

`withWriter` checks the writer before and after its action. A post-action failure carrying
`actionMayHaveCommitted: true` is ambiguous: reconcile the exact journal command or publication
before retrying. It is not a rollback guarantee or permission to repeat an external effect.

Committed history is the publication authority. Sparse indexes are derived views. Canonical
artifacts contain immutable bytes, addressed by lowercase SHA-256 and byte size; readers verify
the bytes before use. A task or temporary path alone is insufficient essential evidence.
Path-based artifact promotion and extraction reject known credential components in both supplied
paths and alias targets. Public aliases and opaque bytes remain supported; content is not scanned.
Output validation creates no directories, and extraction uses exclusive `wx` writes without
overwriting an existing file. Raw byte API callers remain responsible for the bytes they supply.

The existing request ledger remains the request-state authority. Work publications link request,
clause, work, message and evidence identities rather than copying request states into another
ledger. Worker READY, parent acceptance, integration, delivery and acceptance remain distinct.

## Managed workspace coverage

A managed workspace covers all current, upcoming and future work across every registered owner
and verified worker. Management is a durable workspace declaration, not a per-role opt-out.
The existing request ledger, work publications, submissions, immutable message originals and
intake offers remain their respective authorities; enrollment references them rather than
copying their current states into a second ledger.

Expected coverage comes from the current registry, verified worker relationships, canonical
references and explicit source/census gaps. Enumerating published role journals is insufficient.
An empty receipt cannot attest inspection or completeness. New registered owners and newly
verified workers remain missing until represented; unrelated owners' journal revisions do not
require blanket receipt rewrites.

An unavailable participant or uninspected source requires a retained UNKNOWN with a stable
accounting ID, responsible parent, reason, evidence and next review boundary. Parent fallback
belongs in that parent's own receipt and must match the actual relationship. It represents a
rollout blocker without pretending the unavailable owner adopted the protocol. Unknown native
IDs stay unknown; source evidence is owner-attested, not authenticated native history.

Reports distinguish representation, active adoption and coverage completeness. Prepared
receipts must be revalidated under the active generation and current owner binding after
cutover. A represented UNKNOWN is not actual adoption, question clearance or permission to
delete sole WIP. Per-owner blockers remain visible until the responsible owner supplies actual
evidence or retains the exact gap with a next boundary.

Existing 4.5 pins retain their published optional filesystem contract; they do not enforce
managed all-work enrollment. Publishing a newer SDK does not declare a workspace managed,
upgrade resident readers or writers, create owner receipts or establish consumer adoption.
The operator owns declaration, audit/backfill and per-owner rollout.

`EnrollmentStore({ protocol })` uses `publish(context, input, scope)`, `read(role)` and
`report(scope)`. The context is a fenced role transaction without mutations. Input records the
workspace, generation, prepared/active phase, registry revision, inspection time, ledger replay
anchor, canonical reference keys, UNKNOWN records and artifact evidence. It does not copy
request or work state. The integration adapter supplies the complete expected `scope`; a raw
store caller must not substitute the set of existing journals for that roster.

`report(scope)` separates `allRepresented`, `allAdopted` and `coverageComplete`, with `missing`,
`stale`, `omitted`, `unknowns` and per-participant results. An own current active receipt can
establish adoption while preserving declared UNKNOWN scopes; those gaps still prevent a
coverage-complete claim. A designated parent's fallback can establish representation only.

Runtime enrollment admission is role-local: the selected owner needs its own current active
adopted row, not global `allAdopted` or `coverageComplete`. Explicit UNKNOWNs in that own receipt
do not prevent startup or adoption. Missing participants elsewhere remain rollout blockers,
not a new prerequisite for unrelated owners. The accounting boundary exposes this distinction
as `enrollment: { required, ready }`; strict `accounting_ready` remains a separate diagnostic.
Before-work and worker-start checks still require a specific canonical approved work reference and its guards,
not merely an adopted conversation. Pending or stale rows fail closed without disabling the
supported claim, intake-retention, enrollment, artifact-promotion or reconciliation repair paths.

### Declaration, enrollment and rollout

Use the installed CLI with an explicit coordinator root. The declaration input is
`{ workspaceId, authorityRef, expectedGeneration: 0 }`; declaring required management creates a
durable pending fence, not a state-root selection, owner activation or adoption receipt.
Activation carries `required: { authorityRef }` into the pointer, fence and workspace header;
use the supported declaration and migration APIs rather than editing those records directly.

```sh
delivery-kit --root /path/to/game-coordinator protocol declare --input-file declaration.json
delivery-kit --root /path/to/game-coordinator protocol enrollment-report --state-root /path/to/prepared-state
delivery-kit --root /path/to/game-coordinator protocol enroll \
  --input-file enrollment.json --state-root /path/to/prepared-state
```

`enrollment.json` contains `{ context, input }`, using `EnrollmentContext` and `EnrollmentInput`.
The command derives the expected roster and canonical references through the integration adapter;
the caller supplies an actual inspection receipt, not a fabricated complete scope. Before
activation, `--state-root` selects the explicitly prepared migration root. After activation,
commands use the configured root; an alternate active root is refused. Repeat inspection and
publish an active receipt under the current claim after cutover. Prepared receipts alone do not
establish adoption.

Use `protocol observer-adoption --input-file adoption.json` to record an actual resident reader
inspection. Its typed input carries `context`, `operation`, `expectedRegistryRevision` and an
evidence artifact, with `reconcileRegistryRevision` available for explicit reconciliation.
The evidence is owner-attested resident identity, installed CLI version/hash and inspection
reference. The producer durably stores a content-addressed audit, then commits the immutable
`intake` object `observer-adoption:<sha256(context.id)>` in the owner's journal before a separate
fenced registry CAS under the same generation lease. The command binds that ID to the audit
reference; reusing the ID with a different payload is refused. Registry
`operations.<game>.lastAdoption.evidenceRef` is `protocol-artifact:<audit hash>`.
Managed activation verifies the committed command, pointer, audit and referenced resident proof,
and matches the current owner binding. A package pin, declared capability or returned-only
result is not durable resident adoption evidence.

`protocol role --role CANONICAL_NAMESPACE --id OBSERVER_OBJECT_ID` retrieves that command object's
audit reference without returning resident evidence bodies. It also accepts `--state-root` for
the prepared root. The object ID uses the lowercase SHA-256 of the original `context.id`.

If the command is committed but the registry update or writer post-check fails, the error exposes
`actionMayHaveCommitted: true` and `reconcileKey` identifying that same audit hash. Inspect the
audit and current registry before retrying. Reconcile with the same command context, operation,
evidence and original `expectedRegistryRevision`; supply `reconcileRegistryRevision` only for
the explicitly observed current CAS revision. This preserves the audit identity and can return
`already-recorded`; do not generate a new inspection or acceptance merely to retry a partial update.

Migration still requires `protocol dry-run`, an independently located backup and verified
restore, compatible readers before writers, participant/quiescence evidence and affected writer
fencing. Managed activation checks the same prepared enrollment report and requires all
participants represented, preserving UNKNOWNs. It does not claim all participants adopted.
The operator owns root and backup selection and actual consumer rollout; SDK publication performs
none of those operations.

### Lifecycle boundaries and repair

`protocol boundary` accepts `--role ROLE --phase PHASE --at ISO_TIMESTAMP`. Phases are `intake`,
`startup`, `resume`, `before-work`, `worker-start`, `worker-publication`, `worker-finish`,
`parent-review`, `integration`, `handoff`, `finish`, `before-cleanup`, `cleanup` and `review`.
Use the registry role; `--worker UUID` selects a verified child under that parent's current epoch.
Worker selection shares enrollment's supported exact read-only parent/child lineage verification;
its census remains partial. This boundary reports `nativeHistory: "not-collected"`; it is not
a full native snapshot or queue operation.

For `before-work` and `worker-start`, supply `--work-id ID` and, when needed,
`--work-role CANONICAL_NAMESPACE`. Work must belong to the selected namespace, or to the verified
worker's parent; unrelated roles cannot supply its approval. The referenced work must be
canonical, reviewed and unguarded. Finish, handoff and cleanup boundaries require canonical
essential artifacts plus retained work or closure-ready evidence;
`before-cleanup` and `cleanup` additionally require a nonempty essential artifact distinct from
the plan. Worker completion additionally requires the parent's recorded acceptance. A sole
temporary copy, UNKNOWN or successful boundary cannot authorize destructive cleanup or clear a question.

Missing local adoption, approved work or essential evidence produces a finite nonzero diagnostic:
`enrollment-required`, `approved-work-required` or `essential-evidence-required`. Inactive or held
owners remain guarded by `role-guarded` outside intake/review. Repair through
the existing claim, safe intake retention, enrollment publication, artifact promotion and actual
reconciliation paths, then recheck the exact boundary. Do not weaken guards or require global
coverage completion to unblock an independently enrolled owner.

Filesystem inspection discovers canonical publications and retained inputs. It does not
collect full native human history or prove that a missing native page, question source or
worker census is empty. Existing snapshot and durable-message ingress hooks retain the safe
references they actually observe. A lifecycle boundary, source artifact or owner attestation
cannot expand those native capabilities or authenticate a human approval.

Required management never turns request acceptance, coverage or enrollment into a game
departure admission gate. Scheduled monitoring, delivery controls, cadence, bus state and
independent holds remain separate. No new timer, daemon, provider activation or native question
mutation follows from a lifecycle check.

## Message ownership

| Owner     | Record                | Meaning                                                                    |
| --------- | --------------------- | -------------------------------------------------------------------------- |
| Sender    | Immutable original    | The canonical envelope, exact body, links and observed guards              |
| Sender    | Transport observation | A reference to an exact transport record, including attempts and ambiguity |
| Recipient | Handling receipt      | An explicit `handled`, `superseded` or `retained` publication              |
| Sender    | Withdrawal statement  | A withdrawal request, never recipient handling or native cancellation      |

`OriginalRef` is `{ senderRole, messageId, revision, hash }`. `senderRole` is a core namespace;
`hash` covers the whole immutable original publication. `read(ref).envelope` is the canonical
`MessageEnvelope`, including its existing `payloadHash`. Bodies preserve leading BOM content,
literal U+FFFD and trailing newlines. Link arrays keep request, clause, work and other message IDs
distinct; text similarity does not merge originals.

Native transport derives its compatibility shadow from that original. The active transport path
finds the original by canonical sender namespace and message ID, then validates every shadow
read/save against the same envelope. Missing or mismatched canonical data is unavailable, not an
empty inbox or permission to reconstruct an original. Publish first; transport admission is a
separate operation. A crash between them leaves an original discoverable without implying a
native attempt occurred.

Guards record `question` and `hold` states, references and canonical metadata artifacts.
`unknown` and `unavailable` stay distinct from `clear`. Neither a handling receipt nor a transport
state clears a question, releases a HOLD or supplies approval. Artifact references preserve exact
supporting metadata without opening referenced authentication or private configuration files.

## Message API

Construct `ProtocolMessages({ store })` with the selected `ProtocolStore`. Mutating methods take
a `MessageWriter` first: `role`, `epoch`, `binding`, transaction `id`, `expectedRevision` and `at`.
The sender writer's role must match `protocolNamespace(envelope.fromRole)`.

| Method                            | Result and boundary                                                            |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `publish(writer, input)`          | Publishes the canonical envelope, links and guards; returns `OriginalRef`      |
| `find(senderRole, messageId)`     | Finds a published original reference, or returns null                          |
| `read(ref)`                       | Verifies and returns the canonical original, including its exact body          |
| `receipt(writer, input)`          | Publishes recipient handling and evidence in the recipient namespace           |
| `latestRecipientReceipt(ref)`     | Returns `{ reference, value }` for current published handling, or null         |
| `observeTransport(writer, input)` | Anchors an exact transport-record artifact without creating a handling receipt |
| `withdraw(writer, input)`         | Publishes a sender statement with `status: "requested"`                        |
| `inbox(options)`                  | Discovers published originals, receipts, observations and withdrawals          |
| `withReadView(action)`            | Shares an operation-local synchronous filesystem view across reads             |

Filesystem reads need no writer credentials and perform no native availability probe. An inbox
has `scope: "published-only"`; it is not universal native or historical request coverage. It
lists its sender scope and omits bodies unless `includeBody: true`. For example:

```ts
const messages = new ProtocolMessages({ store });
const reference = messages.find(protocolNamespace("delivery-kit"), messageId);
if (reference !== null) {
  const original = messages.read(reference);
  const receipt = messages.latestRecipientReceipt(reference);
}
const inbox = messages.inbox({ recipientRole: protocolNamespace("game-kit"), includeBody: true });
```

Read views cache committed role state only within the synchronous operation. They are not
long-lived route or native guard caches, and writes are refused inside them. Separate roles are
not read or committed as one cross-role transaction.

The CLI exposes the same filesystem fallback with explicit canonical recipient and sender scopes:

```sh
delivery-kit --root /path/to/game-coordinator protocol inbox \
  --role kits/game-kit --sender kits/delivery-kit --include-body
delivery-kit --root /path/to/game-coordinator protocol message-original \
  --input-file original-ref.json --include-body
```

`original-ref.json` contains the exact `OriginalRef`. Both commands omit bodies without
`--include-body`. Publication, receipt, observation and withdrawal commands take `--input-file`
JSON containing `{ writer, input }`; they do not send native input. An explicit `--state-root`
can select a prepared migration root; it does not activate it or create a default root.

## Receipts, retention and withdrawal

A handling receipt binds the exact original reference and contains evidence artifact references,
observed guards and its disposition. Only the recipient may publish it. A worker-target receipt
belongs in the verified child's namespace; a parent receipt cannot attest child handling.
Retention requires an owner, reason and next review boundary. The current receipt has a revision;
earlier versions remain in immutable event history. Replaying an old receipt ID does not replace
newer handling. Even idempotent mutation paths check the current writer fence.

`accepted` is a native transport observation, not a handling disposition. In active protocol
mode, reflecting handled, superseded or retained state into a transport shadow requires the
already-published matching recipient receipt. The legacy reconcile evidence anchor is exactly
`protocol-receipt:<receipt.reference.hash>`; retained metadata must match the receipt. A caller's
assertion or imported historical handled state cannot manufacture that receipt. Public transport
status reports `protocol.handlingAttestation` as `attested` or `unattested`, plus the disposition;
it does not print receipt hashes or bodies.

A sender withdrawal remains a request. Known sending, accepted or ambiguous transport records
produce `recall: "cannot-recall"`; otherwise recall is `not-proven`, not permission to cancel.
The statement records the recipient revision observed, or null when its namespace is unknown.
Concurrent recipient handling remains separate; no cross-role atomic recall or automatic ACK is
claimed. Ambiguous delivery requires reconciliation before retrying any native operation.

## Migration and recovery

Without protocol configuration, the existing caller-agnostic 4.4 reconcile contract remains
compatible. Protocol activation is a distinct reviewed migration, not an automatic reinterpretation
of historical caller authority.

Imported originals retain the exact legacy ID, envelope hash and opaque record artifact, with an
explicit import evidence reference. That artifact is historical evidence; the sender publication
is the canonical original after migration. Old attempts and handling claims remain historical
transport observations. No recipient receipt is inferred. Unknown source ownership stays staged
and unpublished until an explicit current owner can publish under its fence.

Before activation, require reviewed readers/writers, an independently located approved local
backup, verified restore, hash inventory, matching canonical originals for preserved transport
records, and fencing of affected old writers. Essential evidence must be promoted before task
cleanup. Do not move game bus/control state, registry or credentials as part of this protocol.
There is no automatic dual write, new timer, daemon or provider restart.

Recovery checks use isolated synthetic fixtures for publication failure, lost responses after
commit, context loss, filesystem discovery without a channel, task cleanup, guarded retention and
ownership rotation. They qualify filesystem/API behavior, not real native delivery, recipient
handling or universal human-input capture. Live adoption and backup destination selection remain
separate operator actions.
