// Bus event outbox durability, retry, deduplication and completion truth through the runner
// and the legacy Codex queue sink (from tests/verify-events.py).
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { impl, type Resident, startRunner } from "../lib/adapter.ts";
import {
  CI_POLL_SECONDS,
  CODEX_QUEUE_REMOVED,
  contract,
  QUEUE_MODEL,
  queueModel,
  retiredOnNode,
  suite,
  workspaces,
} from "../lib/cases.ts";
import { hold } from "../lib/locks.ts";
import { at, sleep } from "../lib/time.ts";
import { SHA, type Workspace } from "../lib/workspace.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));
const QUIET = ["ci_pending", "ci_running", "deploy_pending", "deploy_retry"];

function bus(ws: Workspace, options: { github?: string } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: { monitor: { conversations: { codex: MONITOR } } },
  });
  ws.config.reports = { project: "Fixture", recipient: "monitor" };
}

function delivered(ws: Workspace): string[] {
  return ws.calls("codex").map((call) => {
    expect(call.args.slice(0, 3)).toEqual(["queue", "--thread", MONITOR]);
    return call.args[call.args.indexOf("--message") + 1]!;
  });
}

function kinds(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.kind));
}

function start(ws: Workspace, speed = 30): Resident {
  ws.setClock(at(59, 58), speed);
  return startRunner(ws);
}

