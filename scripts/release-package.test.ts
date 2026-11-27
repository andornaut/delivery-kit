import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { packagedDocs } from "./package-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "scripts/release-package.mjs");
const fixtureCommit = `${"1".repeat(40)}\n`;

function fixture(omitGuide?: string) {
  const base = mkdtempSync(join(tmpdir(), "release-package-"));
  const source = join(base, "source");
  const output = join(base, "output");
  const staging = join(base, "staging");
  mkdirSync(source);
  mkdirSync(output);
  for (const path of ["VERSION", "package.json", "README.md", "LICENSE", "dist"]) {
    cpSync(join(root, path), join(source, path), { recursive: true });
  }
  writeFileSync(join(source, "SOURCE_COMMIT"), fixtureCommit);
  const omitted = omitGuide === undefined ? undefined : join(root, omitGuide);
  cpSync(join(root, "docs"), join(source, "docs"), {
    recursive: true,
    filter: (path) => path !== omitted,
  });
  return {
    base,
    output,
    source,
    staging,
    version: readFileSync(join(source, "VERSION"), "utf8").trim(),
  };
}

describe("actual release package", () => {
  it("ships the README-linked guides and public API from the real staging and npm pack helper", () => {
    const test = fixture();
    execFileSync(process.execPath, [helper, test.staging, test.output], {
      cwd: test.source,
      stdio: "pipe",
    });
    const archive = join(test.output, `delivery-kit-${test.version}.tgz`);
    const extracted = join(test.base, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const pkg = join(extracted, "package");
    const readme = readFileSync(join(pkg, "README.md"), "utf8");
    expect(readme).toMatch(/\]\((?:\.\/)?docs\/README\.md\)/u);
    expect(readme).toMatch(/\]\((?:\.\/)?docs\/reference\/runner\.md(?:#[^)]*)?\)/u);
    expect(readme).toMatch(/\]\((?:\.\/)?docs\/guides\/upgrading\.md(?:#[^)]*)?\)/u);
    for (const doc of packagedDocs(root)) {
      expect(readFileSync(join(pkg, doc))).toEqual(readFileSync(join(root, doc)));
    }
    expect(existsSync(join(pkg, "docs", "work"))).toBe(false);
    expect(readFileSync(join(pkg, "SOURCE_COMMIT"), "utf8")).toBe(fixtureCommit);
    execFileSync("sha256sum", ["--check", "SHA256SUMS"], { cwd: test.output, stdio: "pipe" });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const canonical = await import('@andornaut/delivery-kit/build/source-identity');
      const alias = await import('@andornaut/delivery-kit/source-identity');
      if (canonical !== alias || !['snapshotSourceIdentity', 'restoreSourceIdentity']
        .every(name => typeof canonical[name] === 'function')) process.exit(1);
      const manifest = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8'));
      if ('devDependencies' in manifest || 'dependencies' in manifest) process.exit(1);
    `,
      ],
      { cwd: pkg, stdio: "pipe" },
    );
  });

  it("refuses a missing required guide before emitting any release artifact", () => {
    const test = fixture("docs/reference/commands.md");
    const result = spawnSync(process.execPath, [helper, test.staging, test.output], {
      cwd: test.source,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("docs/reference/commands.md");
    expect(existsSync(join(test.output, `delivery-kit-${test.version}.tgz`))).toBe(false);
    expect(readdirSync(test.output)).toEqual([]);
  });
});
