import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRoute, RouteError } from "./route.ts";

const MONITOR = "00000000-0000-4000-8000-000000000003";
const ART = "00000000-0000-4000-8000-000000000004";
const TECH = "00000000-0000-4000-8000-000000000005";

function routeFile(route: Record<string, unknown>): { host: string; path: string } {
  const host = mkdtempSync(join(tmpdir(), "route-"));
  const path = join(host, "route.json");
  writeFileSync(
    path,
    JSON.stringify({
      harness: "codex",
      host_project_root: host,
      monitor_thread_id: MONITOR,
      state: "active",
      targets: [
        { ownership: "active", thread_id: ART },
        { ownership: "active", thread_id: ART },
        { ownership: "held", thread_id: TECH },
      ],
      version: 1,
      ...route,
    }),
  );
  return { host, path };
}

describe("resolveRoute", () => {
  it("returns the monitor and deduplicated active peers on the host", () => {
    const { host, path } = routeFile({});
    expect(resolveRoute(host, path)).toEqual({
      coordinator: MONITOR,
      peers: [ART],
      status: "active",
    });
  });

  it("skips a nonhost project and a held route", () => {
    const { path } = routeFile({});
    const other = mkdtempSync(join(tmpdir(), "other-"));
    expect(resolveRoute(other, path)).toEqual({ status: "nonhost" });
    const held = routeFile({ monitor_thread_id: null, state: "held", targets: [] });
    expect(resolveRoute(held.host, held.path)).toEqual({ status: "held" });
  });

  it.each([
    ["another harness", { harness: "claude" }],
    ["a monitor that is also a target", { targets: [{ ownership: "active", thread_id: MONITOR }] }],
    [
      "conflicting ownership",
      {
        targets: [
          { ownership: "active", thread_id: ART },
          { ownership: "held", thread_id: ART },
        ],
      },
    ],
    ["a noncanonical identity", { monitor_thread_id: "00000000-0000-4000-A000-000000000003" }],
    ["an active route without active targets", { targets: [] }],
  ])("refuses %s", (_name, route) => {
    const { host, path } = routeFile(route);
    expect(() => resolveRoute(host, path)).toThrow(RouteError);
  });

  it("requires absolute paths", () => {
    expect(() => resolveRoute("relative", "/route.json")).toThrow(RouteError);
  });
});
