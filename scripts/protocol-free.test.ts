// delivery-kit reads no work protocol state: coordination-kit 3.0 removes build/protocol, so no
// source, test or tooling file imports it, and the lint configuration refuses one that would.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = "@andornaut/coordination-kit/build/protocol";
const SKIP = new Set(["node_modules", "dist", ".git", ".worktrees", ".claude"]);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return /\.(?:c|m)?[jt]s$/u.test(entry.name) ? [path] : [];
  });
}

describe("work protocol independence", () => {
  it("no source, test or tooling file imports coordination-kit build/protocol", () => {
    const importer = new RegExp(`["']${PROTOCOL}(?:/[^"']*)?["']`, "u");
    const offenders = sources(root)
      .filter((path) => path !== fileURLToPath(import.meta.url))
      .filter((path) => importer.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });

  it("the lint configuration refuses a build/protocol import anywhere", async () => {
    const eslint = new ESLint({ cwd: root });
    for (const filePath of [
      "src/runner/example.ts",
      "src/runner/example.test.ts",
      "scripts/example.ts",
      "tests/contract/cases/example.test.ts",
    ]) {
      for (const specifier of [PROTOCOL, `${PROTOCOL}/store`]) {
        // eslint-disable-next-line no-await-in-loop
        const [result] = await eslint.lintText(
          `import { ProtocolStore } from "${specifier}";\nexport const store = ProtocolStore;\n`,
          { filePath: join(root, filePath) },
        );
        const rules = (result?.messages ?? []).map((message) => message.ruleId);
        expect(rules, `${filePath}: ${specifier}`).toContain("no-restricted-imports");
      }
    }
  }, 60_000);
});
