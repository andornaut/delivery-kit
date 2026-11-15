// Exact, history-free Git identity for an independently copied working tree.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
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
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SourceIdentityEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "tree" | "blob";
  readonly oid: string;
}
export interface SourceIdentityManifest {
  readonly schema: 1;
  readonly commit: string;
  readonly tree: string;
  readonly entries: readonly SourceIdentityEntry[];
  readonly objects: readonly { readonly oid: string; readonly type: "commit" | "tree" | "blob" }[];
  readonly packSha256: string;
  readonly sourceFingerprint: string;
  readonly digest: string;
}
export interface SourceIdentityStatus {
  readonly commit: string;
  readonly tree: string;
  readonly dirty: boolean;
  readonly status: string;
}
export class SourceIdentityError extends Error {}

const OID = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BUFFER = 256 * 1024 * 1024;

function requireIdentity(condition: unknown, reason: string): asserts condition {
  if (!condition) {
    throw new SourceIdentityError(reason);
  }
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/** Caller approval is mandatory; filename checks cannot identify secret content. */
function safePath(path: string): void {
  requireIdentity(
    path.length > 0 && !isAbsolute(path) && !/[\\:]/u.test(path) && !hasControl(path),
    "unsupported tracked path",
  );
  for (const part of path.split("/")) {
    requireIdentity(
      part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part),
      "unsupported tracked path component",
    );
    requireIdentity(
      !/^(?:\.git|\.gitmodules|\.gitconfig|\.git-credentials|\.ssh|\.private|\.aws|\.gnupg)$/iu.test(
        part,
      ) &&
        !/^(?:\.npmrc|\.netrc|\.claude|\.codex|agents\.md|gemini\.md)$/iu.test(part) &&
        !/^(?:\.env(?:$|[.-])|credentials?(?:[.-]|$)|secrets?(?:[.-]|$)|id_(?:rsa|ed25519|ecdsa)(?:\.|$))/iu.test(
          part,
        ) &&
        !/^claude(?:\.local)?\.md$/iu.test(part) &&
        !/\.(?:pem|key|p12|pfx|jks|keystore|crt|cer)$/iu.test(part),
      "forbidden tracked path",
    );
  }
}

