// Harness self-check: the fake control socket speaks WebSocket JSON-RPC to the CLI.
import { expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";

suite("harness", () => {
  const workspace = workspaces();

  contract("the fake control socket answers a native snapshot", async () => {
    const ws = workspace();
    // The snapshot recipient is a registered monitor under a Codex registry.
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "codex",
      roles: { monitor: { conversations: { codex: MONITOR } } },
    });
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
