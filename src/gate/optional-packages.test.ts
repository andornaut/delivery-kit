import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  effectiveOmit,
  expectedOptionalPackages,
  hasOptionalPackages,
  installCommandOmit,
  type InstallPlatform,
  NO_NODE,
  parseInstallPlatform,
  parseOmitList,
  platformScript,
  presenceScript,
  skippedOptionalReason,
} from "./optional-packages.ts";

const GLIBC: InstallPlatform = {
  cpu: "x64",
  libc: "glibc",
  node: "24.11.1",
  npm: "11.6.2",
  omit: [],
  os: "linux",
};
const MUSL: InstallPlatform = { ...GLIBC, libc: "musl" };

/** A lockfileVersion 3 lock whose root depends on `dependencies`. */
function lock(
  dependencies: Record<string, string>,
  packages: Record<string, Record<string, unknown>>,
): unknown {
  return {
    lockfileVersion: 3,
    name: "game",
    packages: { "": { dependencies, name: "game" }, ...packages },
  };
}

/** skia-canvas with one native package per platform, the way its lock entries look. */
const SKIA = lock(
  { "skia-canvas": "4.0.0" },
  {
    "node_modules/@skia-canvas/darwin-arm64": { cpu: ["arm64"], optional: true, os: ["darwin"] },
    "node_modules/@skia-canvas/linux-arm64-glibc": {
      cpu: ["arm64"],
      libc: ["glibc"],
      optional: true,
      os: ["linux"],
    },
    "node_modules/@skia-canvas/linux-x64-glibc": {
      cpu: ["x64"],
      libc: ["glibc"],
      optional: true,
      os: ["linux"],
    },
    "node_modules/@skia-canvas/linux-x64-musl": {
      cpu: ["x64"],
      libc: ["musl"],
      optional: true,
      os: ["linux"],
    },
    "node_modules/@skia-canvas/win32-x64": { cpu: ["x64"], optional: true, os: ["win32"] },
    "node_modules/skia-canvas": {
      optionalDependencies: {
        "@skia-canvas/darwin-arm64": "4.0.0",
        "@skia-canvas/linux-arm64-glibc": "4.0.0",
        "@skia-canvas/linux-x64-glibc": "4.0.0",
        "@skia-canvas/linux-x64-musl": "4.0.0",
        "@skia-canvas/win32-x64": "4.0.0",
      },
    },
  },
);

/** One optional package `native` with the given entry fields, reached from the root. */
function single(fields: Record<string, unknown>): unknown {
  return lock({ native: "1.0.0" }, { "node_modules/native": { optional: true, ...fields } });
}

