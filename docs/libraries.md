# Libraries

The public Node build APIs: their canonical subpaths and compatibility aliases, the registry library, transport endpoint selection and the source identity library.

## Public build APIs

All library APIs are Node build/operations tools, not APIs for the running game. Import their
explicit canonical subpaths:

| Canonical subpath                               | Purpose                                                                                       | Deprecated compatibility alias            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `@andornaut/delivery-kit/build/registry`        | Registry configuration, routing and guarded updates.                                          | `@andornaut/delivery-kit/registry`        |
| `@andornaut/delivery-kit/build/transport`       | Read-only endpoint selection and message channel path references.                             | `@andornaut/delivery-kit/transport`       |
| `@andornaut/delivery-kit/build/source-identity` | Exact Git identity capture and isolated restoration.                                          | `@andornaut/delivery-kit/source-identity` |
| `@andornaut/delivery-kit/build/accounting`      | Request ledger, intake retention and closure evidence ([guide](request-accounting.md)).       | `@andornaut/delivery-kit/accounting`      |
| `@andornaut/delivery-kit/build/protocol`        | Fenced filesystem work, message originals and recipient receipts ([guide](work-protocol.md)). | `@andornaut/delivery-kit/protocol`        |

Each alias resolves to the same bundle and declarations as its canonical path. Known consumers
include game-coordinator's registry/transport imports and Ada the Navigator's source-identity
integration. CLEANUP (added 2026-11-15): remove compatibility aliases only after the known
consumer owners confirm migration to canonical paths. Publication alone changes no consumer
imports or pins. Use canonical paths in new integrations.

There is no root barrel, wildcard export, public runtime API or public test API. Fixtures,
harnesses and private modules are not exported. The `./package.json` export is package metadata,
not a game API. The CLI remains the operator entry point with unchanged commands.

## Registry library

`@andornaut/delivery-kit/build/registry` (`exports["./build/registry"]`: `dist/registry.js` with
`dist/registry.d.ts`) is the typed registry module the skills use. It uses only `node:` builtins
and `flock(1)`; `dist/cli.js` embeds the same source. Context parameters come first and the
subject last.

The canonical source names `GameCoordinatorConfig` and `validateGameCoordinatorConfig` are
unreleased additions. Published 4.0.0 exposes `GameDevConfig` and `validateGameDevConfig`;
this source retains those names as identical compatibility aliases. Existing 4.0.0 readers do not
use the new names, and the coordinator rename requires no kit publication or adoption.

- `loadLayout(coordinatorRoot)` and `gameLayout(layout, game)`: `config.json` and the `var/` paths.
  `roleKeys(config)` and `validateGameCoordinatorConfig(value)` use `GameCoordinatorConfig`.
- `readRegistry(layout)`: a validated snapshot carrying its `revision`; `RegistryMissing` when
  absent.
- `updateRegistry(layout, expectedRevision, mutate, options)` and
  `createRegistry(layout, initial, options)`: hold `var/registry.lock` (30 s by default), reject a
  changed revision with `RevisionConflict` or an existing file with `RegistryExists`, validate,
  write durably, increment `revision` and set `updatedAt`. An invalid result throws
  `ValidationError` and leaves the file unchanged. Pass `options.held` when the caller already
  holds the lock.
- `resolveRole(registry, role)` and `resolveConversation(registry, role)`, which throw
  `UnknownRole` for a name that is not a registered role key.
- `resolveHarness(registry, role)` returns a registered role's override or the registry default.
  `selectHarness(layout, expectedRevision, {harness, games?, roles?}, options?)` validates the
  entire explicit selection and changes only those overrides under `registry.lock`.
- `RegistrySchema`, `validateRegistry`, `HARNESSES` and `TRANSFER_PHASES`, with the record types.

## Transport endpoint selection

Import `resolveCodexControlSocket` from `@andornaut/delivery-kit/build/transport`.
It returns `{ path, source }`, selecting the explicit `controlSocket` option, then
`CODEX_CONTROL_SOCKET` from the supplied environment, then the managed socket under
`home/.codex/app-server-control/app-server-control.sock`. Invalid explicit paths
throw without fallback. Selection performs no connection or authentication probe.
Existing runtime adapters and `codex ready` still require configured endpoints.

## Source identity library

Import `snapshotSourceIdentity`, `restoreSourceIdentity` and their manifest/status types from
`@andornaut/delivery-kit/build/source-identity`. These synchronous helpers preserve an exact Git
commit for an independently copied source tree; they do not copy working files or run a gate.

- `snapshotSourceIdentity({ sourceRoot, artifactDir }, { expectedCommit, approvedPaths })`
  requires the full lowercase 40-character SHA1 HEAD and the complete safety-approved tracked
  file inventory, including `.gitignore`. Filename checks are defence in depth: callers must
  approve file contents too. Omitted tracked paths, forbidden paths, gitlinks and symbolic links
  fail closed. Regular files, executable files and trees are supported.
- The new artifact directory must be outside the source checkout. It contains `identity.json`
  and `objects.pack`: the exact raw commit, recursive current tree and blobs, without parent
  commit objects, refs, tags, configuration, remote URLs, credentials, source index or alternates.
  The manifest records `commit`, `tree`, exact entries/objects, `packSha256`,
  `sourceFingerprint` and `digest`. Source changes during capture invalidate the result.
- `restoreSourceIdentity({ workRoot, artifactDir }, { expectedCommit, expectedTree, expectedDigest })`
  requires an existing isolated writable directory without Git metadata. Obtain all three pins
  from the trusted producer receipt, not by trusting the artifact being checked. Restore verifies
  the manifest, pack and exact object inventory, creates real detached Git HEAD with that commit
  as its sole shallow boundary, and reads the index without checking out files. It never repairs
  dirty, missing or extra copied source by overwriting the working copy.

The returned `{ commit, tree, dirty, status }` reports actual porcelain-v1 working-tree status.
Git configuration, hooks, replacement objects and content-normalizing attributes are isolated;
restored Git compares raw file bytes. Dirty copies remain dirty. Any error, including
`SourceIdentityError`, leaves identity unqualified. Do not fall back to a CI label, synthetic
commit, fake Git, skip-worktree or assume-unchanged flags.

Consumers retain their existing read-only source mount, writable scratch, UID, resource limits
and before/after fingerprint checks. They must preserve the complete qualified source copy,
including dirty/untracked source, and independently compare actual restored HEAD with their CI
commit before qualifying build metadata. The API has no CI or build-ID override and does not
claim that excluded source is clean. Consumer bindings and actual build-ID checks require their
own qualification before adoption. Publishing this API changes no consumer pin, runner, gate,
registry, schedule or activation state.
