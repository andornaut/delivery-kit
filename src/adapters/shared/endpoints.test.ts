import { statSync } from "node:fs";
import { homedir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Layout } from "../../layout.ts";
import type { Registry } from "../../registry/schema.ts";
import { harnessReadiness } from "../../review/readiness.ts";
import { coordinatorConfig, registryInput } from "../../testFixtures.ts";
import { resolveCodexControlSocket } from "../../transport.ts";
import { codexAdapter, SOCKET_MISSING } from "../codex/index.ts";
import { connectControl } from "../codex/rpc.ts";
import { resolveCodexEndpoint } from "./endpoints.ts";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: vi.fn(() => "/managed-home"),
}));

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  statSync: vi.fn(() => ({ isSocket: () => true })),
}));

vi.mock("../codex/rpc.ts", async (original) => ({
  ...(await original<typeof import("../codex/rpc.ts")>()),
  connectControl: vi.fn(() => {
    throw new Error("unexpected native connection");
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe("Codex endpoint selection", () => {
  it("preserves an explicit option over environment and managed paths without inspecting it", () => {
    expect(
      resolveCodexControlSocket({
        controlSocket: "/chosen/not-created.sock",
        env: { CODEX_CONTROL_SOCKET: "/environment.sock" },
        home: "/other-home",
      }),
    ).toEqual({ path: "/chosen/not-created.sock", source: "option" });
    expect(statSync).not.toHaveBeenCalled();
    expect(homedir).not.toHaveBeenCalled();
  });

  it.each([
    ["empty option", { controlSocket: "", env: { CODEX_CONTROL_SOCKET: "/environment.sock" } }],
    ["relative environment", { env: { CODEX_CONTROL_SOCKET: "relative.sock" } }],
  ] as const)("rejects %s without falling back or exposing the value", (_name, options) => {
    expect(() => resolveCodexControlSocket({ ...options, home: "/other-home" })).toThrowError(
      /^Codex control socket must be a nonempty absolute path without NUL bytes$/,
    );
    expect(homedir).not.toHaveBeenCalled();
    expect(statSync).not.toHaveBeenCalled();
  });

  it("selects the managed home default only when explicit configuration is absent", () => {
    expect(resolveCodexControlSocket({ env: {} })).toEqual({
      path: "/managed-home/.codex/app-server-control/app-server-control.sock",
      source: "managed",
    });
    expect(statSync).not.toHaveBeenCalled();
    expect(connectControl).not.toHaveBeenCalled();
  });

  it("keeps missing runtime configuration and legacy readiness unavailable without managed discovery", async () => {
    expect(resolveCodexEndpoint({ env: {} })).toEqual({
      path: null,
      reason: null,
      source: "none",
      status: "unconfigured",
    });
    const layout = { config: coordinatorConfig() } as unknown as Layout;
    const registry = registryInput() as unknown as Registry;
    expect(await codexAdapter(layout, { env: {} }).status("unused-recipient")).toEqual({
      reason: SOCKET_MISSING,
      status: "unavailable",
    });
    const ready = await harnessReadiness({}, layout, registry, "codex", {
      roles: ["archies-dog-walks/tech"],
    });
    expect(ready.adapter).toEqual({ reason: SOCKET_MISSING, status: "unavailable" });
    expect(ready.ready).toBe(false);
    expect(homedir).not.toHaveBeenCalled();
    expect(statSync).not.toHaveBeenCalled();
    expect(connectControl).not.toHaveBeenCalled();
  });
});