describe("expectedOptionalPackages", () => {
  it("expects the optional packages whose os, cpu and libc match the platform", () => {
    expect(expectedOptionalPackages(GLIBC, SKIA)).toEqual([
      "node_modules/@skia-canvas/linux-x64-glibc",
    ]);
    expect(expectedOptionalPackages(MUSL, SKIA)).toEqual([
      "node_modules/@skia-canvas/linux-x64-musl",
    ]);
    expect(expectedOptionalPackages({ ...GLIBC, cpu: "arm64" }, SKIA)).toEqual([
      "node_modules/@skia-canvas/linux-arm64-glibc",
    ]);
    expect(expectedOptionalPackages({ ...GLIBC, libc: undefined, os: "darwin" }, SKIA)).toEqual([]);
    expect(expectedOptionalPackages({ ...GLIBC, cpu: "arm64", os: "darwin" }, SKIA)).toEqual([
      "node_modules/@skia-canvas/darwin-arm64",
    ]);
  });

  it("never matches a libc constraint on an undetected family or outside Linux", () => {
    expect(expectedOptionalPackages({ ...GLIBC, libc: undefined }, SKIA)).toEqual([]);
    expect(
      expectedOptionalPackages({ ...GLIBC, os: "darwin" }, single({ libc: ["glibc"] })),
    ).toEqual([]);
  });

  it("applies negated entries, a lone any, a string list and absent lists like npm", () => {
    const expected = (fields: Record<string, unknown>, platform = GLIBC) =>
      expectedOptionalPackages(platform, single(fields)).length === 1;
    expect(expected({})).toBe(true);
    expect(expected({ os: ["!win32"] })).toBe(true);
    expect(expected({ os: ["!win32"] }, { ...GLIBC, os: "win32" })).toBe(false);
    expect(expected({ cpu: ["!arm64", "!ia32"] })).toBe(true);
    expect(expected({ cpu: ["!arm64", "x64"] })).toBe(true);
    expect(expected({ cpu: ["!x64", "arm64"] })).toBe(false);
    expect(expected({ os: ["any"] })).toBe(true);
    expect(expected({ os: "linux" })).toBe(true);
    expect(expected({ os: "darwin" })).toBe(false);
    expect(expected({ libc: ["!musl"] })).toBe(true);
    expect(expected({ libc: ["!glibc"] })).toBe(false);
  });

  it("skips an optional package whose engines npm would reject or cannot be read", () => {
    const expected = (engines: Record<string, unknown>, platform = GLIBC) =>
      expectedOptionalPackages(platform, single({ engines })).length === 1;
    expect(expected({ node: ">=20.9.0" })).toBe(true);
    expect(expected({ node: ">=99" })).toBe(false);
    expect(expected({ node: "latest" })).toBe(false);
    expect(expected({ npm: ">=10" })).toBe(true);
    expect(expected({ npm: ">=10" }, { ...GLIBC, npm: undefined })).toBe(false);
  });

  it("expects nothing without a lockfileVersion 2 or 3 packages map", () => {
    for (const value of [
      undefined,
      "lock",
      { dependencies: { native: { optional: true } }, lockfileVersion: 1 },
      { lockfileVersion: 3 },
      { lockfileVersion: 4, packages: { "node_modules/native": { optional: true } } },
    ]) {
      expect(expectedOptionalPackages(GLIBC, value)).toEqual([]);
      expect(hasOptionalPackages(value)).toBe(false);
    }
    const v2 = { ...(single({}) as object), lockfileVersion: 2 };
    expect(expectedOptionalPackages(GLIBC, v2)).toEqual(["node_modules/native"]);
    expect(hasOptionalPackages(v2)).toBe(true);
  });

  it("ignores packages that are not optional, devOptional ones included", () => {
    const packages = lock(
      { plain: "1.0.0", tool: "1.0.0" },
      {
        "node_modules/plain": { os: ["linux"] },
        "node_modules/tool": { devOptional: true, os: ["linux"] },
      },
    );
    expect(expectedOptionalPackages(GLIBC, packages)).toEqual([]);
    expect(hasOptionalPackages(packages)).toBe(false);
  });

  it("resolves nested node_modules paths from the nearest directory, like npm", () => {
    const packages = lock(
      { a: "1.0.0", b: "1.0.0" },
      {
        "node_modules/@scope/native": { optional: true },
        "node_modules/a": { dependencies: { "@scope/native": "2.0.0" } },
        "node_modules/a/node_modules/@scope/native": { cpu: ["x64"], optional: true },
        "node_modules/b": { optionalDependencies: { "@scope/native": "1.0.0" } },
      },
    );
    expect(expectedOptionalPackages(GLIBC, packages)).toEqual([
      "node_modules/@scope/native",
      "node_modules/a/node_modules/@scope/native",
    ]);
    expect(expectedOptionalPackages({ ...GLIBC, cpu: "arm64" }, packages)).toEqual([
      "node_modules/@scope/native",
    ]);
  });

  it("does not expect what only a skipped optional package reaches", () => {
    const packages = lock(
      { binding: "1.0.0", shared: "1.0.0" },
      {
        "node_modules/@emnapi/core": { optional: true },
        "node_modules/@emnapi/runtime": { optional: true },
        "node_modules/binding": {
          optionalDependencies: {
            "binding-linux-x64": "1.0.0",
            "binding-wasm32": "1.0.0",
          },
        },
        "node_modules/binding-linux-x64": { cpu: ["x64"], optional: true, os: ["linux"] },
        "node_modules/binding-wasm32": {
          cpu: ["wasm32"],
          dependencies: { "@emnapi/core": "1.0.0", "@emnapi/runtime": "1.0.0" },
          optional: true,
        },
        "node_modules/binding-wasm32/node_modules/@emnapi/core": { optional: true },
        "node_modules/shared": { optionalDependencies: { "@emnapi/runtime": "1.0.0" } },
      },
    );
    expect(expectedOptionalPackages(GLIBC, packages)).toEqual([
      "node_modules/@emnapi/runtime",
      "node_modules/binding-linux-x64",
    ]);
  });

  it("starts from workspace folders, skips optional peers and leaves bundled packages out", () => {
    const packages = {
      lockfileVersion: 3,
      packages: {
        "": { name: "monorepo", workspaces: ["packages/app"] },
        "node_modules/app": { link: true, resolved: "packages/app" },
        "node_modules/bundler": {
          bundleDependencies: ["bundled-native"],
          optionalDependencies: { "bundled-native": "1.0.0" },
        },
        "node_modules/bundler/node_modules/bundled-native": { inBundle: true, optional: true },
        "node_modules/native": { optional: true },
        "node_modules/peer-native": { optional: true },
        "packages/app": {
          devDependencies: { bundler: "1.0.0" },
          optionalDependencies: { native: "1.0.0" },
          peerDependencies: { "peer-native": "1.0.0" },
          peerDependenciesMeta: { "peer-native": { optional: true } },
        },
      },
    };
    expect(expectedOptionalPackages(GLIBC, packages)).toEqual(["node_modules/native"]);
  });
});

