import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installedIdentity, loadedIdentity, PACKAGE, pinGuard, recordPin } from "./pin.ts";
import { makeGame, recordingEvents, testContext } from "./testGame.ts";

function install(repo: string, version: string, cli: string): string {
  const root = join(repo, "node_modules", PACKAGE);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "dist", "cli.js"), cli);
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({
      packages: { [`node_modules/${PACKAGE}`]: { integrity: `sha512-${version}` } },
    }),
  );
  return join(root, "dist", "cli.js");
}

describe("pin guard", () => {
  it("records the loaded identity and emits one deduplicated mismatch naming both builds", () => {
    const test = makeGame();
    const events = recordingEvents();
    const context = testContext(test, { events });
    const cli = install(test.repo, "1.0.0", "build A");
    const loaded = loadedIdentity("1.0.0", cli, test.repo);
    recordPin(context, loaded, cli);
    const guard = pinGuard(context, loaded);
    expect(guard.check()).toBe(true);
    install(test.repo, "1.0.1", "build B");
    expect(guard.check()).toBe(false);
    expect(guard.check()).toBe(false);
    expect(events.list).toHaveLength(1);
    expect(events.list[0]?.[0]).toBe("pin-mismatch");
    expect(events.list[0]?.[2]).toMatch(/loaded 1\.0\.0 .*installed 1\.0\.1/);
  });

  it("treats a deleted installation as a mismatch", () => {
    const test = makeGame();
    const events = recordingEvents();
    const context = testContext(test, { events });
    const cli = install(test.repo, "1.0.0", "build A");
    const guard = pinGuard(context, loadedIdentity("1.0.0", cli, test.repo));
    rmSync(join(test.repo, "node_modules"), { recursive: true });
    expect(installedIdentity(test.repo)).toMatchObject({ cliSha256: null, version: null });
    expect(guard.check()).toBe(false);
    expect(events.list[0]?.[2]).toContain("installed missing");
  });
});
