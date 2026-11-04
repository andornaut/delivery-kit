import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessAdapter } from "../adapters/types.ts";
import { readRegistry, updateRegistry } from "../registry/index.ts";
import { type ClaudeFixture, claudeFixture, MONITOR, SLOT, TECH } from "./fixtures.ts";
import { deliverScheduledWake } from "./wake.ts";

const codex = vi.hoisted(() => ({
  adapter: undefined as HarnessAdapter | undefined,
}));

vi.mock("./harnesses.ts", () => ({
  codexAdapter: () => {
    if (codex.adapter === undefined) {
      throw new Error("codex adapter is not available in this build");
    }
    return codex.adapter;
  },
}));

function useEnv(fixture: ClaudeFixture): void {
  for (const [key, value] of Object.entries(fixture.env)) {
    vi.stubEnv(key, value ?? "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  codex.adapter = undefined;
});

describe("deliverScheduledWake (claude)", () => {
  it("spools one brief for the registry monitor and deduplicates the slot", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const first = await deliverScheduledWake(fixture.layout, fixture.game, SLOT);
    expect(first).toBe('{"status": "sending", "monitor_session_status": "idle"}');
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      '{"status": "deduplicated", "previousStatus": "sending", "reason": null}',
    );
    const receipt = JSON.parse(
      readFileSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`), "utf8"),
    ) as {
      diagnostics: { kind: string; parent?: string }[];
    };
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "worker_health", parent: MONITOR }),
    );
  });

  it("does not dispatch from a nonhost project", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ host_project_root: join(fixture.base, "chibis-way-home") });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe("");
  });

  it("defers when the route monitor differs from the registry monitor", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({
      monitor: {
        name: "other",
        ownership: "active",
        session_id: "00000000-0000-4000-8000-00000000000e",
      },
    });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toContain(
      "differs from the registry monitor",
    );
    expect(existsSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`))).toBe(false);
  });

  it("reports blocked when the route is unreadable", async () => {
    const fixture = claudeFixture();
    writeFileSync(fixture.layout.routeFile, "not json");
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      '{"status": "blocked", "reason": "monitor route or state unavailable"}',
    );
  });
});

describe("deliverScheduledWake (codex)", () => {
  function codexFixture(): ClaudeFixture {
    const fixture = claudeFixture();
    const registry = readRegistry(fixture.layout);
    updateRegistry(fixture.layout, registry.revision, (draft) => {
      draft.harness = "codex";
      const gameDev = draft.roles["game-dev"];
      if (gameDev !== undefined) {
        gameDev.conversations.codex = MONITOR;
      }
    });
    writeFileSync(
      fixture.layout.routeFile,
      JSON.stringify({
        harness: "codex",
        host_project_root: fixture.game.repo,
        monitor_thread_id: MONITOR,
        state: "active",
        targets: [{ ownership: "active", thread_id: TECH }],
        version: 1,
      }),
    );
    return fixture;
  }

  it("delivers the reminder through the codex adapter with the slot request ID", async () => {
    const fixture = codexFixture();
    const deliver = vi.fn<HarnessAdapter["deliver"]>(() =>
      Promise.resolve({ requestId: "x", status: "accepted" }),
    );
    codex.adapter = {
      ack: vi.fn(),
      deliver,
      harness: "codex",
      inventory: (id) =>
        Promise.resolve({
          entries: id === TECH ? [{ payload: "p", queueId: "q1" }] : [],
          status: "available",
        }),
      status: vi.fn(),
    };
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      '{"status": "accepted"}',
    );
    expect(deliver).toHaveBeenCalledOnce();
    const [receipt, requestId, conversation, text] = deliver.mock.calls[0] ?? [];
    expect(receipt).toBe(join(fixture.unblock, `${MONITOR}-${SLOT}.json`));
    expect(requestId).toBe("7abe3e43-9217-5727-9bc2-9b9c22636262");
    expect(conversation).toBe(MONITOR);
    expect(text).toContain(`${TECH}: q1`);
    expect(text).toContain(`${MONITOR}: none`);
  });

  it("defers without clearance and reports blocked without the adapter", async () => {
    const fixture = codexFixture();
    fixture.clear("pending");
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toContain(
      '"status": "deferred"',
    );
    fixture.clear();
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toContain(
      '"status": "blocked"',
    );
  });
});