describe("omit", () => {
  it("parses npm config get omit output", () => {
    expect(parseOmitList("")).toEqual([]);
    expect(parseOmitList("dev\n")).toEqual(["dev"]);
    expect(parseOmitList("peer,dev\noptional,bogus")).toEqual(["dev", "optional", "peer"]);
  });

  it.each([
    ["npm ci", [], []],
    ["npm ci --omit=dev", ["dev"], []],
    ["npm ci --omit dev --omit=peer", ["dev", "peer"], []],
    ["npm ci --omit=optional,dev", ["dev", "optional"], []],
    ["npm ci --production", ["dev"], []],
    ["npm ci --only=prod", ["dev"], []],
    ["npm ci --only=production", ["dev"], []],
    ["npm ci --only=dev", [], []],
    ["npm ci --no-optional", ["optional"], []],
    ["NODE_ENV=production npm ci", ["dev"], []],
    ["npm ci --omit=dev --include=dev --include optional", ["dev"], ["dev", "optional"]],
    ['npm ci "--omit=peer" --omit=bogus', ["peer"], []],
  ])("reads the omit flags of %s", (install, omit, include) => {
    expect(installCommandOmit(install)).toEqual({ include, omit });
  });

  it("joins the configured omit and the command's, less what the command includes", () => {
    expect(effectiveOmit([], "npm ci")).toEqual([]);
    expect(effectiveOmit(["dev"], "npm ci")).toEqual(["dev"]);
    expect(effectiveOmit(["dev"], "npm ci --omit=optional")).toEqual(["dev", "optional"]);
    expect(effectiveOmit(["dev"], "npm ci --include=dev")).toEqual([]);
    expect(effectiveOmit([], "npm ci --omit=peer --include=peer")).toEqual([]);
  });

  it("leaves out omitted kinds and what only they reach", () => {
    const packages = {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { app: "1.0.0", "peer-host": "1.0.0" },
          devDependencies: { "dev-tool": "1.0.0", "skia-native": "1.0.0", "two-way": "1.0.0" },
          optionalDependencies: { "two-way": "1.0.0" },
        },
        "node_modules/app": { optionalDependencies: { "app-native": "1.0.0" } },
        "node_modules/app-native": { optional: true },
        "node_modules/dev-tool": { dev: true, optionalDependencies: { "tool-native": "1.0.0" } },
        "node_modules/peer-host": { optionalDependencies: { "peer-native": "1.0.0" }, peer: true },
        "node_modules/peer-native": { optional: true, peer: true },
        "node_modules/skia-native": { dev: true, optional: true },
        "node_modules/tool-native": { dev: true, optional: true },
        "node_modules/two-way": {
          devOptional: true,
          optionalDependencies: { "two-way-native": "1.0.0" },
        },
        "node_modules/two-way-native": { optional: true },
      },
    };
    const expected = (omit: InstallPlatform["omit"]) =>
      expectedOptionalPackages({ ...GLIBC, omit }, packages);
    const all = [
      "node_modules/app-native",
      "node_modules/peer-native",
      "node_modules/skia-native",
      "node_modules/tool-native",
      "node_modules/two-way-native",
    ];
    expect(expected([])).toEqual(all);
    // A devOptional entry stays while only dev is omitted, so what it reaches is still expected.
    expect(expected(["dev"])).toEqual([
      "node_modules/app-native",
      "node_modules/peer-native",
      "node_modules/two-way-native",
    ]);
    expect(expected(["optional"])).toEqual([]);
    expect(expected(["peer"])).toEqual(all.filter((key) => key !== "node_modules/peer-native"));
    expect(expected(["dev", "peer"])).toEqual([
      "node_modules/app-native",
      "node_modules/two-way-native",
    ]);
    // With both dev and optional omitted, the devOptional entry goes too.
    expect(expected(["dev", "optional"])).toEqual([]);
  });
});

