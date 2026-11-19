// Test fixtures for the bus: a scratch game-coordinator tree whose game is a real Git checkout with a
// bare origin, fake docker, gh and Wrangler children, recorded events and a manual clock.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type GameLayout,
  gameLayout,
  type Layout,
  loadLayout,
  type ProjectConfig,
  validateProjectConfig,
} from "@andornaut/coordination-kit/build/shared";

import type { RunnerEvent, RunnerStarted } from "../events.ts";
import { makeFixture, projectConfig } from "../testFixtures.ts";
import { type BusContext, busContext, type Clock, type Events } from "./context.ts";
import { setDesiredDelivery } from "./control.ts";
import { type Exec, type ExecResult, type ExecSpec, spawnExec } from "./exec.ts";
import type { Coordinator } from "./seam.ts";
import { busPaths } from "./state.ts";
import { recordingCoordinator } from "./testCoordinator.ts";

export const GAME = "archies-dog-walks";

// Commits in fixtures need an identity; children inherit it from the environment.
Object.assign(process.env, {
  GIT_AUTHOR_EMAIL: "bus@example.invalid",
  GIT_AUTHOR_NAME: "Bus Test",
  GIT_COMMITTER_EMAIL: "bus@example.invalid",
  GIT_COMMITTER_NAME: "Bus Test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function commitFile(
  cwd: string,
  name: string,
  content: string,
  message = `change ${name}`,
): string {
  writeFileSync(join(cwd, name), content);
  gitSync(cwd, "add", "--", name);
  gitSync(cwd, "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-qm", message);
  return gitSync(cwd, "rev-parse", "HEAD");
}

export interface RecordedEvents extends Events {
  readonly list: [string, string, string][];
  readonly starts: [string, RunnerStarted][];
  ingests: number;
  opens: number;
}

export function recordingEvents(): RecordedEvents {
  const list: [string, string, string][] = [];
  const starts: [string, RunnerStarted][] = [];
  const events = {
    emit(type: string, key: string, message: string) {
      list.push([type, key, message]);
    },
    ingest() {
      events.ingests += 1;
    },
    ingests: 0,
    list,
    open() {
      events.opens += 1;
    },
    opens: 0,
    started(key: string, started: RunnerStarted) {
      starts.push([key, started]);
    },
    starts,
  };
  return events;
}

/** The events bus/events.jsonl holds, oldest first; [] when it does not exist. */
export function loggedEvents(test: TestGame): RunnerEvent[] {
  const path = busPaths(test.game.busDir).eventsLog;
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunnerEvent);
}

export interface ManualClock extends Clock {
  time: number;
}

