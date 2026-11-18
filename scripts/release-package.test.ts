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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "scripts/release-package.mjs");
const fixtureCommit = `${"1".repeat(40)}\n`;

function fixture(includeGuide: boolean) {
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
  if (includeGuide) {
    mkdirSync(join(source, "docs"));
    for (const guide of readdirSync(join(root, "docs"))) {
      cpSync(join(root, "docs", guide), join(source, "docs", guide));
    }
  }
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
    const test = fixture(true);
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
    expect(readme).toMatch(/\]\((?:\.\/)?docs\/request-accounting\.md(?:#[^)]*)?\)/u);
    for (const doc of readdirSync(join(root, "docs"))) {
      expect(readFileSync(join(pkg, "docs", doc))).toEqual(readFileSync(join(root, "docs", doc)));
    }
    expect(readFileSync(join(pkg, "SOURCE_COMMIT"), "utf8")).toBe(fixtureCommit);
    execFileSync("sha256sum", ["--check", "SHA256SUMS"], { cwd: test.output, stdio: "pipe" });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const canonical = await import('@andornaut/delivery-kit/build/accounting');
      const alias = await import('@andornaut/delivery-kit/accounting');
      const protocol = await import('@andornaut/delivery-kit/build/protocol');
      const protocolAlias = await import('@andornaut/delivery-kit/protocol');
      const required = ['ProtocolStore', 'WorkStore', 'ProtocolMessages', 'resolveProtocolLayout'];
      if (protocol !== protocolAlias || !required.every(name => typeof protocol[name] === 'function')) process.exit(1);
      if (canonical !== alias || !['LedgerStore', 'IntakeStore', 'projectOwnerBinding']
        .every(name => typeof canonical[name] === 'function')) process.exit(1);
    `,
      ],
      { cwd: pkg, stdio: "pipe" },
    );
  });

  it("refuses a missing required guide before emitting any release artifact", () => {
    const test = fixture(false);
    const result = spawnSync(process.execPath, [helper, test.staging, test.output], {
      cwd: test.source,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("docs/commands.md");
    expect(existsSync(join(test.output, `delivery-kit-${test.version}.tgz`))).toBe(false);
    expect(readdirSync(test.output)).toEqual([]);
  });
});