suite("events", () => {
  const workspace = workspaces();

  contract("empty departures are silent", async () => {
    const ws = workspace();
    bus(ws);
    const runner = start(ws, 60);
    await runner.until(() => ws.virtualNow() >= at(3, 0, 1), 20_000);
    await runner.stop();
    expect(ws.events()).toEqual([]);
    expect(ws.calls("codex")).toEqual([]);
  });

  retiredOnNode(
    CODEX_QUEUE_REMOVED,
    "codex-queue",
    "failed delivery stays durable, retries in order and delivers each event once",
    async () => {
      const ws = workspace();
      bus(ws);
      ws.config.deploy = { mode: "none", skipPattern: "" };
      ws.updateControl((c) => (c.codex = { fail: true }));
      impl.offer(ws, ["bus/feature"]);
      const runner = start(ws);
      await runner.until(() => kinds(ws).includes("push"));
      await sleep(1500);
      expect(ws.calls("codex")).toEqual([]);
      expect(ws.events().every((event) => event.sent === false)).toBe(true);
      ws.updateControl((c) => (c.codex = {}));
      await runner.until(
        () => ws.events().length > 0 && ws.events().every((event) => event.sent === true),
        20_000,
      );
      // Further flushes never resend.
      await sleep(2500);
      await runner.stop();
      const messages = delivered(ws);
      const events = ws.events();
      expect(messages.length).toBe(events.length);
      for (const [index, event] of events.entries()) {
        expect(messages[index]).toContain(`[bus event ${String(event.id).slice(0, 12)}]`);
      }
      expect(events.filter((event) => event.kind === "push").length).toBe(1);
    },
  );

  retiredOnNode(
    CODEX_QUEUE_REMOVED,
    "codex-queue",
    "completion is reported once, only after CI success and deployment success",
    async () => {
      const ws = workspace();
      bus(ws, { github: "fixture/project" });
      ws.config.ci = { requiredNames: ["Test"], pollSeconds: CI_POLL_SECONDS, timeoutSeconds: 5 };
      ws.updateControl((c) => {
        c.gh = {
          checks: { [SHA]: [{ id: 1, name: "Test", status: "completed", conclusion: "success" }] },
        };
        c.wrangler = { fail: true };
      });
      impl.offer(ws, ["bus/feature"]);
      const runner = start(ws);
      await runner.until(
        () => kinds(ws).includes("ci_success") && kinds(ws).includes("deploy_failure"),
      );
      expect(kinds(ws)).not.toContain("complete");
      ws.updateControl((c) => (c.wrangler = {}));
      await runner.until(
        () =>
          kinds(ws).includes("complete") &&
          ws.events().every((event) => event.sent || event.suppressed),
        30_000,
      );
      await runner.stop();
      expect(kinds(ws).filter((kind) => kind === "complete").length).toBe(1);
      expect(ws.readJson(join("events", `${SHA}.state`))).toEqual({
        ci: "success",
        deploy: "success",
        pushed: true,
      });
      const complete = ws.events().find((event) => event.kind === "complete")!;
      expect(complete.message).toBe(
        `Fixture bus: COMPLETE ${SHA}: full gate passed; CI success; deployment success.`,
      );
      expect(ws.events().find((event) => event.kind === "deploy_success")!.created).toBeLessThan(
        Number(complete.created),
      );
    },
  );

  retiredOnNode(
    CODEX_QUEUE_REMOVED,
    "codex-queue",
    "quiet pending and retry kinds are never delivered and stale queued noise is suppressed",
    async () => {
      const ws = workspace();
      bus(ws, { github: "fixture/project" });
      ws.config.ci = { requiredNames: ["Test"], pollSeconds: CI_POLL_SECONDS, timeoutSeconds: 5 };
      ws.updateControl((c) => {
        c.gh = {
          checks: { [SHA]: [{ id: 1, name: "Test", status: "completed", conclusion: "success" }] },
        };
        c.wrangler = { fail: true };
      });
      for (const kind of QUIET) {
        ws.write(
          join("events", `${kind}.json`),
          JSON.stringify({
            id: kind,
            kind,
            key: SHA,
            message: `stale ${kind}`,
            sent: false,
            created: 0,
          }),
        );
      }
      impl.offer(ws, ["bus/feature"]);
      const runner = start(ws);
      await runner.until(() => kinds(ws).includes("deploy_failure"));
      ws.updateControl((c) => (c.wrangler = {}));
      await runner.until(
        () =>
          kinds(ws).includes("complete") &&
          ws.events().every((event) => event.sent || event.suppressed),
        30_000,
      );
      await runner.stop();
      const messages = delivered(ws);
      expect(
        messages.some(
          (message) => message.includes("stale ") || message.includes("pending/running"),
        ),
      ).toBe(false);
      for (const kind of QUIET)
        expect(ws.readJson(join("events", `${kind}.json`)).suppressed).toBe(true);
      // Quiet kinds are not enqueued at all; lifecycle outcomes and completion are delivered.
      expect(
        ws
          .events()
          .filter((event) => QUIET.includes(String(event.kind)) && event.id !== event.kind),
      ).toEqual([]);
      for (const kind of [
        "attempt",
        "push",
        "deploy_failure",
        "ci_success",
        "deploy_success",
        "complete",
      ]) {
        expect(kinds(ws), kind).toContain(kind);
      }
      expect(messages.length).toBe(ws.events().filter((event) => event.sent === true).length);
    },
  );

  contract("blocked events for one attempt deduplicate across stages", async () => {
    const ws = workspace();
    bus(ws);
    ws.updateControl((c) => {
      c.docker = { gateFail: true };
      c.codex = { fail: true };
    });
    impl.offer(ws, ["bus/feature"]);
    const runner = start(ws);
    await runner.until(() =>
      QUEUE_MODEL
        ? runner.output().stdout.includes("kept branch batch-")
        : kinds(ws).some((kind) => kind.startsWith("blocked-")),
    );
    await sleep(500);
    await runner.stop();
    const blocked = ws.events().filter((event) => String(event.kind).startsWith("blocked-"));
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.kind).toBe("blocked-full-gate");
  });

  retiredOnNode(
    "events flush inside the runner; there is no detached flusher",
    "detached-flush",
    "a blocked delivery holds no runner or loop lock",
    async () => {
      const ws = workspace();
      bus(ws);
      // A zero limit against the real host load forces a load block.
      ws.hostLoad = "real";
      ws.config.resources = { cpus: 4, maxWorkers: 4, loadLimit: 0 };
      const gate = join(ws.root, "hold-delivery");
      writeFileSync(gate, "");
      ws.updateControl((c) => (c.codex = { blockWhile: gate }));
      impl.offer(ws, ["bus/feature"]);
      const runner = start(ws);
      await runner.until(() => kinds(ws).includes("blocked-load"));
      await runner.until(() => ws.read("active-departure") === "");
      await runner.terminateLeader();
      await sleep(300);
      try {
        // The detached flush is still delivering.
        await expect(hold(ws.path("events", "dispatch.lock"), "5>>")).rejects.toThrow();
        for (const name of ["runner.lock", "loop.lock"])
          await (await hold(ws.path(name), "5>>")).release();
      } finally {
        rmSync(gate);
        await runner.stop();
      }
    },
  );

  queueModel(
    "long Unicode delivery fits 900 UTF-8 bytes including the event ID; local metadata is retained",
    async () => {
      const ws = workspace();
      bus(ws);
      // A zero limit against the real host load forces a load block.
      ws.hostLoad = "real";
      ws.config.resources = { cpus: 4, maxWorkers: 4, loadLimit: 0 };
      ws.queue([`bus/${"漢🙂é".repeat(200)}`]);
      const runner = start(ws);
      await runner.until(() => ws.calls("codex").length >= 2);
      await runner.stop();
      for (const message of delivered(ws)) {
        expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(900);
        expect(message).toMatch(/ \[bus event [0-9a-f]{12}\]$/);
        expect(message.startsWith("Fixture bus: ")).toBe(true);
      }
      const attempt = ws.events().find((event) => event.kind === "attempt")!;
      expect(Buffer.byteLength(String(attempt.message), "utf8")).toBeGreaterThan(900);
    },
  );
});