/** A clock whose sleep advances time immediately and yields to the event loop. */
export function manualClock(start: number): ManualClock {
  const clock = {
    now: () => clock.time,
    sleep: async (seconds: number, signal?: AbortSignal) => {
      if (signal?.aborted !== true) {
        clock.time += Math.max(1, Math.ceil(seconds));
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
    time: start,
  };
  return clock;
}

export type FakeChild = (spec: ExecSpec) => ExecResult | Promise<ExecResult>;

interface FakeGateContainer {
  readonly source: string;
  readonly root: string;
  readonly work: string;
}
const gateStates = new WeakMap<ExecSpec, Map<string, FakeGateContainer>>();

export const ok = (stdout = ""): ExecResult => ({ status: 0, stderr: "", stdout });

/**
 * The container rules every docker call must follow: create and run use uid 19001 with
 * HOME=/tmp, every bind mount is read-only and there is no -v shorthand.
 */
export function assertContainerRules(spec: ExecSpec): void {
  const { args } = spec;
  const pair = (flag: string, value: string): boolean =>
    args.some((arg, index) => arg === flag && args[index + 1] === value);
  if (["create", "run"].includes(args[0] ?? "")) {
    if (!pair("--user", "19001:19001") || !pair("-e", "HOME=/tmp")) {
      throw new Error(`docker ${args[0]} must run as --user 19001:19001 with HOME=/tmp`);
    }
  }
  if (args.some((arg) => arg === "-v" || arg === "--volume")) {
    throw new Error("docker must use --mount, never -v");
  }
  args.forEach((arg, index) => {
    if (
      args[index - 1] === "--mount" &&
      arg.includes("type=bind") &&
      !/,(readonly|ro)(,|$)/.test(arg)
    ) {
      throw new Error(`writable bind mount: ${arg}`);
    }
    // A bind is readable only through its checkout's group, so the container must join it.
    const source =
      args[index - 1] === "--mount" ? /type=bind,src=([^,]+)/.exec(arg)?.[1] : undefined;
    if (source !== undefined && !pair("--group-add", String(statSync(source).gid))) {
      throw new Error(`bind of ${source} needs --group-add ${statSync(source).gid}`);
    }
  });
}

/** Real git; docker, gh and Wrangler go to `fake`, which records every call. */
export function fakeExec(fake: FakeChild): Exec & { calls: ExecSpec[] } {
  const calls: ExecSpec[] = [];
  const containers = new Map<string, FakeGateContainer>();
  const exec = (async (spec: ExecSpec) => {
    if (spec.command === "git") {
      return spawnExec(spec);
    }
    calls.push(spec);
    gateStates.set(spec, containers);
    if (spec.command === "docker") {
      assertContainerRules(spec);
    }
    return fake(spec);
  }) as Exec & { calls: ExecSpec[] };
  exec.calls = calls;
  return exec;
}

export interface GateFake {
  /** Mutate the simulated container copy after the independent forced-tree check. */
  readonly afterCopy?: (work: string) => void;
  /** Image Git variables are applied only to its emulated copy/identity shell processes. */
  readonly environment?: Readonly<Record<string, string>>;
  /** The gate step script's result; defaults to success. */
  readonly gate?: (work: string) => ExecResult;
  readonly install?: (work: string) => ExecResult;
  /** The gate container has no node_modules/, as after an install that provides none. */
  readonly noNodeModules?: boolean;
}

/** The Wrangler entry a gated install leaves in node_modules/, relative to the worktree. */
export const FAKE_WRANGLER = "wrangler/bin/wrangler.js";

/**
 * A docker that behaves like the gate container: `docker cp` out of it writes a step log, a
 * built dist/ file or an installed node_modules/ Wrangler entry into the host destination, as
 * the host user would receive them.
 */
export function gateDocker(fake: GateFake = {}): FakeChild {
  return (spec) => {
    const [verb, ...rest] = spec.args;
    if (spec.command !== "docker") {
      return ok();
    }
    const containers = gateStates.get(spec);
    if (verb === "ps" && rest.some((arg) => arg.startsWith("name="))) {
      return ok([...(containers?.keys() ?? [])].join("\n"));
    }
    if (verb === "create" && containers !== undefined) {
      const name = rest[rest.indexOf("--name") + 1]!;
      const mount = rest.find((arg) => arg.includes("dst=/src,"));
      const source = /src=([^,]+)/u.exec(mount ?? "")?.[1];
      if (source === undefined) {
        throw new Error("fake gate source mount missing");
      }
      const root = mkdtempSync(join(tmpdir(), "fake-gate-container-"));
      containers.set(name, { root, source, work: join(root, "work") });
    }
    const containerName = rest.find((arg) => containers?.has(arg));
    const container = containerName === undefined ? undefined : containers?.get(containerName);
    const script = rest.at(-1) ?? "";
    if (
      verb === "exec" &&
      container !== undefined &&
      (rest.some((arg) => arg.startsWith("EXPECTED_TREE=")) ||
        script.includes("gate-source-identity.tar"))
    ) {
      const environment = { ...process.env, ...fake.environment };
      rest.forEach((arg, index) => {
        if (rest[index - 1] === "-e") {
          const at = arg.indexOf("=");
          environment[arg.slice(0, at)] = arg.slice(at + 1);
        }
      });
      // Emulate non-root extraction ownership even when the isolated test process is root.
      const paths: Record<string, string> = {
        "/src": container.source,
        "/tmp/gate-logs": join(container.root, "logs"),
        "/tmp/gate-source-identity.tar": join(container.root, "identity.tar"),
        "/tmp/work": container.work,
      };
      const mapped = script
        .replace(
          /\/tmp\/gate-source-identity\.tar|\/tmp\/gate-logs|\/tmp\/work|\/src/gu,
          (path) => paths[path]!,
        )
        .replace("tar -xf", "tar --no-same-owner -xf");
      const result = spawnSync("sh", ["-c", mapped], { encoding: "utf8", env: environment });
      if (result.status === 0 && !rest.some((arg) => arg.startsWith("EXPECTED_COMMIT="))) {
        fake.afterCopy?.(container.work);
      }
      return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
    }
    if (verb === "exec" && rest.at(-1)?.startsWith("set -e") === true) {
      return fake.gate?.(container?.work ?? "") ?? ok("lint ok\ntest ok\n");
    }
    if (verb === "exec" && rest.includes("sh") && rest.at(-1)?.includes("npm ci") === true) {
      return fake.install?.(container?.work ?? "") ?? ok();
    }
    if (verb === "exec" && rest[1] === "test" && rest.at(-1) === "/tmp/work/node_modules") {
      return fake.noNodeModules === true ? { status: 1, stderr: "", stdout: "" } : ok();
    }
    if (verb === "cp") {
      const [source = "", destination = ""] = rest.filter((arg) => arg !== "--quiet");
      if (destination.endsWith(":/tmp/gate-source-identity.tar")) {
        const copy = containers?.get(destination.slice(0, destination.indexOf(":")));
        if (copy === undefined) {
          throw new Error("fake gate identity destination missing");
        }
        cpSync(source, join(copy.root, "identity.tar"));
      } else if (source.endsWith(":/tmp/work/dist/.")) {
        writeFileSync(join(destination, "index.js"), "built\n");
      } else if (source.endsWith(":/tmp/work/node_modules/.")) {
        const entry = join(destination, FAKE_WRANGLER);
        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(entry, "// wrangler\n");
      } else if (source.endsWith(":/tmp/gate-logs/.")) {
        writeFileSync(join(destination, "01-lint.log"), "linted\n");
      }
    }
    if (verb === "rm" && container !== undefined && containerName !== undefined) {
      rmSync(container.root, { force: true, recursive: true });
      containers?.delete(containerName);
    }
    return ok();
  };
}

export interface TestGame {
  readonly base: string;
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly config: ProjectConfig;
  readonly origin: string;
  /** The game checkout the bus integrates in. */
  readonly repo: string;
}

export function makeGame(
  overrides: (config: Record<string, Record<string, unknown>>) => void = () => undefined,
): TestGame {
  const { base, root } = makeFixture();
  const config = projectConfig("Archie") as Record<string, Record<string, unknown>>;
  overrides(config);
  const layout = loadLayout(root);
  const game = gameLayout(layout, GAME);
  writeFileSync(game.configFile, `${JSON.stringify(config, null, 2)}\n`);
  const origin = join(base, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  gitSync(game.repo, "init", "-q", "-b", "main");
  gitSync(game.repo, "add", "--", "delivery-kit.json");
  commitFile(game.repo, "README.md", "game\n", "initial");
  gitSync(game.repo, "remote", "add", "origin", origin);
  gitSync(game.repo, "push", "-q", "origin", "main");
  gitSync(game.repo, "fetch", "-q", "origin");
  mkdirSync(game.busDir, { recursive: true });
  setDesiredDelivery(
    { dir: game.busDir },
    {
      reason: "explicit test fixture adoption",
      requester: "game-coordinator",
      state: "enabled",
    },
  );
  return { base, config: validateProjectConfig(config), game, layout, origin, repo: game.repo };
}

export interface ContextParts {
  readonly exec?: Exec;
  readonly clock?: Clock;
  /** Defaults to recording events; "log" appends to the real bus/events.jsonl. */
  readonly events?: Events | "log";
  /** Defaults to a recording coordinator that delivers every review. */
  readonly coordinator?: Coordinator;
  /** A fixed one-minute load, or a source read at every load check. */
  readonly load?: number | (() => number);
  readonly startCi?: (sha: string) => void;
}

export function testContext(
  test: TestGame,
  parts: ContextParts = {},
): BusContext & { lines: string[] } {
  const lines: string[] = [];
  const load = parts.load ?? 0;
  const context = busContext(
    {
      clock: parts.clock ?? manualClock(1_800_000_000),
      coordinator: parts.coordinator ?? recordingCoordinator(),
      ...(parts.events === "log" ? {} : { events: parts.events ?? recordingEvents() }),
      exec: parts.exec ?? fakeExec(() => ok()),
      loadAverage: typeof load === "function" ? load : () => load,
      log: (line) => lines.push(line),
      ...(parts.startCi === undefined ? {} : { startCi: parts.startCi }),
    },
    test.layout,
    test.game,
    test.config,
  );
  return Object.assign(context, { lines });
}

/** Tech's merge: a feature branch with one commit, fast-forwarded into local main. */
export function mergeFastForward(
  test: TestGame,
  name: string,
  file = `${name.replace(/\W/g, "-")}.txt`,
): string {
  gitSync(test.repo, "checkout", "-q", "-b", name, "main");
  commitFile(test.repo, file, `${name}\n`);
  gitSync(test.repo, "checkout", "-q", "main");
  gitSync(test.repo, "merge", "-q", "--ff-only", name);
  return gitSync(test.repo, "rev-parse", "HEAD");
}

/** Tech's merge: a feature branch merged into a main that moved meanwhile, as a merge commit. */
export function mergeWithCommit(test: TestGame, name: string): string {
  gitSync(test.repo, "checkout", "-q", "-b", name, "main");
  commitFile(test.repo, `${name.replace(/\W/g, "-")}.txt`, `${name}\n`);
  gitSync(test.repo, "checkout", "-q", "main");
  commitFile(test.repo, `main-${name.replace(/\W/g, "-")}.txt`, "main\n");
  gitSync(test.repo, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-ff", "--no-edit", name);
  return gitSync(test.repo, "rev-parse", "HEAD");
}
