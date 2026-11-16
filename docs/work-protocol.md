# Filesystem work protocol

The work protocol publishes durable work and message records under one explicitly configured
external state root. Filesystem discovery works when notifications or a channel are unavailable.
Discovery is read-only; it does not deliver native input, acknowledge queues or answer questions.

## Configuration and authority

`var/work-protocol.json` names `schema: 1`, `workspaceId`, `stateRoot` and `generation`. The root
must be outside known source checkouts and task worktrees, including resolved symlink ancestors.
There is no inferred default root. Missing configuration reports protocol unavailable and keeps
the legacy compatibility path; it does not enable a second writable backend.

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

Committed history is the publication authority. Sparse indexes are derived views. Canonical
artifacts contain immutable bytes, addressed by lowercase SHA-256 and byte size; readers verify
the bytes before use. A task or temporary path alone is insufficient essential evidence.

The existing request ledger remains the request-state authority. Work publications link request,
clause, work, message and evidence identities rather than copying request states into another
ledger. Worker READY, parent acceptance, integration, delivery and acceptance remain distinct.

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
