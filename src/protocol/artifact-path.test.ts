import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactPathError,
  assertArtifactOutputPath,
  readPromotableArtifact,
  unsafeArtifactPathComponent,
} from "./artifact-path.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const fixtures: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "artifact-path-synthetic-"));
  fixtures.push(root);
  return root;
}
afterEach(() => {
  vi.clearAllMocks();
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("public artifact path policy with synthetic files only", () => {
  it("shares the finite credential component class without broad token or private-name matching", () => {
    for (const name of [
      ".git",
      ".private",
      ".ssh",
      ".env",
      ".env.local",
      "auth.json",
      ".auth.json",
      "credentials",
      ".credentials.backup",
      "id_rsa",
      "id_ed25519.pub",
      "fixture.pem",
      "fixture.key",
      "fixture.p12",
      ".vitest-secret-token",
    ]) {
      expect(unsafeArtifactPathComponent(name), name).toBe(true);
    }
    for (const name of [
      ".gitignore",
      ".environment",
      "private-notes.txt",
      "token-count.json",
      "author.json",
    ]) {
      expect(unsafeArtifactPathComponent(name), name).toBe(false);
    }
  });

  it("reads ordinary public aliases and exact opaque bytes without content heuristics", () => {
    const root = fixture();
    fs.mkdirSync(join(root, "public"));
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0, 0x0a]);
    fs.writeFileSync(join(root, "public", "artifact.bin"), bytes);
    fs.symlinkSync("public", join(root, "directory-alias"));
    fs.symlinkSync("directory-alias/artifact.bin", join(root, "file-alias"));
    fs.mkdirSync(join(root, "public", "nested"));
    fs.symlinkSync("public/nested", join(root, "nested-alias"));
    expect(readPromotableArtifact(join(root, "file-alias"))).toEqual(bytes);
    expect(readPromotableArtifact(join(root, "directory-alias", "artifact.bin"))).toEqual(bytes);
    expect(readPromotableArtifact(`${root}/nested-alias/../artifact.bin`)).toEqual(bytes);
  });

  it("refuses protected supplied components and every alias target before opening any artifact", () => {
    const root = fixture();
    fs.mkdirSync(join(root, ".private"));
    fs.writeFileSync(join(root, ".private", "synthetic.json"), "synthetic fixture only");
    fs.writeFileSync(join(root, "public.txt"), "public fixture");
    fs.symlinkSync("public.txt", join(root, "auth.json"));
    fs.symlinkSync(".private/synthetic.json", join(root, "public-alias"));
    fs.symlinkSync("../public.txt", join(root, ".private", "escape"));
    fs.symlinkSync(".private/escape", join(root, "chained-alias"));
    const open = vi.mocked(fs.openSync).mockClear();
    const read = vi.mocked(fs.readFileSync).mockClear();
    for (const file of [
      ".private/synthetic.json",
      "auth.json",
      "public-alias",
      "chained-alias",
      ".env/../public.txt",
    ]) {
      expect(() => readPromotableArtifact(`${root}/${file}`)).toThrow("unsafe-artifact-path");
    }
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("guards output ancestors and aliases without creating directories, reading or overwriting files", () => {
    const root = fixture();
    fs.mkdirSync(join(root, "public"));
    fs.mkdirSync(join(root, ".ssh"));
    fs.symlinkSync("public", join(root, "public-alias"));
    fs.symlinkSync(".ssh", join(root, "protected-alias"));
    fs.writeFileSync(join(root, "public", "existing.bin"), "unchanged fixture");
    const read = vi.mocked(fs.readFileSync).mockClear();
    expect(assertArtifactOutputPath(join(root, "public-alias", "new.bin"))).toBe(
      join(root, "public", "new.bin"),
    );
    for (const file of [
      ".ssh/new.bin",
      "protected-alias/new.bin",
      "public/auth.json",
      "public/.vitest-secret-token",
    ]) {
      expect(() => assertArtifactOutputPath(join(root, file))).toThrow("unsafe-artifact-path");
    }
    expect(() => assertArtifactOutputPath(join(root, "missing", "new.bin"))).toThrow(
      "artifact-path-unavailable",
    );
    expect(fs.existsSync(join(root, "missing"))).toBe(false);
    expect(fs.existsSync(join(root, "public", "new.bin"))).toBe(false);
    expect(() =>
      fs.writeFileSync(
        assertArtifactOutputPath(join(root, "public-alias", "existing.bin")),
        "replacement",
        { flag: "wx" },
      ),
    ).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(fs.readFileSync(join(root, "public", "existing.bin"), "utf8")).toBe("unchanged fixture");
  });

  it("normalizes malformed, unavailable and non-file errors without exposing path or raw context", () => {
    const root = fixture();
    for (const path of ["", "bad\0path"]) {
      expect(() => readPromotableArtifact(path)).toThrow("invalid-artifact-path");
    }
    for (const action of [
      () => readPromotableArtifact(root),
      () => assertArtifactOutputPath(root),
    ]) {
      expect(action).toThrow("artifact-not-file");
    }
    fs.symlinkSync("loop", join(root, "loop"));
    for (const file of ["absent", "loop"]) {
      try {
        readPromotableArtifact(join(root, file));
        expect.fail("unavailable fixture must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactPathError);
        expect((error as ArtifactPathError).code).toBe("artifact-path-unavailable");
        expect((error as Error).message).toBe("artifact-path-unavailable");
        expect((error as Error).message).not.toContain(root);
      }
    }
  });
});
