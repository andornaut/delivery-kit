// User-authorized one-off requests with real scratch Git (from tests/test_requests.py).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { execute, impl, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { hold } from "../lib/locks.ts";
import { at, sleep } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";

interface RequestRecord {
  id: string;
  state: string;
  entries: Array<[string, string]>;
  departure_exit?: number;
  reason?: string;
  completion?: string;
}

function setup(ws: Workspace, options: { reports?: boolean; mode?: "none" | "wrangler" } = {}): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: "", github: "" },
    schedule: { departures: ["00"], timezone: "UTC" },
    gate: { image: "unused", install: "", steps: [{ name: "test", run: "true" }] },
    resources: { cpus: 4, maxWorkers: 4, loadLimit: 1000000 },
    deploy: { mode: options.mode ?? "none", skipPattern: "" },
    reports: {},
  };
  if (options.reports) {
    ws.writeRegistry({ schema: 1, revision: 1, harness: "codex", roles: { monitor: { conversations: { codex: MONITOR } } } });
    ws.config.reports = { project: "Fixture", recipient: "monitor" };
  }
  // Queued branches carry a commit: an empty cherry-pick range is an integration failure.
  ws.git("checkout", "-q", "-b", "bus/feature");
  ws.commit("feature work", { feature: "work" });
  ws.git("checkout", "-q", "main");
  ws.queue(["bus/feature", "bus/feature"]);
}

function record(ws: Workspace, id = "one"): RequestRecord {
  return ws.readJson<RequestRecord>("requests", `${id}.json`);
}

async function capture(ws: Workspace, id: string) {
  return execute(impl.request(ws, id));
}

/** Docker calls other than the resource reporter's `docker ps`. */
function containers(ws: Workspace) {
  return ws.calls("docker").filter((call) => call.args[0] !== "ps");
}

function gates(ws: Workspace): number {
  return ws.calls("docker").filter((call) => call.args.includes("--network")).length;
}

