import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  restoreSourceIdentity,
  snapshotSourceIdentity,
  SourceIdentityError,
} from "./source-identity.ts";

const interception = vi.hoisted(() => ({
  beforePack: undefined as undefined | (() => void),
  blobs: 0,
  packs: 0,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[1]?.includes("pack-objects")) {
        interception.packs++;
        interception.beforePack?.();
      }
      if (args[1]?.includes("blob")) {
        interception.blobs++;
      }
      return actual.execFileSync(...args);
    },
  };
});

const directories: string[] = [];
afterEach(() => {
  interception.beforePack = undefined;
  interception.blobs = 0;
  interception.packs = 0;
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function command(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "source-identity-test-"));
  directories.push(root);
  const sourceRoot = join(root, "source");
  const workRoot = join(root, "work");
  const artifactDir = join(root, "artifact");
  mkdirSync(sourceRoot);
  command(sourceRoot, "init", "--template=", "-b", "main");
  mkdirSync(join(sourceRoot, "src"));
  mkdirSync(join(sourceRoot, ".github"));
  writeFileSync(join(sourceRoot, "src", "app.txt"), "committed application\n");
  writeFileSync(join(sourceRoot, "remove.txt"), "retained baseline\n");
  writeFileSync(join(sourceRoot, ".gitignore"), "ignored-output/\n");
  writeFileSync(join(sourceRoot, ".gitattributes"), "*.txt filter=unconfigured\n");
  writeFileSync(join(sourceRoot, ".github", "checks.yml"), "name: Check\n");
  command(sourceRoot, "add", ".");
  command(sourceRoot, "commit", "-m", "Fixture baseline");
  const expectedCommit = command(sourceRoot, "rev-parse", "HEAD");
  const approvedPaths = command(sourceRoot, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
  function copy() {
    cpSync(sourceRoot, workRoot, {
      recursive: true,
      filter: (path) => path !== join(sourceRoot, ".git"),
    });
  }
  function snapshot() {
    return snapshotSourceIdentity({ sourceRoot, artifactDir }, { expectedCommit, approvedPaths });
  }
  function restore(manifest = snapshot()) {
    return restoreSourceIdentity(
      { workRoot, artifactDir },
      {
        expectedCommit: manifest.commit,
        expectedTree: manifest.tree,
        expectedDigest: manifest.digest,
      },
    );
  }
  return {
    root,
    sourceRoot,
    workRoot,
    artifactDir,
    expectedCommit,
    approvedPaths,
    copy,
    snapshot,
    restore,
  };
}

describe("isolated source identity", () => {
  it("restores the real merge commit and complete current tree with no parent history or working-file writes", () => {
    const test = setup();
    const original = command(test.sourceRoot, "rev-parse", "HEAD");
    command(test.sourceRoot, "checkout", "-b", "topic");
    writeFileSync(join(test.sourceRoot, "topic.txt"), "topic\n");
    command(test.sourceRoot, "add", ".");
    command(test.sourceRoot, "commit", "-m", "Topic");
    const topic = command(test.sourceRoot, "rev-parse", "HEAD");
    command(test.sourceRoot, "checkout", "main");
    command(test.sourceRoot, "merge", "--no-ff", "topic", "-m", "Merge");
    const commit = command(test.sourceRoot, "rev-parse", "HEAD");
    test.copy();
    const before = readFileSync(join(test.workRoot, "src", "app.txt"));
    const manifest = snapshotSourceIdentity(test, {
      expectedCommit: commit,
      approvedPaths: [...test.approvedPaths, "topic.txt"],
    });
    expect(manifest.objects.filter((object) => object.type === "commit")).toEqual([
      { oid: commit, type: "commit" },
    ]);
    expect(readdirSync(test.artifactDir).sort()).toEqual(["identity.json", "objects.pack"]);
    expect(test.restore(manifest)).toEqual({
      commit,
      tree: manifest.tree,
      dirty: false,
      status: "",
    });
    expect(command(test.workRoot, "rev-parse", "HEAD")).toBe(commit);
    expect(command(test.workRoot, "rev-list", "--count", "HEAD")).toBe("1");
    expect(command(test.workRoot, "write-tree")).toBe(manifest.tree);
    expect(() => command(test.workRoot, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(() => command(test.workRoot, "cat-file", "-e", original)).toThrow();
    expect(() => command(test.workRoot, "cat-file", "-e", topic)).toThrow();
    expect(readFileSync(join(test.workRoot, "src", "app.txt"))).toEqual(before);
    expect(command(test.sourceRoot, "status", "--porcelain")).toBe("");
  });

  it("reads a linked worktree identity without copying its metadata pointers", () => {
    const test = setup();
    const linked = join(test.root, "linked");
    command(test.sourceRoot, "worktree", "add", linked, "-b", "linked");
    const pointer = readFileSync(join(linked, ".git"));
    const manifest = snapshotSourceIdentity(
      { sourceRoot: linked, artifactDir: test.artifactDir },
      { expectedCommit: test.expectedCommit, approvedPaths: test.approvedPaths },
    );
    test.copy();
    expect(test.restore(manifest).dirty).toBe(false);
    expect(readFileSync(join(linked, ".git"))).toEqual(pointer);
    expect(lstatSync(join(test.workRoot, ".git")).isDirectory()).toBe(true);
  });

  it("preserves staged modifications, deletion and untracked source as genuinely dirty", () => {
    const test = setup();
    writeFileSync(join(test.sourceRoot, "src", "app.txt"), "modified\n");
    command(test.sourceRoot, "add", "src/app.txt");
    unlinkSync(join(test.sourceRoot, "remove.txt"));
    writeFileSync(join(test.sourceRoot, "extra.txt"), "untracked\n");
    mkdirSync(join(test.sourceRoot, "ignored-output"));
    writeFileSync(join(test.sourceRoot, "ignored-output", "cache.txt"), "cache\n");
    test.copy();
    const result = test.restore();
    expect(result.dirty).toBe(true);
    expect(result.status).toContain(" M src/app.txt");
    expect(result.status).toContain(" D remove.txt");
    expect(result.status).toContain("?? extra.txt");
    expect(result.status).not.toContain("cache.txt");
    expect(readFileSync(join(test.workRoot, "src", "app.txt"), "utf8")).toBe("modified\n");
    expect(existsSync(join(test.workRoot, "remove.txt"))).toBe(false);
    expect(command(test.sourceRoot, "diff", "--cached", "--name-only")).toBe("src/app.txt");
  });

  it("requires exact full HEAD and complete unique approved inventory", () => {
    const test = setup();
    expect(() =>
      snapshotSourceIdentity(test, {
        expectedCommit: test.expectedCommit.slice(0, 8),
        approvedPaths: test.approvedPaths,
      }),
    ).toThrow(SourceIdentityError);
    expect(() =>
      snapshotSourceIdentity(test, {
        expectedCommit: "0".repeat(40),
        approvedPaths: test.approvedPaths,
      }),
    ).toThrow("HEAD mismatch");
    expect(() =>
      snapshotSourceIdentity(test, {
        expectedCommit: test.expectedCommit,
        approvedPaths: test.approvedPaths.slice(1),
      }),
    ).toThrow("exactly cover");
    expect(() =>
      snapshotSourceIdentity(test, {
        expectedCommit: test.expectedCommit,
        approvedPaths: [...test.approvedPaths, test.approvedPaths[0]!],
      }),
    ).toThrow("exactly cover");
    expect(existsSync(test.artifactDir)).toBe(false);
    expect(interception.blobs).toBe(0);
    expect(interception.packs).toBe(0);
  });

  it.each([".env.fixture", "nested/AGENTS.md"])(
    "rejects forbidden tracked path %s before packing or blob access",
    (path) => {
      const test = setup();
      mkdirSync(join(test.sourceRoot, "nested"));
      writeFileSync(join(test.sourceRoot, path), "ordinary synthetic fixture\n");
      command(test.sourceRoot, "add", "-f", path);
      command(test.sourceRoot, "commit", "-m", "Unsafe path fixture");
      expect(() =>
        snapshotSourceIdentity(test, {
          expectedCommit: command(test.sourceRoot, "rev-parse", "HEAD"),
          approvedPaths: [...test.approvedPaths, path],
        }),
      ).toThrow("forbidden tracked path");
      expect(interception.blobs).toBe(0);
      expect(interception.packs).toBe(0);
      expect(existsSync(test.artifactDir)).toBe(false);
    },
  );

  it("rejects gitlinks without traversing a submodule or reading blobs", () => {
    const test = setup();
    command(
      test.sourceRoot,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${test.expectedCommit},submodule`,
    );
    command(test.sourceRoot, "commit", "-m", "Gitlink fixture");
    expect(() =>
      snapshotSourceIdentity(test, {
        expectedCommit: command(test.sourceRoot, "rev-parse", "HEAD"),
        approvedPaths: [...test.approvedPaths, "submodule"],
      }),
    ).toThrow("gitlink");
    expect(interception.blobs).toBe(0);
    expect(interception.packs).toBe(0);
  });

  it("rejects tracked symbolic links before reading their blobs", () => {
    const test = setup();
    symlinkSync("src/app.txt", join(test.sourceRoot, "link"));
    command(test.sourceRoot, "add", "link");
    command(test.sourceRoot, "commit", "-m", "Link fixture");
    expect(() =>
      snapshotSourceIdentity(test, {
        expectedCommit: command(test.sourceRoot, "rev-parse", "HEAD"),
        approvedPaths: [...test.approvedPaths, "link"],
      }),
    ).toThrow("symbolic links unsupported");
    expect(interception.blobs).toBe(0);
    expect(interception.packs).toBe(0);
  });

  it("refuses chained working path escapes and leaves dangling existing Git metadata untouched", () => {
    const test = setup();
    const manifest = test.snapshot();
    test.copy();
    rmSync(join(test.workRoot, "src"), { recursive: true });
    symlinkSync("outside", join(test.workRoot, "src"));
    symlinkSync(test.sourceRoot, join(test.workRoot, "outside"));
    expect(() => test.restore(manifest)).toThrow("symbolic working paths");
    expect(existsSync(join(test.workRoot, ".git"))).toBe(false);
    symlinkSync("not-present", join(test.workRoot, ".git"));
    expect(() => test.restore(manifest)).toThrow("already has Git metadata");
    expect(lstatSync(join(test.workRoot, ".git")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(test.workRoot, ".git"))).toBe("not-present");
  });

  it("ignores inherited config and source config, hooks, filters and replacement refs", () => {
    const test = setup();
    const marker = join(test.root, "executed");
    const hook = join(test.root, "hook");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    command(test.sourceRoot, "config", "core.fsmonitor", hook);
    command(test.sourceRoot, "config", "filter.unconfigured.clean", hook);
    command(test.sourceRoot, "config", "core.hooksPath", test.root);
    const other = command(test.sourceRoot, "hash-object", "-w", "--stdin");
    mkdirSync(join(test.sourceRoot, ".git", "refs", "replace"));
    writeFileSync(
      join(test.sourceRoot, ".git", "refs", "replace", test.expectedCommit),
      `${other}\n`,
    );
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", hook);
    vi.stubEnv("GIT_DIR", "/unsupported/inherited");
    vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", "/unsupported/objects");
    test.copy();
    const result = test.restore();
    expect(result.commit).toBe(test.expectedCommit);
    expect(result.dirty).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const config = readFileSync(join(test.workRoot, ".git", "config"), "utf8");
    expect(config).not.toContain("filter");
    expect(config).not.toContain("fsmonitor");
    expect(config).not.toContain("remote");
  });

  it("refuses source alternates without reading their target", () => {
    const test = setup();
    writeFileSync(
      join(test.sourceRoot, ".git", "objects", "info", "alternates"),
      "/unreadable/objects\n",
    );
    expect(() => test.snapshot()).toThrow("alternates unsupported");
    expect(existsSync(test.artifactDir)).toBe(false);
  });

  it("invalidates a snapshot when source files change while the pack is produced", () => {
    const test = setup();
    interception.beforePack = () =>
      writeFileSync(join(test.sourceRoot, "src", "app.txt"), "concurrent edit\n");
    expect(() => test.snapshot()).toThrow("source changed");
    expect(existsSync(test.artifactDir)).toBe(false);
  });

  it("invalidates a snapshot when staged state changes without changing working bytes", () => {
    const test = setup();
    interception.beforePack = () =>
      command(test.sourceRoot, "update-index", "--chmod=+x", "remove.txt");
    expect(() => test.snapshot()).toThrow("source changed");
    expect(existsSync(test.artifactDir)).toBe(false);
  });

  it("invalidates a snapshot if actual HEAD changes during packing", () => {
    const test = setup();
    interception.beforePack = () =>
      writeFileSync(join(test.sourceRoot, ".git", "HEAD"), `${"0".repeat(40)}\n`);
    expect(() => test.snapshot()).toThrow("source changed");
    expect(existsSync(test.artifactDir)).toBe(false);
  });

  it("rejects wrong expected identity or corrupted pack before installing metadata", () => {
    const test = setup();
    const manifest = test.snapshot();
    test.copy();
    expect(() =>
      restoreSourceIdentity(test, {
        expectedCommit: "0".repeat(40),
        expectedTree: manifest.tree,
        expectedDigest: manifest.digest,
      }),
    ).toThrow("manifest identity mismatch");
    const path = join(test.artifactDir, "objects.pack");
    const bytes = readFileSync(path);
    bytes[12] = bytes[12]! ^ 1;
    writeFileSync(path, bytes);
    expect(() => test.restore(manifest)).toThrow("pack digest mismatch");
    expect(existsSync(join(test.workRoot, ".git"))).toBe(false);
  });

  it("rejects a self-consistent manifest with a false object inventory", () => {
    const test = setup();
    const manifest = test.snapshot();
    test.copy();
    const { digest, ...unsigned } = manifest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const changed = { ...unsigned, objects: manifest.objects.slice(1) };
    const forged = {
      ...changed,
      digest: createHash("sha256").update(JSON.stringify(changed)).digest("hex"),
    };
    writeFileSync(join(test.artifactDir, "identity.json"), JSON.stringify(forged));
    expect(() => test.restore(forged)).toThrow("object inventory mismatch");
    expect(existsSync(join(test.workRoot, ".git"))).toBe(false);
  });
});