function realDirectory(path: string): string {
  const absolute = resolve(path);
  requireIdentity(lstatSync(absolute).isDirectory(), "expected real directory");
  requireIdentity(realpathSync(absolute) === absolute, "symbolic directory ancestry unsupported");
  return absolute;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function plainFile(path: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requireIdentity(fstatSync(descriptor).isFile(), "expected regular file");
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

interface GitContext {
  readonly directory: string;
  readonly workRoot: string;
  readonly objects?: string;
}

// No inherited Git variables, user/system/repository configuration, hooks or attributes.
function git(context: GitContext, args: readonly string[], input?: Buffer | string): Buffer {
  try {
    return execFileSync(
      "git",
      [
        "--no-replace-objects",
        "--git-dir",
        context.directory,
        "--work-tree",
        context.workRoot,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.bare=false",
        "-c",
        "core.quotePath=true",
        "-c",
        "core.fileMode=true",
        "-c",
        "protocol.allow=never",
        "-c",
        "pack.threads=1",
        ...args,
      ],
      {
        env: {
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_LITERAL_PATHSPECS: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          HOME: context.directory,
          LC_ALL: "C",
          PATH: process.env.PATH,
          ...(context.objects === undefined ? {} : { GIT_OBJECT_DIRECTORY: context.objects }),
        },
        input,
        maxBuffer: MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    throw new SourceIdentityError("isolated Git operation failed");
  }
}

function initialise(directory: string, workRoot: string): GitContext {
  mkdirSync(directory);
  const context = { directory, workRoot };
  git(context, ["init", "--template=", "--object-format=sha1"]);
  mkdirSync(join(directory, "info"), { recursive: true });
  // Repository-local attributes have highest precedence, including over tracked attributes.
  writeFileSync(
    join(directory, "info", "attributes"),
    "* -text -eol -ident -filter -working-tree-encoding\n",
  );
  return context;
}

function sourceMetadata(root: string): { directory: string; common: string } {
  let directory = join(root, ".git");
  const stat = lstatSync(directory);
  if (stat.isFile()) {
    const pointer = plainFile(directory).toString("utf8");
    requireIdentity(/^gitdir: [^\r\n]+\n?$/u.test(pointer), "invalid worktree pointer");
    directory = resolve(root, pointer.slice(8).trimEnd());
    requireIdentity(
      directory.includes(`${sep}.git${sep}worktrees${sep}`),
      "unsupported git directory",
    );
  }
  directory = realDirectory(directory);
  const commonFile = join(directory, "commondir");
  const common = existsSync(commonFile)
    ? realDirectory(resolve(directory, plainFile(commonFile).toString("utf8").trim()))
    : directory;
  requireIdentity(common.endsWith(`${sep}.git`), "unsupported common Git directory");
  return { common, directory };
}

function sourceHead(metadata: { directory: string; common: string }): string {
  const head = plainFile(join(metadata.directory, "HEAD")).toString("utf8").trim();
  if (OID.test(head)) {
    return head;
  }
  requireIdentity(/^ref: refs\/heads\/[A-Za-z0-9_./-]+$/u.test(head), "unsupported source HEAD");
  const ref = head.slice(5);
  requireIdentity(
    !ref.split("/").some((part) => part === ".." || part === "."),
    "invalid source ref",
  );
  const path = join(metadata.common, ref);
  let value: string | undefined;
  if (existsSync(path)) {
    requireIdentity(realpathSync(dirname(path)) === dirname(path), "symbolic ref ancestry");
    value = plainFile(path).toString("utf8").trim();
  } else if (existsSync(join(metadata.common, "packed-refs"))) {
    value = plainFile(join(metadata.common, "packed-refs"))
      .toString("utf8")
      .split("\n")
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(" ")[0];
  }
  requireIdentity(value !== undefined && OID.test(value), "unresolved source HEAD");
  return value;
}

function validateObjectsDirectory(directory: string): void {
  realDirectory(directory);
  requireIdentity(
    !existsSync(join(directory, "info", "alternates")),
    "object alternates unsupported",
  );
  requireIdentity(
    !existsSync(join(directory, "info", "http-alternates")),
    "object alternates unsupported",
  );
  // Reject links before Git can follow an object or pack outside this object database.
  function walk(path: string): void {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = lstatSync(child);
      requireIdentity(!stat.isSymbolicLink(), "symbolic object storage unsupported");
      if (stat.isDirectory()) {
        walk(child);
      } else {
        requireIdentity(stat.isFile(), "unsupported object storage");
      }
    }
  }
  walk(directory);
}

function inventory(
  context: GitContext,
  commit: string,
): { tree: string; entries: SourceIdentityEntry[] } {
  requireIdentity(
    git(context, ["cat-file", "-t", commit]).toString().trim() === "commit",
    "expected commit object",
  );
  const raw = git(context, ["cat-file", "commit", commit]);
  const tree = raw.subarray(0, raw.indexOf(10)).toString().slice(5);
  requireIdentity(OID.test(tree), "invalid commit tree");
  const listing = git(context, ["ls-tree", "-r", "-t", "-z", "--full-tree", tree]);
  requireIdentity(Buffer.from(listing.toString("utf8")).equals(listing), "non-UTF8 tracked path");
  const entries = listing
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line): SourceIdentityEntry => {
      const match = /^(040000|100644|100755|120000) (tree|blob) ([a-f0-9]{40})\t(.+)$/u.exec(line);
      requireIdentity(match !== null, "unsupported tracked mode or gitlink");
      const mode = match[1]!;
      const type = match[2] as "tree" | "blob";
      const oid = match[3]!;
      const path = match[4]!;
      safePath(path);
      requireIdentity(mode !== "120000", "symbolic links unsupported");
      requireIdentity((mode === "040000") === (type === "tree"), "invalid tree mode");
      return { mode, oid, path, type };
    });
  return { entries, tree };
}

function objectInventory(
  commit: string,
  tree: string,
  entries: readonly SourceIdentityEntry[],
): SourceIdentityManifest["objects"] {
  const objects = new Map<string, "commit" | "tree" | "blob">([
    [commit, "commit"],
    [tree, "tree"],
  ]);
  for (const entry of entries) {
    requireIdentity(
      !objects.has(entry.oid) || objects.get(entry.oid) === entry.type,
      "object type collision",
    );
    objects.set(entry.oid, entry.type);
  }
  return [...objects].sort(([a], [b]) => a.localeCompare(b)).map(([oid, type]) => ({ oid, type }));
}

function workingPath(root: string, path: string): string | null {
  const parts = path.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    requireIdentity(!stat.isSymbolicLink(), "symbolic working paths unsupported");
    if (index < parts.length - 1) {
      requireIdentity(stat.isDirectory(), "unsafe working path ancestor");
    }
  }
  return current;
}