suite("requests", () => {
  const workspace = workspaces();

  contract("concurrent capture is idempotent and the runner claims a request once", async () => {
    const ws = workspace({ realGit: true });
    setup(ws);
    const tip = ws.git("rev-parse", "bus/feature");
    const captures = await Promise.all(Array.from({ length: 8 }, () => capture(ws, "one")));
    expect(captures.map((r) => r.code)).toEqual(Array(8).fill(0));
    expect(new Set(captures.map((r) => r.stdout)).size).toBe(1);
    expect(record(ws).entries).toEqual([["bus/feature", tip]]);
    expect(record(ws).state).toBe("pending");
    ws.setClock(at(1), 60);
    const runner = startRunner(ws);
    await runner.until(() => record(ws).state === "finished");
    await sleep(500);
    const result = await runner.stop();
    expect(gates(ws), result.stdout + result.stderr).toBe(1);
    expect(record(ws).departure_exit).toBe(0);
    expect(record(ws).completion).toBe("departure flow only; consult exact-commit CI and deployment state");
    expect(JSON.parse((await capture(ws, "one")).stdout).state).toBe("finished");
  });

  contract("a started request found at runner start becomes interrupted and is never claimed again", async () => {
    const ws = workspace({ realGit: true });
    setup(ws);
    expect((await capture(ws, "one")).code).toBe(0);
    const gate = join(ws.root, "hold-gate");
    writeFileSync(gate, "");
    ws.updateControl((c) => (c.docker = { blockWhile: gate }));
    ws.setClock(at(1), 60);
    const first = startRunner(ws);
    await first.until(() => record(ws).state === "started" && containers(ws).length > 0);
    await first.stop();
    rmSync(gate);
    ws.clearCalls();
    const second = startRunner(ws);
    await second.until(() => record(ws).state === "interrupted");
    await sleep(500);
    await second.stop();
    expect(containers(ws)).toEqual([]);
    expect(JSON.parse((await capture(ws, "one")).stdout).state).toBe("interrupted");
  });

  contract("capture takes the queue lock before the request lock", async () => {
    const ws = workspace({ realGit: true });
    setup(ws);
    expect((await capture(ws, "one")).code).toBe(0);
    ws.write("bus-queue.lock", "");
    const queue = await hold(ws.path("bus-queue.lock"), "5>>");
    const pending = capture(ws, "two");
    await sleep(300);
    // A validator holding the queue lock can still take the request lock: no deadlock.
    const requests = await hold(ws.path("requests", "requests.lock"), "5>>");
    await requests.release();
    expect(existsSync(ws.path("requests", "two.json"))).toBe(false);
    await queue.release();
    expect((await pending).code).toBe(0);
    expect(record(ws, "two").state).toBe("pending");
  });

  for (const change of ["queue", "tip"] as const) {
    contract(`a changed ${change} after capture rejects the request without consuming the queue`, async () => {
      const ws = workspace({ realGit: true });
      setup(ws);
      ws.queue(["bus/feature"]);
      expect((await capture(ws, change)).code).toBe(0);
      if (change === "queue") ws.queue(["bus/feature", "main"]);
      else {
        ws.git("checkout", "-q", "bus/feature");
        ws.commit("next");
        ws.git("checkout", "-q", "main");
      }
      const before = ws.read("bus-queue");
      ws.setClock(at(1), 60);
      const runner = startRunner(ws);
      await runner.until(() => record(ws, change).state === "rejected");
      await runner.stop();
      expect(record(ws, change).reason).toBe("queue or branch tips changed");
      expect(ws.read("bus-queue")).toBe(before);
      expect(containers(ws)).toEqual([]);
    });
  }

  contract("a queue change between the departure's two queue reads rejects the request", async () => {
    const ws = workspace({ realGit: true });
    setup(ws, { mode: "wrangler" });
    expect((await capture(ws, "one")).code).toBe(0);
    // A pending deployment retry runs between the reads; its deploy appends to the queue.
    const head = ws.git("rev-parse", "main");
    const work = join(ws.state, "batch-retained");
    ws.git("worktree", "add", "-q", "-b", "batch-retained", work, "main");
    mkdirSync(join(work, "dist"));
    writeFileSync(join(work, ".bus-built.sha"), head + "\n");
    ws.write("deploy-pending", `${head}\n${work}\nbatch-retained\n`);
    ws.updateControl((c) => (c.wrangler = { append: [ws.path("bus-queue"), "main\n"] }));
    ws.setClock(at(1), 60);
    const runner = startRunner(ws);
    await runner.until(() => record(ws).state === "rejected");
    await runner.stop();
    expect(ws.read("bus-queue")).toBe("bus/feature\nbus/feature\nmain\n");
    expect(gates(ws)).toBe(0);
  });

  contract("a failed request finishes once and a later scheduled departure carries no request context", async () => {
    const ws = workspace({ realGit: true });
    setup(ws, { reports: true });
    ws.updateControl((c) => {
      c.docker = { gateFail: true };
      c.codex = { fail: true };
    });
    expect((await capture(ws, "one")).code).toBe(0);
    ws.setClock(at(59, 30), 5);
    const runner = startRunner(ws);
    await runner.until(() => record(ws).state === "finished");
    ws.updateControl((c) => (c.docker = {}));
    ws.git("checkout", "-q", "-b", "bus/later");
    ws.commit("later work", { later: "work" });
    ws.git("checkout", "-q", "main");
    ws.queue(["bus/later"]);
    await runner.until(() => ws.events().filter((e) => e.kind === "attempt").length === 2, 30_000);
    await runner.until(() => !ws.git("branch", "--list", "bus/later"));
    await runner.stop();
    expect(record(ws).departure_exit).toBe(1);
    const attempts = ws.events().filter((e) => e.kind === "attempt");
    expect(attempts[0]!.key).toBe("request-one");
    // A scheduled attempt is keyed by its departure epoch, at or just after the slot.
    expect(Number(attempts[1]!.key) - at(0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(Number(attempts[1]!.key) - at(0, 0, 1)).toBeLessThan(60);
    expect(attempts[0]!.message).toContain("user-authorized one-off request one");
    expect(attempts[1]!.message).toContain("scheduled attempt: bus/later");
    expect(attempts[1]!.message).not.toContain("request");
    expect(ws.events().some((e) => e.kind === "blocked" || String(e.kind).startsWith("blocked-"))).toBe(true);
    expect(JSON.parse((await capture(ws, "one")).stdout).state).toBe("finished");
  });

  for (const duration of [0, 40, 120]) {
    contract(`a ${duration}s request keeps the hourly deadline and skips a crossed slot`, async () => {
      const ws = workspace({ realGit: true });
      setup(ws);
      ws.queue(["bus/feature"]);
      expect((await capture(ws, "one")).code).toBe(0);
      if (duration) ws.updateControl((c) => (c.docker = { advanceClock: duration }));
      // Thirty seconds before the next hourly slot; a 40s or 120s request crosses it.
      const start = at(59, 30);
      ws.setClock(start, 10);
      const runner = startRunner(ws);
      await runner.until(() => ws.virtualNow() >= start + 160, 40_000);
      const result = await runner.stop();
      expect(record(ws).state).toBe("finished");
      expect(gates(ws)).toBe(1);
      // The slot after the request runs only when the request finished before it.
      const slot = `${new Date((start + 30) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC bus: nothing waiting`;
      expect(result.stdout.includes(slot), result.stdout).toBe(duration === 0);
    });
  }

  contract("a request integrates its captured tip and retains a branch advanced during the gate", async () => {
    const ws = workspace({ realGit: true });
    setup(ws);
    ws.commitOnto("bus/feature", "feature", { value: "captured" });
    expect((await capture(ws, "one")).code).toBe(0);
    const gate = join(ws.root, "hold-gate");
    writeFileSync(gate, "");
    ws.updateControl((c) => (c.docker = { blockWhile: gate }));
    ws.setClock(at(1), 60);
    const runner = startRunner(ws);
    // Validation passed and the queue was consumed; the branch advances while the gate runs.
    await runner.until(() => containers(ws).length > 0);
    const advanced = ws.commitOnto("bus/feature", "later", { value: "advanced" });
    rmSync(gate);
    await runner.until(() => record(ws).state === "finished");
    await runner.stop();
    expect(record(ws).departure_exit).toBe(0);
    expect(ws.git("show", "main:value")).toBe("captured");
    expect(ws.git("rev-parse", "bus/feature")).toBe(advanced);
  });

  contract("the public request command captures only and refuses invalid or empty requests", async () => {
    const ws = workspace({ realGit: true });
    setup(ws);
    for (const id of ["../escape", "-option", "a".repeat(65)]) {
      expect((await capture(ws, id)).code).not.toBe(0);
    }
    const first = await capture(ws, "one");
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).state).toBe("pending");
    expect(containers(ws)).toEqual([]);
    ws.queue([]);
    expect(JSON.parse((await capture(ws, "one")).stdout).state).toBe("pending");
    expect((await capture(ws, "empty")).code).not.toBe(0);
    expect(existsSync(ws.path("requests", "empty.json"))).toBe(false);
  });

  contract("a missing ref is reported while valid queued work still integrates", async () => {
    const ws = workspace({ realGit: true });
    setup(ws, { reports: true });
    ws.updateControl((c) => (c.codex = { fail: true }));
    ws.git("checkout", "-q", "bus/feature");
    ws.commit("feature", { value: "valid work" });
    ws.git("checkout", "-q", "main");
    ws.queue(["bus/missing", "bus/feature"]);
    ws.setClock(at(59, 55), 60);
    const runner = startRunner(ws);
    await runner.until(() => ws.events().some((e) => e.kind === "push") && !ws.git("branch", "--list", "bus/feature"));
    const result = await runner.stop();
    expect(ws.git("show", "main:value")).toBe("valid work");
    const resolution = ws.events().find((e) => e.kind === "resolution-bus/missing");
    expect(resolution?.message).toContain("merge-base");
    expect(resolution?.message).toContain("exit 128");
    expect(result.stdout).toContain("bus/missing");
    expect(ws.events().find((e) => e.kind === "push")?.message).toContain("bus/feature");
    // The valid branch completed normal cleanup after landing.
    expect(ws.git("branch", "--list", "bus/feature")).toBe("");
  });
});
