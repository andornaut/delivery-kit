# Libraries

The public Node build API: its subpath and compatibility alias, and the source identity library.

## Public build API

The library API is a Node build and operations tool, not an API for the running game. Import its
explicit canonical subpath:

| Canonical subpath                               | Purpose                                              | Deprecated compatibility alias            |
| ----------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `@andornaut/delivery-kit/build/source-identity` | Exact Git identity capture and isolated restoration. | `@andornaut/delivery-kit/source-identity` |

The alias resolves to the same bundle and declarations as its canonical path. Known consumers
include Ada the Navigator's source-identity integration. CLEANUP (added 2026-11-15): remove the
compatibility alias only after the known consumer owners confirm migration to the canonical path.
Use the canonical path in new integrations.

The registry, transport, accounting and protocol subpaths and their unprefixed aliases moved to
`@andornaut/coordination-kit/build/registry`, `/build/transport`, `/build/accounting` and
`/build/protocol` in 5.0 ([coordination-kit libraries](https://github.com/andornaut/coordination-kit/blob/main/docs/libraries.md),
[upgrading to 5.0](upgrading.md#upgrading-to-50)). delivery-kit does not re-export them.

There is no root barrel, wildcard export, public runtime API or public test API. Fixtures,
harnesses and private modules are not exported. The `./package.json` export is package metadata,
not a game API. The CLI remains the operator entry point.

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
