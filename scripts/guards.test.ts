// The host-side guards of check.ts, contract.ts and pack.ts, exercised without docker.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discardReason,
  GuardError,
  requireLoad,
  snapshot,
  sourceFingerprint,
  validPackArgs,
} from "./guards.ts";

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
