// Static checks on the bundles built before the unit suite, and the packed file list.
import { execFileSync, spawnSync } from "node:child_process";
import {
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

import { beforeAll, describe, expect, it } from "vitest";

import { COORDINATION_KIT_RANGE } from "../src/bus/pin.ts";
import { bundledCoordinationKit, packagedDocs } from "./package-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = ["dist/cli.js", "dist/source-identity.js"];
const METADATA = ["LICENSE", "README.md", "SOURCE_COMMIT", "package.json", ...packagedDocs(root)];

beforeAll(() => {
  for (const bundle of BUNDLES) {
    if (!existsSync(join(root, bundle))) {
      throw new Error(`${bundle} is missing; run npm run build before running units`);
    }
  }
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

describe("bundles", () => {
  it("inline coordination-kit and import only node: builtins", () => {
    for (const bundle of BUNDLES) {
      const text = readFileSync(join(root, bundle), "utf8");
      const specifiers = [
        ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gmu),
        ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
        ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu),
      ].map((match) => match[1] ?? "");
      expect(specifiers.length, bundle).toBeGreaterThan(0);
      expect(
        specifiers.filter((specifier) => !specifier.startsWith("node:")),
        bundle,
      ).toEqual([]);
    }
  });
});

describe("bundled coordination-kit", () => {
  it("is inside the supported range, and the package check refuses one outside it", () => {
    expect(bundledCoordinationKit(root)).toMatch(/^1\.\d+\.\d+$/u);
    expect(COORDINATION_KIT_RANGE).toBe(">=1.0.0 <2.0.0");
    for (const [version, accepted] of [
      ["1.0.0", true],
      ["1.9.3", true],
      ["0.9.0", false],
      ["2.0.0", false],
      ["1.1.0-rc.1", false],
    ] as const) {
      const fixture = mkdtempSync(join(tmpdir(), "bundled-coordination-kit-"));
      const installed = join(fixture, "node_modules", "@andornaut", "coordination-kit");
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, "package.json"), JSON.stringify({ version }));
      if (accepted) {
        expect(bundledCoordinationKit(fixture)).toBe(version);
      } else {
        expect(() => bundledCoordinationKit(fixture)).toThrow(
          `bundled @andornaut/coordination-kit ${version} is outside the supported range`,
        );
      }
    }
  });
});

describe("dist/source-identity.js", () => {
  it("exports its public API with declarations a NodeNext consumer can type-check", async () => {
    const api = (await import(join(root, "dist/source-identity.js"))) as Record<string, unknown>;
    for (const name of ["snapshotSourceIdentity", "restoreSourceIdentity", "SourceIdentityError"]) {
      expect(typeof api[name], name).toBe("function");
    }
    const consumer = join(mkdtempSync(join(tmpdir(), "source-identity-consumer-")), "consumer.mts");
    writeFileSync(
      consumer,
      `import {
  snapshotSourceIdentity, type SourceIdentityManifest,
} from ${JSON.stringify(join(root, "dist/source-identity.js"))};
const commit = (manifest: SourceIdentityManifest): string => manifest.commit;
// @ts-expect-error A resolved manifest type rejects this; an unresolved one would be any.
const wrong = (manifest: SourceIdentityManifest): number => manifest.commit;
export { commit, snapshotSourceIdentity, wrong };
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
    expect(METADATA.filter((path) => path.startsWith("docs/") && !files.includes(path))).toEqual(
      [],
    );
    expect(files.filter((path) => path.startsWith("docs/work/"))).toEqual([]);
    expect(dist.filter((path) => !path.startsWith("dist/types/"))).toEqual([
      "dist/cli.js",
      "dist/source-identity.d.ts",
      "dist/source-identity.js",
    ]);
    expect(
      dist.filter((path) => path.startsWith("dist/types/") && !path.endsWith(".d.ts")),
    ).toEqual([]);
    expect(readdirSync(join(root, "dist")).sort()).toEqual([
      "cli.js",
      "source-identity.d.ts",
      "source-identity.js",
      "types",
    ]);
  });
});
