// Public bundled API contracts over genuine Git objects and independently copied source files.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect } from "vitest";

import { contract, suite } from "../lib/cases.ts";
import { KIT_ROOT } from "../lib/workspace.ts";

interface Manifest {
  commit: string;
  tree: string;
  digest: string;
  objects: { oid: string; type: string }[];
  entries: { path: string; oid: string; mode: string; type: string }[];
  [key: string]: unknown;
}
interface IdentityStatus {
  commit: string;
  tree: string;
  dirty: boolean;
  status: string;
}
type Reply<T> = { ok: true; value: T } | { ok: false };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function environment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture Author",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture Author",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    LC_ALL: "C",
  };
}

function git(root: string, args: string[], input?: string): string {
  return execFileSync(
    "git",
    // No detached auto-maintenance or gc: it writes .git files while a fingerprint walks them.
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.autocrlf=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    {
      cwd: root,
      env: environment(),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trimEnd();
}

function publicApi<T>(
  operation: "snapshot" | "restore",
  context: object,
  input: object,
  env: NodeJS.ProcessEnv = {},
): Reply<T> {
  const program = `
    import { snapshotSourceIdentity, restoreSourceIdentity } from '@andornaut/delivery-kit/build/source-identity';
    const [operation, context, input] = JSON.parse(process.argv[1]);
    try {
      const value = operation === 'snapshot'
        ? snapshotSourceIdentity(context, input) : restoreSourceIdentity(context, input);
      process.stdout.write(JSON.stringify({ok:true,value}));
    } catch { process.stdout.write(JSON.stringify({ok:false})); }
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", program, JSON.stringify([operation, context, input])],
      { cwd: KIT_ROOT, env: { ...environment(), ...env }, encoding: "utf8" },
    ),
  ) as Reply<T>;
}

function value<T>(reply: Reply<T>): T {
  expect(reply.ok).toBe(true);
  if (!reply.ok) throw new Error("public source identity operation failed");
  return reply.value;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function files(root: string, includeGit = false): string[] {
  const found: string[] = [];
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      if (!includeGit && name === ".git") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (statSync(join(root, path)).isDirectory()) walk(join(root, path), path);
      else found.push(path);
    }
  }
  walk(root, "");
  return found;
}

function fingerprint(root: string, includeGit = false): string {
  const hash = createHash("sha256");
  for (const path of files(root, includeGit)) {
    const stat = statSync(join(root, path));
    hash
      .update(path)
      .update(JSON.stringify([stat.mode, stat.mtimeMs, stat.ctimeMs]))
      .update(readFileSync(join(root, path)));
  }
  return hash.digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dk-source-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "--template=", "--initial-branch=main"]);
  write(source, ".gitignore", "ignored-output/\n");
  write(source, ".gitattributes", "asset.txt text eol=lf\n");
  write(source, "src/main.ts", "export const answer = 42;\n");
  write(source, "asset.txt", "exact asset\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "Initial source"]);
  git(source, ["checkout", "-b", "feature"]);
  write(source, "feature.txt", "feature\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "Feature source"]);
  git(source, ["checkout", "main"]);
  write(source, "main.txt", "main\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "Main source"]);
  git(source, ["merge", "--no-ff", "--no-edit", "feature"]);
  const commit = git(source, ["rev-parse", "HEAD"]);
  const tree = git(source, ["rev-parse", "HEAD^{tree}"]);
  const parents = git(source, ["show", "-s", "--format=%P", "HEAD"]).split(" ");
  const approvedPaths = git(source, ["ls-files", "-z"]).split("\0").filter(Boolean);
  return { root, source, commit, tree, parents, approvedPaths, artifact: join(root, "artifact") };
}

function snapshot(test: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = {}): Manifest {
  const before = fingerprint(test.source, true);
  const manifest = value(
    publicApi<Manifest>(
      "snapshot",
      { sourceRoot: test.source, artifactDir: test.artifact },
      { expectedCommit: test.commit, approvedPaths: test.approvedPaths },
      env,
    ),
  );
  expect(fingerprint(test.source, true)).toBe(before);
  return manifest;
}

function copy(test: ReturnType<typeof fixture>, name: string): string {
  const work = join(test.root, name);
  mkdirSync(work);
  for (const path of files(test.source)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    copyFileSync(join(test.source, path), join(work, path));
  }
  return work;
}

function restore(
  test: ReturnType<typeof fixture>,
  manifest: Manifest,
  work: string,
  expectedDigest = manifest.digest,
  env: NodeJS.ProcessEnv = {},
): Reply<IdentityStatus> {
  return publicApi(
    "restore",
    { workRoot: work, artifactDir: test.artifact },
    {
      expectedCommit: test.commit,
      expectedTree: test.tree,
      expectedDigest,
    },
    env,
  );
}

function rewriteManifest(test: ReturnType<typeof fixture>, manifest: Manifest): void {
  const unsigned = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "digest"));
  manifest.digest = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  writeFileSync(join(test.artifact, "identity.json"), JSON.stringify(manifest));
}

suite("public source identity", () => {
  contract(
    "restores the genuine merge commit without parents, refs or inherited configuration",
    () => {
      const test = fixture();
      git(test.source, ["config", "remote.origin.url", "https://fixture.invalid/source-only"]);
      git(test.source, [
        "tag",
        "-a",
        "source-only-tag",
        "-m",
        "Source tag metadata",
        test.parents[0],
      ]);
      const template = join(test.root, "template");
      mkdirSync(template);
      write(template, "must-not-copy", "fixture template metadata");
      const config = join(test.root, "global-config");
      writeFileSync(config, '[remote "inherited"]\n url = https://fixture.invalid/not-copied\n');
      const env = { GIT_CONFIG_GLOBAL: config, GIT_TEMPLATE_DIR: template };
      const manifest = snapshot(test, env);
      expect(readdirSync(test.artifact).sort()).toEqual(["identity.json", "objects.pack"]);
      expect(manifest.commit).toBe(test.commit);
      expect(manifest.tree).toBe(test.tree);
      const work = copy(test, "clean");
      const before = fingerprint(work);
      const status = value(restore(test, manifest, work, manifest.digest, env));
      expect(status).toEqual({ commit: test.commit, tree: test.tree, dirty: false, status: "" });
      expect(fingerprint(work)).toBe(before);
      expect(git(work, ["rev-parse", "HEAD"])).toBe(test.commit);
      expect(git(work, ["write-tree"])).toBe(test.tree);
      expect(git(work, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
      expect(readFileSync(join(work, ".git/shallow"), "utf8")).toBe(`${test.commit}\n`);
      expect(test.parents).toHaveLength(2);
      for (const parent of test.parents) {
        expect(
          spawnSync("git", ["cat-file", "-e", parent], { cwd: work, env: environment() }).status,
        ).not.toBe(0);
      }
      expect(
        spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: work, env: environment() }).status,
      ).not.toBe(0);
      expect(git(work, ["for-each-ref"])).toBe("");
      expect(existsSync(join(work, ".git/must-not-copy"))).toBe(false);
      expect(readFileSync(join(work, ".git/config"), "utf8")).not.toContain("fixture.invalid");
      expect(existsSync(join(work, ".git/objects/info/alternates"))).toBe(false);
      const objects = git(work, [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ]);
      expect(objects.split("\n").sort()).toEqual(
        manifest.objects.map(({ oid, type }) => `${oid} ${type}`).sort(),
      );
      // Qualification remains the consumer's explicit comparison, never an ambient CI override.
      const qualified = (ci: string) => !status.dirty && ci === git(work, ["rev-parse", "HEAD"]);
      expect(qualified(test.commit)).toBe(true);
      expect(qualified(test.parents[0])).toBe(false);
    },
  );

  contract("keeps changed, deleted and untracked copied source dirty without rewriting it", () => {
    const test = fixture();
    write(test.source, "src/main.ts", "export const answer = 0;\n");
    write(test.source, "asset.txt", "exact asset\r\n");
    unlinkSync(join(test.source, "feature.txt"));
    write(test.source, "untracked.ts", "export {};\n");
    const manifest = snapshot(test);
    const work = copy(test, "dirty");
    const before = fingerprint(work);
    const status = value(restore(test, manifest, work));
    expect(status.dirty).toBe(true);
    expect(status.status).toContain(" M src/main.ts");
    expect(status.status).toContain(" M asset.txt");
    expect(status.status).toContain(" D feature.txt");
    expect(status.status).toContain("?? untracked.ts");
    expect(fingerprint(work)).toBe(before);
    expect(git(work, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      status.status.trimEnd(),
    );
  });

  contract(
    "rejects wrong pins, malformed packs and a self-consistent but wrong object inventory",
    () => {
      const test = fixture();
      const manifest = snapshot(test);
      const work = copy(test, "rejected");
      const before = fingerprint(work);
      expect(restore(test, manifest, work, "0".repeat(64))).toEqual({ ok: false });
      expect(existsSync(join(work, ".git"))).toBe(false);
      const packPath = join(test.artifact, "objects.pack");
      const pack = readFileSync(packPath);
      writeFileSync(packPath, "not a Git pack");
      const badPack = {
        ...manifest,
        packSha256: createHash("sha256").update("not a Git pack").digest("hex"),
      };
      rewriteManifest(test, badPack);
      expect(restore(test, badPack, work)).toEqual({ ok: false });
      expect(fingerprint(work)).toBe(before);
      expect(existsSync(join(work, ".git"))).toBe(false);
      writeFileSync(packPath, pack);
      const wrongInventory = {
        ...manifest,
        objects: manifest.objects.filter((object) => object.oid !== test.commit),
      };
      rewriteManifest(test, wrongInventory);
      expect(restore(test, wrongInventory, work)).toEqual({ ok: false });
      expect(fingerprint(work)).toBe(before);
      expect(existsSync(join(work, ".git"))).toBe(false);
    },
  );

  contract("rejects omitted or unsafe tracked paths and gitlinks without changing source", () => {
    const test = fixture();
    const before = fingerprint(test.source, true);
    expect(
      publicApi(
        "snapshot",
        { sourceRoot: test.source, artifactDir: test.artifact },
        {
          expectedCommit: test.commit,
          approvedPaths: test.approvedPaths.slice(1),
        },
      ),
    ).toEqual({ ok: false });
    expect(fingerprint(test.source, true)).toBe(before);
    expect(existsSync(test.artifact)).toBe(false);
    // Synthetic object contents contain no credential material and never exist as a dotenv file.
    const blob = git(test.source, ["hash-object", "-w", "--stdin"], "fixture-only data\n");
    git(test.source, ["update-index", "--add", "--cacheinfo", `100644,${blob},.env.production`]);
    git(test.source, ["commit", "-m", "Unsafe path fixture"]);
    const unsafeBefore = fingerprint(test.source, true);
    expect(
      publicApi(
        "snapshot",
        { sourceRoot: test.source, artifactDir: test.artifact },
        {
          expectedCommit: git(test.source, ["rev-parse", "HEAD"]),
          approvedPaths: test.approvedPaths,
        },
      ),
    ).toEqual({ ok: false });
    expect(fingerprint(test.source, true)).toBe(unsafeBefore);
    git(test.source, ["update-index", "--force-remove", ".env.production"]);
    git(test.source, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${test.commit},vendor/module`,
    ]);
    git(test.source, ["commit", "-m", "Gitlink fixture"]);
    const linkedBefore = fingerprint(test.source, true);
    expect(
      publicApi(
        "snapshot",
        { sourceRoot: test.source, artifactDir: test.artifact },
        {
          expectedCommit: git(test.source, ["rev-parse", "HEAD"]),
          approvedPaths: test.approvedPaths,
        },
      ),
    ).toEqual({ ok: false });
    expect(fingerprint(test.source, true)).toBe(linkedBefore);
    git(test.source, ["update-index", "--force-remove", "vendor/module"]);
    git(test.source, ["update-index", "--add", "--cacheinfo", `100644,${blob},unsupported:path`]);
    git(test.source, ["commit", "-m", "Unsupported path fixture"]);
    const unsupportedBefore = fingerprint(test.source, true);
    expect(
      publicApi(
        "snapshot",
        { sourceRoot: test.source, artifactDir: test.artifact },
        {
          expectedCommit: git(test.source, ["rev-parse", "HEAD"]),
          approvedPaths: [...test.approvedPaths, "unsupported:path"],
        },
      ),
    ).toEqual({ ok: false });
    expect(fingerprint(test.source, true)).toBe(unsupportedBefore);
    expect(existsSync(test.artifact)).toBe(false);
  });
});
