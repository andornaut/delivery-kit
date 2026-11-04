import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HELD, MONITOR, routeValue, TECH } from "../../monitor/fixtures.ts";
import { resolveRouteV2, RouteError, routeHarness } from "./route.ts";

function scratch(): { root: string; write: (value: unknown) => string } {
  const root = mkdtempSync(join(tmpdir(), "route-"));
  const path = join(root, "route.json");
  return {
    root,
    write(value) {
      writeFileSync(path, JSON.stringify(value));
      return path;
    },
  };
}

describe("resolveRouteV2", () => {
  it("deduplicates targets and excludes held ones", () => {
    const { root, write } = scratch();
    const path = write(routeValue(root));
    expect(resolveRouteV2(path, root)).toEqual({
      coordinator: MONITOR,
      monitorName: "game-dev",
      peers: [TECH],
      status: "active",
      targets: [{ name: "Archie tech", sessionId: TECH }],
    });
    expect(resolveRouteV2(path, join(root, "other"))).toEqual({ status: "nonhost" });
    write(
      routeValue(root, {
        monitor: { name: "game-dev", ownership: "held", session_id: null },
        state: "held",
        targets: [],
      }),
    );
    expect(resolveRouteV2(path, root)).toEqual({ status: "held" });
  });

  it("rejects invalid schemas", () => {
    const { root, write } = scratch();
    const base = routeValue(root);
    const monitor = base.monitor as Record<string, unknown>;
    const target = { name: "Archie tech", ownership: "active", session_id: TECH };
    const cases: Record<string, unknown> = {
      conflict: { ...base, targets: [target, { ...target, ownership: "held" }] },
      endpointKey: { ...base, targets: [{ ...target, thread_id: TECH }] },
      extraKey: { ...base, monitor_thread_id: MONITOR },
      harness: { ...base, harness: "codex" },
      monitorHeld: { ...base, monitor: { ...monitor, ownership: "held" } },
      monitorMissing: { ...base, monitor: { ...monitor, session_id: null } },
      monitorTarget: { ...base, targets: [{ ...target, session_id: MONITOR }] },
      name: { ...base, targets: [{ ...target, name: "bad\nname" }] },
      noActiveTargets: { ...base, targets: [{ ...target, ownership: "held" }] },
      noncanonical: {
        ...base,
        targets: [{ ...target, session_id: HELD.toUpperCase().replace("0", "A") }],
      },
      ownership: { ...base, targets: [{ ...target, ownership: "owned" }] },
      relativeRoot: { ...base, host_project_root: "relative" },
      state: { ...base, state: "paused" },
      version: { ...base, version: true },
    };
    for (const [name, value] of Object.entries(cases)) {
      expect(() => resolveRouteV2(write(value), root), name).toThrow(RouteError);
    }
    expect(() => resolveRouteV2(write(base), "relative")).toThrow(RouteError);
  });

  it("selects the harness by version and harness together", () => {
    expect(routeHarness({ harness: "codex", version: 1 })).toBe("codex");
    expect(routeHarness({ harness: "claude", version: 2 })).toBe("claude");
    for (const value of [
      { harness: "codex", version: 2 },
      { harness: "claude", version: "2" },
      [],
    ]) {
      expect(() => routeHarness(value)).toThrow(RouteError);
    }
  });
});
