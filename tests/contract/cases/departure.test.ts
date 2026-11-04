// Scheduled departures through the resident runner with fake Git, Docker, GitHub and Wrangler
// (from tests/verify-scripts.py). Every case drives `run` under the virtual clock.
import { readFileSync } from "node:fs";
import { expect } from "vitest";

import { execute, impl, type Resident, startRunner } from "../lib/adapter.ts";
import {
  CI_POLL_SECONDS,
  contract,
  hardened,
  QUEUE_MODEL,
  queueModel,
  suite,
  workspaces,
} from "../lib/cases.ts";
import { hold } from "../lib/locks.ts";
import { at, sleep } from "../lib/time.ts";
import { BASE, SHA, type Workspace } from "../lib/workspace.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));
const REPAIR = "bus/ci-repair";

/** verify-scripts configuration: wrangler deploys, a departure every virtual minute, events kept local. */
function bus(ws: Workspace, options: { github?: string; reports?: boolean } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  if (options.reports ?? true) {
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "codex",
      roles: { monitor: { conversations: { codex: MONITOR } } },
    });
    ws.config.reports = { project: "Fixture", recipient: "monitor" };
    // The legacy Codex queue sink fails, so events stay in the local outbox for inspection.
    ws.updateControl((c) => (c.codex = { fail: true }));
  }
}

function pushes(ws: Workspace): number {
  return ws.calls("git").filter((call) => call.args.includes("push")).length;
}

/**
 * Gate container steps: one install and one full gate per gated tree. 0.9 runs each as its own
 * `docker run`; 1.0 runs them as `docker exec` steps in one created container.
 */
function containers(ws: Workspace) {
  return ws.calls("docker").filter((call) => {
    if (call.args[0] === "run") return true;
    if (call.args[0] !== "exec") return false;
    const script = call.args.at(-1) ?? "";
    return script.startsWith("set -e") || script.startsWith("cd /tmp/work && ");
  });
}

function deploys(ws: Workspace) {
  return ws
    .calls()
    .filter(
      (call) => call.tool === "wrangler" || (call.tool === "node" && call.args.includes("deploy")),
    );
}

function kinds(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.kind));
}

function blockedEvent(ws: Workspace): boolean {
  return kinds(ws).some((kind) => kind.startsWith("blocked-"));
}

async function departOnce(ws: Workspace, done: () => boolean, speed = 30): Promise<Resident> {
  ws.setClock(at(59, 58), speed);
  const runner = startRunner(ws);
  await runner.until(done, 30_000);
  return runner;
}

function prepareRepair(ws: Workspace): string {
  const approval = ws.path("ci-repair-approval");
  ws.remoteHead = BASE;
  ws.write("last-push.sha", BASE + "\n");
  ws.write(`ci/${BASE}.status`, "failure\n");
  ws.write("ci-repair-approval", `${BASE}\n${REPAIR}\n${SHA}\n`);
  ws.queue([REPAIR]);
  return approval;
}

