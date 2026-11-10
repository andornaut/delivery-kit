// Static checks on the bundles built before the unit suite, and the packed file list.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = ["dist/cli.js", "dist/registry.js"];
const METADATA = ["LICENSE", "README.md", "SOURCE_COMMIT", "package.json"];

beforeAll(() => {
  for (const bundle of BUNDLES) {
    if (!existsSync(join(root, bundle))) {
      throw new Error(`${bundle} is missing; run npm run build before running units`);
    }
  }
});

function staticSpecifiers(source: string): string[] {
  const pattern =
    /^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? "");
}

describe("every bundle", () => {
  const source = (bundle: string): string => readFileSync(join(root, bundle), "utf8");

  it("has no dynamic import, relative require or source map", () => {
    for (const bundle of BUNDLES) {
      expect(source(bundle), bundle).not.toMatch(/\bimport\s*\(/);
      expect(source(bundle), bundle).not.toMatch(/\brequire\s*\(\s*["'`]\.{1,2}\//);
      expect(source(bundle), bundle).not.toMatch(/sourceMappingURL/);
    }
  });

  it("imports only node: builtins", () => {
    for (const bundle of BUNDLES) {
      const specifiers = staticSpecifiers(source(bundle));
      expect(specifiers.length, bundle).toBeGreaterThan(0);
      expect(
        specifiers.filter((specifier) => !specifier.startsWith("node:")),
        bundle,
      ).toEqual([]);
    }
  });
});

describe("dist/cli.js", () => {
  it("is an executable Node script that reports the package version", () => {
    const cli = join(root, "dist/cli.js");
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(execFileSync(cli, ["--version"], { encoding: "utf8" })).toBe(`${version}\n`);
    const run = spawnSync(cli, ["run"], { encoding: "utf8" });
    expect([run.status, run.stderr]).toEqual([2, "usage: delivery-kit run --game ID\n"]);
  });
});

describe("dist/registry.js", () => {
  it("exports the public registry API with declarations a NodeNext consumer can type-check", async () => {
    const registry = (await import(join(root, "dist/registry.js"))) as Record<string, unknown>;
    for (const name of [
      "RegistrySchema",
      "readRegistry",
      "updateRegistry",
      "resolveConversation",
      "loadLayout",
    ]) {
      expect(registry[name], name).toBeDefined();
    }
    const consumer = join(mkdtempSync(join(tmpdir(), "registry-consumer-")), "consumer.mts");
    const target = JSON.stringify(join(root, "dist/registry.js"));
    writeFileSync(
      consumer,
      `import { readRegistry, type Registry, RevisionConflict, updateRegistry } from ${target};
const check: (registry: Registry) => number = (registry) => registry.revision;
// @ts-expect-error A resolved Registry type rejects this; an unresolved one would be any.
const wrong: (registry: Registry) => string = (registry) => registry.revision;
export { check, wrong, readRegistry, RevisionConflict, updateRegistry };
`,
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2024",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        join(root, "node_modules/@types"),
        consumer,
      ],
      { cwd: dirname(consumer), stdio: "inherit" },
    );
  });
});

describe("packed package", () => {
  it("contains exactly the bundles, their declarations and metadata", () => {
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--offline", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as [{ files: { path: string }[] }];
    const files = pack.files.map((file) => file.path).sort();
    const dist = files.filter((path) => path.startsWith("dist/"));
    expect(files.filter((path) => !path.startsWith("dist/") && !METADATA.includes(path))).toEqual(
      [],
    );
    expect(dist.filter((path) => !path.startsWith("dist/types/"))).toEqual([
      "dist/cli.js",
      "dist/registry.d.ts",
      "dist/registry.js",
    ]);
    expect(
      dist.filter((path) => path.startsWith("dist/types/") && !path.endsWith(".d.ts")),
    ).toEqual([]);
    expect(readdirSync(join(root, "dist")).sort()).toEqual([
      "cli.js",
      "registry.d.ts",
      "registry.js",
      "types",
    ]);
  });
});
