// The host-side guards of check.ts, contract.ts and pack.ts, exercised without docker.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkImage,
  discardReason,
  foreignOwner,
  groupAdds,
  GuardError,
  hostOwners,
  requireLoad,
  snapshot,
  sourceFingerprint,
  sourceList,
  validPackArgs,
} from "./guards.ts";

const scripts = dirname(fileURLToPath(import.meta.url));
const own = { gids: [process.getgid?.() ?? -1], uids: [process.getuid?.() ?? -1] };
// The suite itself runs as uid 19001 in the check container, so "no foreign owner" uses an
// identity nothing here can have.
const none = { gids: [2147483646], uids: [2147483646] };
let root: string;

function git(...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guards-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("requireLoad", () => {
  it("accepts a load below 24 and refuses 24, above it and unreadable values", () => {
    expect(() => requireLoad("23.99 4.00 3.00 1/100 1\n")).not.toThrow();
    for (const loadavg of ["24.00 1 1 1/1 1\n", "31.5 1 1 1/1 1\n", "garbage\n"]) {
      expect(() => requireLoad(loadavg)).toThrow(GuardError);
    }
  });
});

describe("checkImage", () => {
  it("names the Node image pinned in .nvmrc", () => {
    writeFileSync(join(root, ".nvmrc"), "v24.21.0\n");
    expect(checkImage(root)).toBe("node:24.21.0");
  });
});

describe("snapshot fingerprints", () => {
  beforeEach(() => {
    writeFileSync(join(root, "SOURCE_COMMIT"), `${"a".repeat(40)}\n`);
    writeFileSync(join(root, "file.txt"), "one\n");
  });

  it("changes with content, mode and symlink targets, and is stable otherwise", () => {
    const first = sourceFingerprint(root);
    expect(sourceFingerprint(root)).toBe(first);
    writeFileSync(join(root, "file.txt"), "two\n");
    const content = sourceFingerprint(root);
    expect(content).not.toBe(first);
    chmodSync(join(root, "file.txt"), 0o600);
    const mode = sourceFingerprint(root);
    expect(mode).not.toBe(content);
    symlinkSync("file.txt", join(root, "link"));
    const linked = sourceFingerprint(root);
    expect(linked).not.toBe(mode);
    unlinkSync(join(root, "link"));
    symlinkSync("other", join(root, "link"));
    expect(sourceFingerprint(root)).not.toBe(linked);
  });

  it("refuses credential-shaped paths before reading content", () => {
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id"), "x");
    expect(() => sourceFingerprint(root)).toThrow(/credential-shaped/);
  });

  it("requires a checkout or an identified snapshot", () => {
    unlinkSync(join(root, "SOURCE_COMMIT"));
    expect(() => sourceFingerprint(root)).toThrow(/checkout or identified source snapshot/);
  });

  it("lists snapshot files outside .claude, node_modules and dist", () => {
    for (const directory of [".claude", "node_modules", "dist", "src"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "x.ts"), "");
    }
    expect(sourceList(root).sort()).toEqual(["SOURCE_COMMIT", "file.txt", "src/x.ts"]);
  });
});

describe("Git fingerprints and source lists", () => {
  beforeEach(() => {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    writeFileSync(join(root, "tracked.txt"), "one\n");
    writeFileSync(join(root, "gone.txt"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
  });

  it("detects untracked files and status changes", () => {
    const first = sourceFingerprint(root);
    writeFileSync(join(root, "new.txt"), "n\n");
    expect(sourceFingerprint(root)).not.toBe(first);
  });

  it("lists tracked and untracked files, not ignored or deleted ones", () => {
    mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored", "cache"), "");
    writeFileSync(join(root, "untracked.txt"), "");
    unlinkSync(join(root, "gone.txt"));
    expect(sourceList(root).sort()).toEqual([".gitignore", "tracked.txt", "untracked.txt"]);
  });
});

describe("ownership guards", () => {
  beforeEach(() => {
    writeFileSync(join(root, "SOURCE_COMMIT"), "x\n");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref\n");
  });

  it("hostOwners changes with a mode change and ignores .git", () => {
    // A .git directory without a repository is only an ignored path for hostOwners.
    const first = hostOwners(root);
    chmodSync(join(root, ".git", "HEAD"), 0o600);
    expect(hostOwners(root)).toBe(first);
    chmodSync(join(root, "SOURCE_COMMIT"), 0o600);
    expect(hostOwners(root)).not.toBe(first);
  });

  it("foreignOwner finds an entry owned by a listed identity, .git included", () => {
    expect(foreignOwner(root, none)).toBeUndefined();
    expect(foreignOwner(root, own)).toBe(root);
    expect(foreignOwner(root, { gids: [], uids: [statSync(root).uid] })).toBe(root);
  });

  it("groupAdds adds each distinct group once", () => {
    const gid = String(statSync(root).gid);
    expect(groupAdds([root, join(root, "SOURCE_COMMIT")])).toEqual(["--group-add", gid]);
  });
});

describe("discardReason", () => {
  beforeEach(() => {
    writeFileSync(join(root, "SOURCE_COMMIT"), "x\n");
    writeFileSync(join(root, "file.txt"), "one\n");
  });

  it("keeps an unchanged result and discards changed content, modes or foreign owners", () => {
    const before = snapshot(root);
    expect(discardReason(root, before, none)).toBeUndefined();
    expect(discardReason(root, before, own)).toMatch(/owned by a container identity/);
    chmodSync(join(root, "file.txt"), 0o600);
    expect(discardReason(root, before, none)).toMatch(/changed during checks/);
    const changed = snapshot(root);
    writeFileSync(join(root, "file.txt"), "two\n");
    expect(discardReason(root, changed, none)).toMatch(/changed during checks/);
  });

  it("discards when the fingerprint cannot be taken", () => {
    const before = snapshot(root);
    unlinkSync(join(root, "SOURCE_COMMIT"));
    expect(discardReason(root, before, none)).toMatch(/cannot verify source fingerprints/);
  });
});

describe("validPackArgs", () => {
  it("requires an exact SHA and a new absolute directory", () => {
    const sha = "0".repeat(40);
    expect(validPackArgs([sha, join(root, "out")])).toBe(true);
    expect(validPackArgs([sha, root])).toBe(false);
    expect(validPackArgs([sha, "relative/out"])).toBe(false);
    expect(validPackArgs(["0".repeat(39), join(root, "out")])).toBe(false);
    expect(validPackArgs([sha])).toBe(false);
    expect(validPackArgs([sha, join(root, "out"), "extra"])).toBe(false);
  });
});

describe("shell policy", () => {
  const wrappers = {
    "scripts/check.sh": "check.ts",
    "scripts/pack.sh": "pack.ts",
    "tests/contract/run.sh": "../../scripts/contract.ts",
  };
  const repo = resolve(scripts, "..");

  it.each(Object.entries(wrappers))("%s only execs its Node script", (path, target) => {
    const body = readFileSync(join(repo, path), "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(body).toEqual([
      "set -euo pipefail",
      `exec node "$(dirname -- "\${BASH_SOURCE[0]}")/${target}" "$@"`,
    ]);
  });

  it("has no other shell or Python file in scripts/ or tests/contract/", () => {
    const found = [
      ...readdirSync(join(repo, "scripts")).map((name) => `scripts/${name}`),
      ...readdirSync(join(repo, "tests/contract")).map((name) => `tests/contract/${name}`),
    ].filter((path) => /\.(sh|py)$/.test(path));
    expect(found.sort()).toEqual(Object.keys(wrappers).sort());
  });
});