describe("skippedOptionalReason", () => {
  const log = "/logs/install.log";

  it("passes when every expected package is present", () => {
    expect(skippedOptionalReason(log, GLIBC, ["node_modules/a"], ["node_modules/a"])).toBe(
      undefined,
    );
    expect(skippedOptionalReason(log, GLIBC, [], [])).toBeUndefined();
  });

  it("names the missing packages, the platform and the install log", () => {
    expect(
      skippedOptionalReason(
        log,
        GLIBC,
        ["node_modules/@skia-canvas/linux-x64-glibc", "node_modules/present"],
        ["node_modules/present", "node_modules/unexpected"],
      ),
    ).toBe(
      "install skipped optional packages that package-lock.json lists for linux x64 glibc: " +
        "node_modules/@skia-canvas/linux-x64-glibc; see /logs/install.log",
    );
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `node_modules/${name}`);
    expect(skippedOptionalReason(log, { ...GLIBC, libc: undefined }, many, [])).toBe(
      "install skipped optional packages that package-lock.json lists for linux x64: " +
        "node_modules/a, node_modules/b, node_modules/c, node_modules/d, node_modules/e " +
        "and 2 more; see /logs/install.log",
    );
    expect(
      skippedOptionalReason(log, { ...GLIBC, omit: ["dev", "peer"] }, ["node_modules/a"], []),
    ).toBe(
      "install skipped optional packages that package-lock.json lists for linux x64 glibc " +
        "(omit: dev, peer): node_modules/a; see /logs/install.log",
    );
  });
});

describe("container scripts", () => {
  /** Run the platform script in a fresh project, with npm's omit settings only from `env`. */
  function probe(env: Record<string, string>) {
    const work = mkdtempSync(join(tmpdir(), "work-"));
    writeFileSync(join(work, "package.json"), '{"name":"game","version":"1.0.0"}\n');
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          key !== "NODE_ENV" &&
          !/^npm_config_(?:include|omit|only|optional|production)$/iu.test(key),
      ),
    );
    const result = spawnSync("sh", ["-c", platformScript(work)], {
      encoding: "utf8",
      env: { ...inherited, ...env },
    });
    expect(result.status, result.stderr).toBe(0);
    return parseInstallPlatform(result.stdout);
  }

  it("reads this process's platform and npm's omit with the platform script", () => {
    const platform = probe({});
    expect(platform).toMatchObject({
      cpu: process.arch,
      node: process.versions.node,
      omit: [],
      os: process.platform,
    });
    expect(["glibc", "musl", undefined]).toContain(platform?.libc);
  });

  it("reads the omit that NODE_ENV=production and npm_config_omit configure", () => {
    expect(probe({ NODE_ENV: "production" })?.omit).toEqual(["dev"]);
    expect(probe({ npm_config_omit: "optional" })?.omit).toEqual(["optional"]);
  });

  it("names node when the image has none", () => {
    const result = spawnSync("/bin/sh", ["-c", platformScript("/tmp")], {
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
    });
    expect(result.status).toBe(NO_NODE);
    expect(result.stdout.trim()).toBe("node");
  });

  it("parses only a platform record", () => {
    expect(
      parseInstallPlatform(
        '{"cpu":"x64","libc":null,"node":"24.0.0","npm":null,"omit":"dev","os":"linux"}\n',
      ),
    ).toEqual({
      cpu: "x64",
      libc: undefined,
      node: "24.0.0",
      npm: undefined,
      omit: ["dev"],
      os: "linux",
    });
    expect(parseInstallPlatform("")).toBeUndefined();
    expect(parseInstallPlatform('{"cpu":"x64"}')).toBeUndefined();
  });

  it("lists the arguments whose package is installed", () => {
    const work = mkdtempSync(join(tmpdir(), "work-"));
    mkdirSync(join(work, "node_modules", "@scope", "present"), { recursive: true });
    writeFileSync(join(work, "node_modules", "@scope", "present", "package.json"), "{}\n");
    mkdirSync(join(work, "node_modules", "empty"), { recursive: true });
    const result = spawnSync(
      "sh",
      [
        "-c",
        presenceScript(work),
        "sh",
        "node_modules/@scope/present",
        "node_modules/empty",
        "node_modules/absent",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("node_modules/@scope/present\n");
  });
});
