// Scheduled departures through the resident runner with fake Git, Docker, GitHub and Wrangler
//. Every case drives `run` under the virtual clock.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { expect } from "vitest";

import { execute, impl, type Resident, startRunner } from "../lib/adapter.ts";
import { CASE_TIMEOUT_MS, contract, suite, workspaces } from "../lib/cases.ts";
import { hold } from "../lib/locks.ts";
import { at, LOAD_WAIT_SECONDS, sleep } from "../lib/time.ts";
import { SHA, type Workspace } from "../lib/workspace.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));
const WRANGLER = "node_modules/wrangler/bin/wrangler.js";

/** The gate outputs 1.0 copies out of its container with docker cp. */
function copiedOut(ws: Workspace): string[] {
  return ws
    .calls("docker")
    .filter((call) => call.args[0] === "cp")
    .map((call) => call.args.at(-2) ?? "")
    .map((source) => source.slice(source.indexOf(":") + 1));
}

/** verify-scripts configuration: wrangler deploys, a departure every virtual minute, events kept local. */
function bus(ws: Workspace, options: { github?: string; reports?: boolean } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  if (options.reports ?? true) {
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "codex",
      roles: { "game-coordinator": { conversations: { codex: RECIPIENT } } },
    });
    ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
  }
}

function pushes(ws: Workspace): number {
  return ws.calls("git").filter((call) => call.args.includes("push")).length;
}

