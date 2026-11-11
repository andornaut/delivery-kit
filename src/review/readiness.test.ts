import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type FakeControl, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { type Layout, loadLayout } from "../layout.ts";
import { createRegistry, readRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import { CODEX_TECH, makeFixture, registryInput } from "../testFixtures.ts";
import { effectiveReadiness, harnessReadiness } from "./readiness.ts";

const CODEX_GAME_DEV = "00000000-0000-4000-8000-000000000004";
const controls: FakeControl[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
});

function setup(): Layout {
  const layout = loadLayout(makeFixture().root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  writeFileSync(
    layout.routeFile,
    JSON.stringify({
      host: "archies-dog-walks",
      schema: 2,
      state: "active",
      targets: ["archies-dog-walks/tech"],
    }),
  );
  return layout;
}

describe("harnessReadiness", () => {
  it("a scoped target probe ignores unselected route members and reports current and probed harnesses", async () => {
    const layout = setup();
    const control = await startFakeControl(mkdtempSync(join(tmpdir(), "ready-")), () => ({
      result: {},
    }));
    controls.push(control);
    const report = await harnessReadiness(
      { CODEX_CONTROL_SOCKET: control.path },
      layout,
      readRegistry(layout),
      "codex",
      { roles: ["archies-dog-walks/tech"] },
    );
    expect(report).toMatchObject({
      ready: true,
      roles: [
        {
          role: "archies-dog-walks/tech",
          conversation: CODEX_TECH,
          current_harness: "claude",
          probed_harness: "codex",
          status: "resolved",
        },
      ],
    });
    expect(control.methods()).toEqual([]);
  });

  it("rejects invalid explicit selections and does not accept an invalid route as effective readiness", async () => {
    const layout = setup();
    const registry = readRegistry(layout);
    await expect(
      harnessReadiness({}, layout, registry, "codex", { games: ["unknown"] }),
    ).rejects.toThrow();
    await expect(effectiveReadiness({}, layout, registry, {})).rejects.toThrow();
    writeFileSync(layout.routeFile, "{invalid");
    expect(await effectiveReadiness({}, layout, registry)).toEqual({
      adapters: {},
      harness: "mixed",
      roles: [],
      ready: false,
    });
  });

  it("is ready only when the adapter connects and every route role resolves", async () => {
    const layout = setup();
    const control = await startFakeControl(mkdtempSync(join(tmpdir(), "ready-")), () => ({
      result: {},
    }));
    controls.push(control);
    const env = { CODEX_CONTROL_SOCKET: control.path };
    const before = await harnessReadiness(env, layout, readRegistry(layout), "codex");
    expect(before).toEqual({
      adapter: { reason: null, status: "available" },
      harness: "codex",
      ready: false,
      roles: [
        { conversation: null, role: "game-dev", status: "unavailable" },
        { conversation: CODEX_TECH, role: "archies-dog-walks/tech", status: "resolved" },
      ],
    });
    updateRegistry(layout, 1, (draft) => {
      draft.roles["game-dev"]!.conversations.codex = CODEX_GAME_DEV;
    });
    const after = await harnessReadiness(env, layout, readRegistry(layout), "codex");
    expect(after.ready).toBe(true);
    expect(control.methods()).toEqual([]);
  });

  it("reports an unavailable adapter without a control socket", async () => {
    const layout = setup();
    const report = await harnessReadiness({}, layout, readRegistry(layout), "codex");
    expect(report.adapter.status).toBe("unavailable");
    expect(report.ready).toBe(false);
  });
});