suite("departure", () => {
  const workspace = workspaces();

  contract("a documentation-only batch skips deployment; a mixed batch deploys", async () => {
    for (const [files, deployed] of [
      ["README.md\nart/inventory.md", false],
      ["README.md\npublic/art/images/example.png", true],
    ] as const) {
      const ws = workspace();
      bus(ws);
      ws.updateControl((c) => (c.git = { files }));
      impl.offer(ws, ["bus/docs"]);
      const runner = await departOnce(
        ws,
        () =>
          kinds(ws).includes("push") &&
          kinds(ws).includes(deployed ? "deploy_success" : "deploy_skipped"),
      );
      await runner.stop();
      expect(deploys(ws).length > 0, files).toBe(deployed);
      if (!deployed) {
        expect(ws.read("last-deploy-skipped.sha").trim()).toBe(SHA);
        expect(kinds(ws)).toContain("deploy_skipped");
      }
    }
  });

  contract(
    "a failed deployment retains the gated build and retries without another gate or push",
    async () => {
      const ws = workspace();
      bus(ws);
      ws.updateControl((c) => (c.wrangler = { fail: true }));
      impl.offer(ws, ["bus/feature"]);
      const runner = await departOnce(
        ws,
        () => ws.exists("deploy-pending") && kinds(ws).includes("deploy_failure"),
      );
      const [pendingSha, work] = ws.read("deploy-pending").split("\n");
      expect(pendingSha).toBe(SHA);
      expect(readFileSync(`${work}/.bus-built.sha`, "utf8").trim()).toBe(SHA);
      expect(containers(ws).length).toBe(2);
      expect(pushes(ws)).toBe(1);
      const deploy = deploys(ws)[0]!.args;
      expect(deploy).toEqual(expect.arrayContaining(["--tag", "--message", "--no-bundle"]));
      ws.updateControl((c) => (c.wrangler = {}));
      // The pointer moves before the success event is written; wait for both.
      await runner.until(
        () => !ws.exists("deploy-pending") && kinds(ws).includes("deploy_success"),
        30_000,
      );
      await runner.stop();
      expect(ws.read("last-deploy.sha").trim()).toBe(SHA);
      expect(ws.exists("deploy", `${SHA}.completed`)).toBe(true);
      expect(containers(ws).length).toBe(2);
      expect(pushes(ws)).toBe(1);
      expect(kinds(ws)).toEqual(expect.arrayContaining(["deploy_failure", "deploy_success"]));
    },
  );

  contract("deployment mode none leaves deployment state and commands untouched", async () => {
    const ws = workspace();
    bus(ws);
    ws.config.deploy = { mode: "none", skipPattern: "(\\.md$|^art/|^gameplay/)" };
    ws.write("last-deploy.sha", "c".repeat(40) + "\n");
    impl.offer(ws, ["bus/feature"]);
    const runner = await departOnce(ws, () => kinds(ws).includes("push"));
    await sleep(500);
    const result = await runner.stop();
    expect(deploys(ws)).toEqual([]);
    expect(ws.exists("deploy-pending")).toBe(false);
    expect(ws.read("last-deploy.sha")).toBe("c".repeat(40) + "\n");
    expect(result.stdout).toContain(`deployment disabled for ${SHA}`);
  });

  for (const failure of ["gateFail", "installFail"] as const) {
    contract(
      `a failed ${failure === "gateFail" ? "gate" : "install"} never pushes, stages deployment or deletes the batch branch`,
      async () => {
        const ws = workspace();
        bus(ws);
        ws.updateControl((c) => (c.docker = { [failure]: true }));
        impl.offer(ws, ["bus/test-input"]);
        const runner = await departOnce(ws, () =>
          kinds(ws).includes("blocked-" + (failure === "gateFail" ? "full-gate" : "install")),
        );
        if (QUEUE_MODEL)
          await runner.until(() => runner.output().stdout.includes("kept branch batch-"));
        const result = await runner.stop();
        expect(pushes(ws)).toBe(0);
        expect(ws.exists("deploy-pending")).toBe(false);
        expect(deploys(ws)).toEqual([]);
        if (QUEUE_MODEL) expect(result.stdout).toContain("kept branch batch-");
        expect(
          ws.calls("git").some((call) => call.args.includes("branch") && call.args.includes("-D")),
        ).toBe(false);
      },
    );
  }

  for (const [title, setup, rejectedAtDeparture] of [
    [
      "a branch tip other than the approved one",
      (ws: Workspace) => ws.updateControl((c) => (c.git = { branchTip: "8".repeat(40) })),
      true,
    ],
    ["an extra queued branch", (ws: Workspace) => ws.queue([REPAIR, "bus/extra"]), true],
    [
      "a remote base other than the failed push",
      (ws: Workspace) => (ws.remoteHead = "7".repeat(40)),
      true,
    ],
    [
      "a failed gate",
      (ws: Workspace) => ws.updateControl((c) => (c.docker = { gateFail: true })),
      false,
    ],
    [
      "a failed push",
      (ws: Workspace) => ws.updateControl((c) => (c.git = { pushFail: true })),
      false,
    ],
    [
      "a base moved during the gate",
      (ws: Workspace) => ws.updateControl((c) => (c.docker = { moveBase: true })),
      false,
    ],
    [
      "an approval changed during the gate",
      (ws: Workspace) =>
        ws.updateControl((c) => (c.docker = { changeApproval: ws.path("ci-repair-approval") })),
      false,
    ],
    [
      "a scratch tree other than the approved tip",
      (ws: Workspace) => ws.updateControl((c) => (c.git = { wrongTree: "0".repeat(40) })),
      false,
    ],
  ] as const) {
    queueModel(`repair approval rejects ${title} and preserves the approval`, async () => {
      const ws = workspace();
      bus(ws);
      prepareRepair(ws);
      setup(ws);
      const queued = ws.read("bus-queue");
      const runner = await departOnce(ws, () => blockedEvent(ws));
      await runner.stop();
      expect(ws.exists("ci-repair-approval")).toBe(true);
      expect(ws.exists("ci-repair-approval.consumed")).toBe(false);
      if (title !== "a failed push") expect(pushes(ws)).toBe(0);
      if (rejectedAtDeparture) {
        // A red departure validates its complete queue before draining it.
        expect(ws.read("bus-queue")).toBe(queued);
        expect(containers(ws)).toEqual([]);
      }
    });
  }

  queueModel(
    "a one-shot repair requires the full gate, is consumed only after push and rejects replay",
    async () => {
      const ws = workspace();
      bus(ws);
      prepareRepair(ws);
      const runner = await departOnce(
        ws,
        () => ws.exists("ci-repair-approval.consumed") && kinds(ws).includes("push"),
      );
      await runner.stop();
      expect(ws.exists("ci-repair-approval")).toBe(false);
      expect(ws.read("bus-queue")).toBe("");
      expect(containers(ws).length).toBe(2);
      expect(pushes(ws)).toBe(1);
      expect(ws.read(`ci/${BASE}.status`).trim()).toBe("failure");
      // Reintroducing the same approval cannot reuse it, even with the remote reset.
      ws.remoteHead = BASE;
      ws.write("last-push.sha", BASE + "\n");
      ws.write("ci-repair-approval", ws.read("ci-repair-approval.consumed"));
      ws.queue([REPAIR]);
      ws.clearCalls();
      const replay = await departOnce(ws, () => kinds(ws).includes("blocked-CI"));
      await replay.stop();
      expect(pushes(ws)).toBe(0);
      expect(containers(ws)).toEqual([]);
      expect(ws.exists("ci-repair-approval")).toBe(true);
      expect(ws.exists("ci-repair-approval.consumed")).toBe(true);
    },
  );

  contract(
    "run accepts no departure arguments and enforces singleton runner and loop locks",
    async () => {
      const ws = workspace();
      bus(ws);
      expect((await execute(impl.command(ws, ["run", "--now"]))).code).toBe(2);
      ws.setClock(at(30), 1);
      ws.write("loop.lock", "");
      const loop = await hold(ws.path("loop.lock"));
      try {
        const result = await execute(impl.run(ws), { timeoutMs: 10_000 });
        expect(result.code).toBe(1);
      } finally {
        await loop.release();
      }
      const runner = await hold(ws.path("runner.lock"));
      try {
        const result = await execute(impl.run(ws), { timeoutMs: 10_000 });
        expect(result.code).toBe(1);
      } finally {
        await runner.release();
      }
      expect(containers(ws)).toEqual([]);
    },
  );

  contract(
    "a high-load departure retains its queue and persists attempt and blocked events",
    async () => {
      const ws = workspace();
      bus(ws);
      // A zero limit against the real host load forces a load block.
      ws.hostLoad = "real";
      ws.config.resources = { cpus: 4, maxWorkers: 4, loadLimit: 0 };
      impl.offer(ws, ["bus/queued"]);
      const runner = await departOnce(ws, () => kinds(ws).includes("blocked-load"));
      await runner.stop();
      if (QUEUE_MODEL) expect(ws.read("bus-queue")).toBe("bus/queued\n");
      expect(new Set(kinds(ws))).toEqual(new Set(["attempt", "blocked-load"]));
      expect(containers(ws)).toEqual([]);
    },
  );

  contract("empty scheduled departures add no events", async () => {
    const ws = workspace();
    bus(ws);
    impl.offer(ws, []);
    ws.setClock(at(59, 58), 60);
    const runner = startRunner(ws);
    await runner.until(() => ws.virtualNow() >= at(3, 0, 1), 20_000);
    await runner.stop();
    expect(ws.events()).toEqual([]);
    expect(ws.calls("git").some((call) => call.args.includes("worktree"))).toBe(false);
  });

  for (const [title, runs, status, event] of [
    [
      "success",
      [{ id: 1, name: "Test", status: "completed", conclusion: "success" }],
      "success",
      "ci_success",
    ],
    [
      "failure",
      [{ id: 1, name: "Test", status: "completed", conclusion: "failure" }],
      "failure",
      "ci_failure",
    ],
    [
      "an unrelated failed workflow",
      [
        { id: 1, name: "Test", status: "completed", conclusion: "success" },
        { id: 2, name: "Unrelated workflow", status: "completed", conclusion: "failure" },
      ],
      "failure",
      "ci_failure",
    ],
    [
      "a timeout while any run is incomplete",
      [
        { id: 1, name: "Test", status: "completed", conclusion: "success" },
        { id: 2, name: "Unrelated workflow", status: "in_progress", conclusion: null },
      ],
      "timeout",
      "ci_timeout",
    ],
  ] as const) {
    contract(`the exact-commit CI watch records ${title}`, async () => {
      const ws = workspace();
      bus(ws, { github: "fixture/project" });
      ws.config.deploy = { mode: "none", skipPattern: "" };
      ws.config.ci = { requiredNames: ["Test"], pollSeconds: CI_POLL_SECONDS, timeoutSeconds: 1 };
      ws.updateControl((c) => (c.gh = { checks: { [SHA]: [...runs] } }));
      impl.offer(ws, ["bus/feature"]);
      const runner = await departOnce(
        ws,
        () =>
          ws.exists("ci", `${SHA}.status`) &&
          ws.read("ci", `${SHA}.status`).trim() === status &&
          kinds(ws).includes(event),
      );
      await runner.stop();
      expect(
        ws
          .calls("gh")
          .every((call) => call.args.some((arg) => arg.includes(`/commits/${SHA}/check-runs`))),
      ).toBe(true);
      expect(ws.calls("gh").length).toBeGreaterThan(0);
    });
  }

  contract("a detached CI watch does not hold the runner, loop or merge locks", async () => {
    const ws = workspace();
    bus(ws, { github: "fixture/project" });
    ws.config.deploy = { mode: "none", skipPattern: "" };
    ws.config.ci = { requiredNames: ["Test"], pollSeconds: 1, timeoutSeconds: 30 };
    ws.updateControl(
      (c) =>
        (c.gh = { default: [{ id: 1, name: "Test", status: "in_progress", conclusion: null }] }),
    );
    impl.offer(ws, ["bus/feature"]);
    const runner = await departOnce(
      ws,
      () => ws.exists("ci", `${SHA}.status`) && ws.read("ci", `${SHA}.status`).trim() === "running",
    );
    // Let the departure itself finish; only the detached watcher should remain.
    await runner.until(
      () =>
        runner.output().stdout.includes("landed bus/feature") && ws.read("active-departure") === "",
    );
    await runner.terminateLeader();
    await sleep(300);
    try {
      // merge.lock is the 0.9 batch lock; 1.0 has no batch.
      for (const name of ["runner.lock", "loop.lock", ...(QUEUE_MODEL ? ["merge.lock"] : [])]) {
        const probe = await hold(ws.path(name), "5>>");
        await probe.release();
      }
      expect(ws.read("ci", `${SHA}.status`).trim()).toBe("running");
    } finally {
      await runner.stop();
    }
  });

  contract("the resource report is reporting only", async () => {
    const ws = workspace();
    bus(ws);
    const result = await execute(impl.resourceReport(ws));
    expect(result.code, result.stderr).toBe(0);
    expect(ws.calls("git")).toEqual([]);
    expect(ws.calls("docker").map((call) => call.args[0])).toEqual(["ps"]);
  });

  hardened("push and deployment stamps are replaced by rename, never rewritten in place", {
    node: async () => {
      const ws = workspace();
      bus(ws);
      const stamps = ["last-push", "last-push.sha", "last-deploy", "last-deploy.sha"];
      for (const name of stamps) ws.write(name, "old\n");
      const before = Object.fromEntries(stamps.map((name) => [name, ws.inode(name)]));
      impl.offer(ws, ["bus/feature"]);
      const runner = await departOnce(ws, () => ws.read("last-deploy.sha").trim() === SHA);
      await runner.stop();
      for (const name of stamps) expect(ws.inode(name), name).not.toBe(before[name]);
      expect(ws.list().filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    bash: async () => {
      // 0.9 truncates these stamps in place (no temp file, no fsync).
      const ws = workspace();
      bus(ws);
      const stamps = ["last-push", "last-push.sha", "last-deploy", "last-deploy.sha"];
      for (const name of stamps) ws.write(name, "old\n");
      const before = Object.fromEntries(stamps.map((name) => [name, ws.inode(name)]));
      impl.offer(ws, ["bus/feature"]);
      const runner = await departOnce(ws, () => ws.read("last-deploy.sha").trim() === SHA);
      await runner.stop();
      for (const name of stamps) expect(ws.inode(name), name).toBe(before[name]);
      expect(ws.read("last-push.sha").trim()).toBe(SHA);
    },
  });
});
