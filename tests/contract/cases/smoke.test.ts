// Harness self-checks: the resident runner under the virtual clock and the fake control socket.
import { expect } from "vitest";

import { cli, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import { at } from "../lib/time.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";

suite("harness", () => {
  const workspace = workspaces();

  contract("a high-load scheduled departure retains its queue and records attempt and blocked events", async () => {
    const ws = workspace();
    ws.writeRegistry({ schema: 1, revision: 1, harness: "codex", roles: { monitor: { conversations: { codex: MONITOR } } } });
    ws.config.reports = { project: "Fixture", recipient: "monitor" };
    ws.config.resources = { cpus: 4, maxWorkers: 4, loadLimit: 0 };
    ws.updateControl((c) => (c.codex = { fail: true }));
    ws.queue(["bus/queued"]);
    ws.setClock(at(-1, 50));
    const runner = startRunner(ws);
    await runner.until(() => ws.events().some((e) => e.kind === "blocked-load"));
    await runner.stop();
    expect(ws.read("bus-queue")).toBe("bus/queued\n");
    expect(new Set(ws.events().map((e) => e.kind))).toEqual(new Set(["attempt", "blocked-load"]));
  });

  contract("the fake control socket answers a native snapshot", async () => {
    const ws = workspace();
    const socket = await new CodexSocket(ws).listen();
    try {
      ws.env.CODEX_CONTROL_SOCKET = socket.path;
      socket.on("thread/queue/list", { data: [], nextCursor: null });
      const result = await cli(ws, ["monitor-snapshot", "--recipient", MONITOR]);
      expect(socket.methods()[0]).toBe("initialize");
      expect(result.stdout + result.stderr).not.toBe("");
    } finally {
      await socket.close();
    }
  });
});
