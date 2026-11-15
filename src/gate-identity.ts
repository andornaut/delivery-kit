// Private bridge between the reviewed source-identity helpers and a stock Git/tar gate image.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BusContext } from "./bus/context.ts";
import { assertNotInterrupted, git } from "./bus/exec.ts";
import {
  restoreSourceIdentity,
  snapshotSourceIdentity,
  type SourceIdentityEntry,
  type SourceIdentityManifest,
} from "./source-identity.ts";

interface CapturedGateIdentity {
  readonly manifest: SourceIdentityManifest;
  readonly copied: string;
  readonly artifact: string;
  readonly directory: string;
}

export interface GateIdentity extends CapturedGateIdentity {
  readonly archive: string;
  readonly archiveBlob: string;
  readonly objectsBlob: string;
  readonly configBlob: string;
}

/** Names/modes only. An unapproved directory is rejected without traversing its contents. */
function sourceOnly(
  root: string,
  entries: readonly Pick<SourceIdentityEntry, "path" | "type">[],
): void {
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== resolve(root)) {
    throw new Error("gate source must be a real directory without symbolic ancestry");
  }
  const approved = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory)) {
      const relative = `${prefix}${name}`;
      if (relative === ".git") {
        continue;
      }
      const entry = approved.get(relative);
      if (entry === undefined) {
        throw new Error("gate source contains a path outside the approved tracked inventory");
      }
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (
        (entry.type === "tree" && !stat.isDirectory()) ||
        (entry.type === "blob" && !stat.isFile())
      ) {
        throw new Error("gate source contains an unsupported filesystem entry");
      }
      seen.add(relative);
      if (entry.type === "tree") {
        walk(path, `${relative}/`);
      }
    }
  }
  walk(root, "");
  if (seen.size !== approved.size) {
    throw new Error("gate source does not contain the complete approved tracked inventory");
  }
}