function status(context: GitContext, commit: string, tree: string): SourceIdentityStatus {
  const value = git(context, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
  ]).toString("utf8");
  return { commit, dirty: value !== "", status: value, tree };
}

function fingerprint(
  context: GitContext,
  entries: readonly SourceIdentityEntry[],
  head: string,
): string {
  const digest = createHash("sha256").update(head);
  const state = git(context, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  digest.update(state);
  // Unapproved untracked contents are never opened. Metadata detects concurrent changes.
  for (const item of state.toString("utf8").split("\0")) {
    if (!item.startsWith("?? ")) {
      continue;
    }
    const path = workingPath(context.workRoot, item.slice(3));
    if (path !== null) {
      const stat = lstatSync(path);
      digest.update(JSON.stringify([item, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
    }
  }
  for (const entry of entries) {
    const path = workingPath(context.workRoot, entry.path);
    digest.update(JSON.stringify(entry));
    if (path === null) {
      digest.update("absent");
      continue;
    }
    const stat = lstatSync(path);
    digest.update(JSON.stringify([stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isFile()) {
      digest.update(plainFile(path));
    } else {
      requireIdentity(stat.isDirectory(), "unsupported working file");
    }
  }
  return digest.digest("hex");
}

function manifestDigest(manifest: Omit<SourceIdentityManifest, "digest">): string {
  return hash(JSON.stringify(manifest));
}

/** approvedPaths must be the caller's complete, safety-approved HEAD file inventory. */
export function snapshotSourceIdentity(
  context: { readonly sourceRoot: string; readonly artifactDir: string },
  input: { readonly expectedCommit: string; readonly approvedPaths: readonly string[] },
): SourceIdentityManifest {
  requireIdentity(OID.test(input.expectedCommit), "expected full lowercase SHA1 commit");
  const root = realDirectory(context.sourceRoot);
  const output = resolve(context.artifactDir);
  requireIdentity(relative(root, output).startsWith(`..${sep}`), "artifact must be outside source");
  realDirectory(dirname(output));
  requireIdentity(!existsSync(output), "artifact directory already exists");
  const metadata = sourceMetadata(root);
  const objects = join(metadata.common, "objects");
  validateObjectsDirectory(objects);
  const beforeHead = sourceHead(metadata);
  requireIdentity(beforeHead === input.expectedCommit, "source HEAD mismatch");
  const temporary = mkdtempSync(join(dirname(output), ".delivery-source-identity-"));
  try {
    const isolated = initialise(join(temporary, "git"), root);
    const reader = { ...isolated, objects };
    const { entries, tree } = inventory(reader, beforeHead);
    const approved = [...input.approvedPaths].sort();
    approved.forEach(safePath);
    const tracked = entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .sort();
    requireIdentity(
      JSON.stringify(tracked) === JSON.stringify(approved),
      "approved inventory must exactly cover tracked files",
    );
    for (const entry of entries) {
      workingPath(root, entry.path);
    }
    writeFileSync(join(reader.directory, "HEAD"), `${beforeHead}\n`);
    writeFileSync(join(reader.directory, "shallow"), `${beforeHead}\n`);
    git(reader, ["read-tree", tree]);
    const indexPath = join(metadata.directory, "index");
    const indexBefore = entryExists(indexPath) ? hash(plainFile(indexPath)) : "absent";
    const before = hash(fingerprint(reader, entries, beforeHead) + indexBefore);
    const objectList = objectInventory(beforeHead, tree, entries);
    const pack = git(
      reader,
      ["pack-objects", "--stdout", "--no-reuse-delta", "--no-reuse-object", "--window=0"],
      `${objectList.map((object) => object.oid).join("\n")}\n`,
    );
    const afterHead = sourceHead(metadata);
    const indexAfter = entryExists(indexPath) ? hash(plainFile(indexPath)) : "absent";
    const after = hash(fingerprint(reader, entries, afterHead) + indexAfter);
    requireIdentity(before === after && afterHead === beforeHead, "source changed during snapshot");
    const unsigned = {
      commit: beforeHead,
      entries,
      objects: objectList,
      packSha256: hash(pack),
      schema: 1 as const,
      sourceFingerprint: before,
      tree,
    };
    const manifest = { ...unsigned, digest: manifestDigest(unsigned) };
    mkdirSync(output);
    writeFileSync(join(output, "objects.pack"), pack, { flag: "wx" });
    writeFileSync(join(output, "identity.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx" });
    return manifest;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

/** Existing working files are never checked out, staged, deleted or rewritten. */
export function restoreSourceIdentity(
  context: { readonly workRoot: string; readonly artifactDir: string },
  expected: {
    readonly expectedCommit: string;
    readonly expectedTree: string;
    readonly expectedDigest: string;
  },
): SourceIdentityStatus {
  requireIdentity(
    OID.test(expected.expectedCommit) &&
      OID.test(expected.expectedTree) &&
      HASH.test(expected.expectedDigest),
    "invalid expected identity",
  );
  const root = realDirectory(context.workRoot);
  const artifact = realDirectory(context.artifactDir);
  requireIdentity(!entryExists(join(root, ".git")), "working tree already has Git metadata");
  let manifest: SourceIdentityManifest;
  try {
    manifest = JSON.parse(
      plainFile(join(artifact, "identity.json")).toString("utf8"),
    ) as SourceIdentityManifest;
  } catch {
    throw new SourceIdentityError("invalid identity manifest");
  }
  requireIdentity(manifest !== null && typeof manifest === "object", "invalid manifest");
  const { digest, ...unsigned } = manifest;
  requireIdentity(
    manifest.schema === 1 &&
      digest === expected.expectedDigest &&
      manifestDigest(unsigned) === digest &&
      manifest.commit === expected.expectedCommit &&
      manifest.tree === expected.expectedTree,
    "manifest identity mismatch",
  );
  const pack = plainFile(join(artifact, "objects.pack"));
  requireIdentity(hash(pack) === manifest.packSha256, "pack digest mismatch");
  const temporary = mkdtempSync(join(dirname(root), ".delivery-identity-"));
  try {
    const isolated = initialise(join(temporary, "git"), root);
    git(isolated, ["index-pack", "--stdin"], pack);
    const { entries, tree } = inventory(isolated, expected.expectedCommit);
    const objects = objectInventory(expected.expectedCommit, tree, entries);
    requireIdentity(
      tree === expected.expectedTree &&
        JSON.stringify(entries) === JSON.stringify(manifest.entries) &&
        JSON.stringify(objects) === JSON.stringify(manifest.objects),
      "tree or object inventory mismatch",
    );
    const actual = git(isolated, [
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype)",
    ])
      .toString()
      .trim()
      .split("\n")
      .sort();
    requireIdentity(
      JSON.stringify(actual) ===
        JSON.stringify(objects.map((object) => `${object.oid} ${object.type}`).sort()),
      "unexpected or missing packed objects",
    );
    for (const entry of entries) {
      workingPath(root, entry.path);
    }
    writeFileSync(join(isolated.directory, "shallow"), `${expected.expectedCommit}\n`);
    writeFileSync(join(isolated.directory, "HEAD"), `${expected.expectedCommit}\n`);
    git(isolated, ["fsck", "--strict", "--no-reflogs"]);
    git(isolated, ["read-tree", expected.expectedCommit]);
    requireIdentity(
      git(isolated, ["write-tree"]).toString().trim() === tree,
      "index tree mismatch",
    );
    const result = status(isolated, expected.expectedCommit, tree);
    // Atomically refuse any metadata entry created since initial validation.
    const destination = join(root, ".git");
    mkdirSync(destination);
    renameSync(isolated.directory, destination);
    return result;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}