/**
 * Gate container steps: one install and one full gate per gated tree, run as `docker exec` steps
 * in one created container.
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
  return ws.calls("wrangler");
}

function kinds(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.kind));
}

async function departOnce(ws: Workspace, done: () => boolean, speed = 30): Promise<Resident> {
  ws.setClock(at(59, 58), speed);
  const runner = startRunner(ws);
  await runner.until(done, 30_000);
  return runner;
}

suite("departure", () => {
  const workspace = workspaces();

  contract(
    "a push whose every changed path matches skipPattern skips deployment; a mixed push deploys",
    async () => {
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
    },
  );

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
      // The gated install's Wrangler is in the retained worktree, beside dist/.
      expect(existsSync(`${work}/${WRANGLER}`)).toBe(true);
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

  contract("a passing gate provides the deployed Wrangler from its own install", async () => {
    const ws = workspace();
    bus(ws);
    impl.offer(ws, ["bus/feature"]);
    const runner = await departOnce(ws, () => kinds(ws).includes("deploy_success"));
    await runner.stop();
    expect(deploys(ws).length).toBe(1);
    expect(copiedOut(ws)).toEqual([
      "/tmp/gate-logs/.",
      "/tmp/work/dist/.",
      "/tmp/work/node_modules/.",
    ]);
    // Copied after the gate script and before the deployment.
    const calls = ws.calls();
    const gate = calls.findIndex(
      (call) => call.tool === "docker" && (call.args.at(-1) ?? "").startsWith("set -e"),
    );
    const copy = calls.findIndex(
      (call) =>
        call.tool === "docker" && (call.args.at(-2) ?? "").endsWith(":/tmp/work/node_modules/."),
    );
    const deploy = calls.findIndex((call) => call.tool === "wrangler");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(gate);
    expect(deploy).toBeGreaterThan(copy);
  });

  contract(
    "a gated worktree without Wrangler is not deployed and keeps its pending deployment",
    async () => {
      const ws = workspace();
      bus(ws);
      ws.updateControl((c) => (c.docker = { noWrangler: true }));
      impl.offer(ws, ["bus/feature"]);
      const runner = await departOnce(
        ws,
        () => ws.exists("deploy-pending") && kinds(ws).includes("deploy_failure"),
      );
      const result = await runner.stop();
      const [pendingSha, work] = ws.read("deploy-pending").split("\n");
      expect(pendingSha).toBe(SHA);
      expect(existsSync(`${work}/dist`)).toBe(true);
      expect(existsSync(`${work}/${WRANGLER}`)).toBe(false);
      expect(deploys(ws)).toEqual([]);
      expect(kinds(ws)).not.toContain("deploy_success");
      expect(result.stdout).toContain(
        `deployment of ${SHA} refused: ${WRANGLER} is missing from the gated worktree`,
      );
    },
  );

  contract(
    "a deployment that cannot be staged after a push is reported as deploy_failure",
    async () => {
      const ws = workspace();
      bus(ws);
      // A directory where the deploy-pending record belongs makes staging fail after the push.
      mkdirSync(ws.path("deploy-pending"));
      impl.offer(ws, ["bus/feature"]);
      const runner = await departOnce(ws, () => kinds(ws).includes("deploy_failure"));
      await runner.stop();
      expect(pushes(ws)).toBe(1);
      const failure = ws.events().find((event) => event.kind === "deploy_failure");
      expect(String(failure?.message)).toContain(`Deployment of pushed ${SHA} could not be staged`);
      expect(deploys(ws)).toEqual([]);
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

  contract(
    "a failed gate or install never pushes or stages deployment",
    async () => {
      for (const failure of ["gateFail", "installFail"] as const) {
        const ws = workspace();
        bus(ws);
        ws.updateControl((c) => (c.docker = { [failure]: true }));
        impl.offer(ws, ["bus/test-input"]);
        const runner = await departOnce(ws, () =>
          kinds(ws).includes("blocked-" + (failure === "gateFail" ? "full-gate" : "install")),
        );
        await runner.stop();
        expect(pushes(ws), failure).toBe(0);
        expect(ws.exists("deploy-pending"), failure).toBe(false);
        expect(deploys(ws), failure).toEqual([]);
        // Only the gate logs are copied out of a failed gate.
        const outputs = copiedOut(ws).filter((source) => source !== "/tmp/gate-logs/.");
        expect(outputs, failure).toEqual([]);
      }
    },
    CASE_TIMEOUT_MS,
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
    "a high-load departure waits out the load window, then keeps main unpushed and reports it",
    async () => {
      const ws = workspace();
      bus(ws);
      // A zero limit against the real host load forces a load block.
      ws.hostLoad = "real";
      ws.config.resources = { cpus: 4, loadLimit: 0, memoryMiB: 4096 };
      impl.offer(ws, ["bus/queued"]);
      const runner = await departOnce(ws, () => kinds(ws).includes("attempt"));
      // Over a virtual minute later the departure is still re-checking the load.
      await sleep(3_000);
      expect(kinds(ws)).toEqual(["attempt"]);
      ws.advanceClock(LOAD_WAIT_SECONDS);
      await runner.until(() => kinds(ws).includes("blocked-load"));
      await runner.stop();
      expect(pushes(ws)).toBe(0);
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

  const CI_OUTCOMES = [
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
      "success despite a failed unrequired run",
      [
        { id: 1, name: "Test", status: "completed", conclusion: "success" },
        { id: 2, name: "Unrelated workflow", status: "completed", conclusion: "failure" },
      ],
      "success",
      "ci_success",
    ],
    [
      "success while an unrequired run is in progress",
      [
        { id: 1, name: "Test", status: "completed", conclusion: "success" },
        { id: 2, name: "Unrelated workflow", status: "in_progress", conclusion: null },
      ],
      "success",
      "ci_success",
    ],
    [
      "a timeout while a required run is incomplete",
      [
        { id: 1, name: "Test", status: "in_progress", conclusion: null },
        { id: 2, name: "Unrelated workflow", status: "completed", conclusion: "success" },
      ],
      "timeout",
      "ci_timeout",
    ],
  ] as const;

  contract(
    "the exact-commit CI watch is decided by the required checks alone",
    async () => {
      for (const [title, runs, status, event] of CI_OUTCOMES) {
        const ws = workspace();
        bus(ws, { github: "fixture/project" });
        ws.config.deploy = { mode: "none", skipPattern: "" };
        ws.config.ci = { requiredNames: ["Test"], pollSeconds: 1, timeoutSeconds: 1 };
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
        const exact = ws
          .calls("gh")
          .every((call) => call.args.some((arg) => arg.includes(`/commits/${SHA}/check-runs`)));
        expect(exact, title).toBe(true);
        expect(ws.calls("gh").length, title).toBeGreaterThan(0);
      }
    },
    CASE_TIMEOUT_MS,
  );

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
      () => runner.output().stdout.includes(`pushed ${SHA}`) && ws.read("active-departure") === "",
    );
    await runner.terminateLeader();
    await sleep(300);
    try {
      for (const name of ["runner.lock", "loop.lock"]) {
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

  contract(
    "push and deployment stamps are replaced by rename, never rewritten in place",
    async () => {
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
  );
});
