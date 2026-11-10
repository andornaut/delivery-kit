import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scripts = dirname(fileURLToPath(import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pack-context-"));
  mkdirSync(join(root, "scripts"));
  for (const name of ["pack.ts", "guards.ts"]) {
    copyFileSync(join(scripts, name), join(root, "scripts", name));
  }
  writeFileSync(join(root, ".nvmrc"), "v24.21.0\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
  const sha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls.jsonl");
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PACK_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'image') {
  if (process.env.PACK_TEST_MISSING === '1') process.exit(1);
  console.log('sha256:' + 'a'.repeat(64));
} else if (args[0] === 'volume') {
  if (process.env.CONTAINER_IMAGE !== undefined) process.exit(17);
} else if (args[0] === 'start' && process.env.PACK_TEST_OFFLINE_FAILURE === '1') {
  process.exit(31);
} else if (args[0] === 'cp') {
  const out = args.at(-1);
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'SOURCE_COMMIT'), process.env.PACK_TEST_SHA + '\\n');
  fs.writeFileSync(path.join(out, 'delivery-kit-fixture.tgz'), 'fixture archive');
  const names = ['SOURCE_COMMIT', 'delivery-kit-fixture.tgz'];
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), names.map(name =>
    crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(out, name)))
      .digest('hex') + '  ' + name + '\\n').join(''));
}
`,
    { mode: 0o755 },
  );
  return { root, sha, bin, calls, output: join(root, "output") };
}

function run(fixture: ReturnType<typeof setup>, env: Readonly<Record<string, string>> = {}) {
  const inherited = { ...process.env };
  delete inherited.CONTAINER_IMAGE;
  const result = spawnSync(
    process.execPath,
    [join(fixture.root, "scripts/pack.ts"), fixture.sha, fixture.output],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...inherited,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
        PACK_TEST_CALLS: fixture.calls,
        PACK_TEST_SHA: fixture.sha,
        ...env,
      },
    },
  );
  const calls = readFileSync(fixture.calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
}

describe("offline pack dependency sources", () => {
  it("uses the legacy volume and pinned Node image when CONTAINER_IMAGE is absent", () => {
    const fixture = setup();
    const result = run(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((call) => call[0] === "volume" && call[1] === "inspect")).toBe(true);
    expect(result.calls.some((call) => call[0] === "image")).toBe(false);
    const create = result.calls.find((call) => call[0] === "create")!;
    expect(create).toContain("node:24.21.0");
    expect(create).toContain("PACK_NPM_CACHE=/var/tmp/npm");
    expect(create.some((arg) => arg.startsWith("type=volume,") && arg.endsWith(",readonly"))).toBe(
      true,
    );
  });

  it("pins the prepared image ID, omits the volume and preserves exact archive provenance and copy-out", () => {
    const fixture = setup();
    const result = run(fixture, { CONTAINER_IMAGE: "local-check:prepared" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((call) => call[0] === "volume")).toBe(false);
    const create = result.calls.find((call) => call[0] === "create")!;
    expect(create).toContain(`sha256:${"a".repeat(64)}`);
    expect(create).not.toContain("local-check:prepared");
    expect(create.some((arg) => arg.startsWith("type=volume,"))).toBe(false);
    expect(create).toContain("PACK_NPM_CACHE=/opt/check/npm-cache");
    expect(create).toContain(`SOURCE_REVISION=${fixture.sha}`);
    expect(create.some((arg) => /^SOURCE_DATE_EPOCH=\d+$/.test(arg))).toBe(true);
    expect(create[create.indexOf("--network") + 1]).toBe("none");
    expect(create[create.indexOf("--user") + 1]).toBe("19001:19001");
    expect(create.some((arg) => arg.startsWith("type=bind,") && arg.endsWith(",readonly"))).toBe(
      true,
    );
    const program = create.at(-1)!;
    expect(program).toContain("npm ci --offline --ignore-scripts");
    expect(program).toContain("node scripts/build.mjs");
    expect(program).not.toContain("npm run build");
    expect(readFileSync(join(fixture.output, "SOURCE_COMMIT"), "utf8")).toBe(`${fixture.sha}\n`);
    const archive = readFileSync(join(fixture.output, "delivery-kit-fixture.tgz"));
    expect(readFileSync(join(fixture.output, "SHA256SUMS"), "utf8")).toContain(
      `${createHash("sha256").update(archive).digest("hex")}  delivery-kit-fixture.tgz`,
    );
  });

  it("rejects a missing prepared image without a volume lookup, container or fallback", () => {
    const fixture = setup();
    const result = run(fixture, { CONTAINER_IMAGE: "local-check:missing", PACK_TEST_MISSING: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("prepared CONTAINER_IMAGE unavailable");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.slice(0, 2)).toEqual(["image", "inspect"]);
    expect(existsSync(fixture.output)).toBe(false);
  });

  it("keeps an offline install failure terminal and copies no artifact", () => {
    const fixture = setup();
    const result = run(fixture, {
      CONTAINER_IMAGE: "local-check:prepared",
      PACK_TEST_OFFLINE_FAILURE: "1",
    });
    expect(result.status).toBe(31);
    expect(result.calls.some((call) => call[0] === "cp" || call[0] === "volume")).toBe(false);
    expect(existsSync(fixture.output)).toBe(false);
  });
});