/** GateInput already selects the entire exact tracked tree, not a new public content policy. */
export async function captureGateIdentity(
  context: Pick<BusContext, "exec">,
  input: { readonly work: string; readonly sha: string },
): Promise<GateIdentity> {
  const directory = mkdtempSync(join(tmpdir(), "delivery-gate-identity-"));
  try {
    const inventory = assertNotInterrupted(
      "git ls-tree",
      await context.exec({
        args: ["-C", input.work, "ls-tree", "-r", "-z", "--name-only", input.sha],
        command: "git",
      }),
    );
    if (inventory.status !== 0) {
      throw new Error("gate source tracked inventory unavailable");
    }
    const approvedPaths = inventory.stdout.split("\0").filter(Boolean);
    const entries = new Map<string, Pick<SourceIdentityEntry, "path" | "type">>();
    for (const path of approvedPaths) {
      entries.set(path, { path, type: "blob" });
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join("/");
        entries.set(directory, { path: directory, type: "tree" });
      }
    }
    // Reject ignored/untracked stores before even the snapshot helper scans Git status.
    sourceOnly(input.work, [...entries.values()]);
    const artifact = join(directory, "artifact");
    const manifest = snapshotSourceIdentity(
      { artifactDir: artifact, sourceRoot: input.work },
      { approvedPaths, expectedCommit: input.sha },
    );
    sourceOnly(input.work, manifest.entries);
    const copied = join(directory, "copied");
    mkdirSync(copied);
    chmodSync(copied, 0o755);
    for (const entry of manifest.entries) {
      const destination = join(copied, entry.path);
      if (entry.type === "tree") {
        mkdirSync(destination);
        chmodSync(destination, 0o755);
        continue;
      }
      const source = join(input.work, entry.path);
      if (realpathSync(join(source, "..")) !== resolve(join(source, ".."))) {
        throw new Error("gate source directory changed during staging");
      }
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
          throw new Error("gate source file changed during staging");
        }
        writeFileSync(destination, readFileSync(fd), { flag: "wx" });
        // Only image readability changes; the actual executable bit remains part of Git proof.
        chmodSync(destination, stat.mode & 0o100 ? 0o755 : 0o644);
      } finally {
        closeSync(fd);
      }
    }
    sourceOnly(input.work, manifest.entries);
    if ((await git(context.exec, input.work, ["rev-parse", "HEAD"])) !== input.sha) {
      throw new Error("gate source HEAD changed during staging");
    }
    const captured = { artifact, copied, directory, manifest };
    const prepared = prepareGateIdentity(captured);
    renameSync(join(copied, ".git"), join(directory, "generated-git"));
    return { ...captured, ...prepared };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function blobHash(bytes: Buffer | string): string {
  const body = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

/** USTAR for freshly generated .git only. No source files, links, original metadata or stdout. */
function archiveMetadata(directory: string, output: string): string {
  const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const digest = createHash("sha1");
  let length = 0;
  const blocks: Buffer[] = [];
  function member(path: string, name: string): void {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error("generated gate metadata contains an unsupported entry");
    }
    const directories = [
      ".git",
      ".git/info",
      ".git/refs",
      ".git/refs/heads",
      ".git/refs/tags",
      ".git/objects",
      ".git/objects/info",
      ".git/objects/pack",
    ];
    const files = [
      ".git/HEAD",
      ".git/config",
      ".git/index",
      ".git/shallow",
      ".git/info/attributes",
    ];
    const permitted = stat.isDirectory()
      ? directories.includes(name) || /^\.git\/objects\/[a-f0-9]{2}$/u.test(name)
      : files.includes(name) ||
        /^\.git\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/u.test(name) ||
        /^\.git\/objects\/pack\/pack-[a-f0-9]{40}\.(?:pack|idx|rev)$/u.test(name);
    if (!permitted) {
      throw new Error("generated gate metadata archive member is not allowed");
    }
    if (Buffer.byteLength(name) > 100 || name.split("/").some((part) => part === "..")) {
      throw new Error("generated gate metadata has an unsupported archive path");
    }
    const data = stat.isFile() ? readFileSync(path) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(name);
    const octal = (value: number, at: number, width: number): void => {
      const encoded = value.toString(8).padStart(width - 1, "0");
      if (encoded.length >= width) {
        throw new Error("gate metadata archive field overflow");
      }
      header.write(`${encoded}\0`, at, width, "ascii");
    };
    octal(stat.isDirectory() ? 0o700 : 0o600, 100, 8);
    octal(19001, 108, 8);
    octal(19001, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write(stat.isDirectory() ? "5" : "0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        member(join(path, child), `${name}/${child}`);
      }
    }
  }
  try {
    // Docker cp creates a root-owned staging file; only this fresh metadata archive is readable.
    fchmodSync(fd, 0o644);
    member(directory, ".git");
    blocks.push(Buffer.alloc(1024));
    for (const block of blocks) {
      length += block.length;
    }
    digest.update(`blob ${length}\0`);
    for (const block of blocks) {
      let offset = 0;
      while (offset < block.length) {
        offset += writeSync(fd, block, offset);
      }
      digest.update(block);
    }
    return digest.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Restore against the actual selected source copy, never an empty clean stand-in. */
function prepareGateIdentity(identity: CapturedGateIdentity): {
  readonly archive: string;
  readonly archiveBlob: string;
  readonly objectsBlob: string;
  readonly configBlob: string;
} {
  sourceOnly(identity.copied, identity.manifest.entries);
  const restored = restoreSourceIdentity(
    { artifactDir: identity.artifact, workRoot: identity.copied },
    {
      expectedCommit: identity.manifest.commit,
      expectedDigest: identity.manifest.digest,
      expectedTree: identity.manifest.tree,
    },
  );
  if (restored.dirty) {
    throw new Error("gate source identity copy is dirty");
  }
  // The generated metadata moves between roots; no host worktree path may cross that boundary.
  writeFileSync(
    join(identity.copied, ".git", "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      "\tbare = false",
      "\tlogallrefupdates = false",
      "\thooksPath = /dev/null",
      "\tfsmonitor = false",
      "\tuntrackedCache = false",
      "",
    ].join("\n"),
  );
  const archive = join(identity.directory, "identity.tar");
  return {
    archive,
    archiveBlob: archiveMetadata(join(identity.copied, ".git"), archive),
    configBlob: blobHash(readFileSync(join(identity.copied, ".git", "config"))),
    objectsBlob: blobHash(
      identity.manifest.objects.map((object) => `${object.oid} ${object.type}\n`).join(""),
    ),
  };
}

export function releaseGateIdentity(identity: GateIdentity): void {
  rmSync(identity.directory, { force: true, recursive: true });
}

/** No inherited alternate Git context, injected configuration, helpers or object stores. */
export const GATE_GIT_ENV = [
  "unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY",
  "unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_SHALLOW_FILE GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS",
  "unset GIT_CONFIG GIT_TEMPLATE_DIR GIT_EXEC_PATH GIT_NAMESPACE GIT_REPLACE_REF_BASE GIT_ATTR_SOURCE",
  "unset GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM GIT_PREFIX GIT_INTERNAL_SUPER_PREFIX",
  "unset GIT_GRAFT_FILE GIT_QUARANTINE_PATH GIT_DEFAULT_HASH GIT_DEFAULT_REF_FORMAT",
  "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null",
  "export GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0",
].join(" && ");

export const GATE_GIT_CONTEXT = [
  "export GIT_DIR=/tmp/work/.git GIT_COMMON_DIR=/tmp/work/.git GIT_WORK_TREE=/tmp/work",
  "export GIT_INDEX_FILE=/tmp/work/.git/index GIT_OBJECT_DIRECTORY=/tmp/work/.git/objects",
  "export GIT_SHALLOW_FILE=/tmp/work/.git/shallow",
].join(" && ");

/** Read-only validation is shared by admission and the boundary after install. */
export const GATE_VERIFY_IDENTITY_SCRIPT = [
  GATE_GIT_ENV,
  "cd /tmp/work",
  'test "$(git -C /tmp hash-object --no-filters /tmp/work/.git/config)" = "$EXPECTED_CONFIG_BLOB"',
  'test "$(git rev-parse --show-toplevel)" = /tmp/work',
  'test "$(git rev-parse --absolute-git-dir)" = /tmp/work/.git',
  GATE_GIT_CONTEXT,
  'test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"',
  'test "$(git rev-parse HEAD^{tree})" = "$EXPECTED_TREE"',
  'test "$(git write-tree)" = "$EXPECTED_TREE"',
  "index=$(git ls-files -v)",
  [
    "{ while IFS= read -r entry; do case \"$entry\" in 'H '*) ;; *) exit 1 ;; esac; done <<GATE_INDEX",
    "$index",
    "GATE_INDEX",
    "}",
  ].join("\n"),
  'test "$(git rev-list --count HEAD)" = 1',
  "objects=$(git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' | git hash-object --stdin)",
  'test "$objects" = "$EXPECTED_OBJECTS_BLOB"',
  "git fsck --strict --no-reflogs",
  "status=$(git status --porcelain=v1 --untracked-files=all)",
  'test -z "$status"',
].join(" && ");

/** All tools already belong to the stock image contract; extraction runs as its gate user. */
export const GATE_IDENTITY_SCRIPT = [
  GATE_GIT_ENV,
  "cd /tmp/work",
  "test ! -e .git && test ! -L .git",
  'test "$(git hash-object --no-filters /tmp/gate-source-identity.tar)" = "$EXPECTED_ARCHIVE_BLOB"',
  "tar -xf /tmp/gate-source-identity.tar -C /tmp/work",
  GATE_VERIFY_IDENTITY_SCRIPT,
].join(" && ");
