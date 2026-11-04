// Test fixtures for the bus: a scratch game-dev tree whose game is a real Git checkout with a
// bare origin, fake docker, gh and Wrangler children, recorded events and a manual clock.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ProjectConfig, validateProjectConfig } from "../config.ts";
import { type GameLayout, gameLayout, type Layout, loadLayout } from "../layout.ts";
import { makeFixture, projectConfig } from "../testFixtures.ts";
import { type BusContext, busContext, type Clock, type Events } from "./context.ts";
import { type Exec, type ExecResult, type ExecSpec, spawnExec } from "./exec.ts";

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
  flushes: number;
}

export function recordingEvents(): RecordedEvents {
  const list: [string, string, string][] = [];
  const events = {
    emit(kind: string, key: string, message: string) {
      list.push([kind, key, message]);
    },
    flush() {
      events.flushes += 1;
    },
    flushes: 0,
    list,
  };
  return events;
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

export const ok = (stdout = ""): ExecResult => ({ status: 0, stderr: "", stdout });

/** Real git; docker, gh and Wrangler go to `fake`, which records every call. */
export function fakeExec(fake: FakeChild): Exec & { calls: ExecSpec[] } {
  const calls: ExecSpec[] = [];
  const exec = (async (spec: ExecSpec) => {
    if (spec.command === "git") {
      return spawnExec(spec);
    }
    calls.push(spec);
    return fake(spec);
  }) as Exec & { calls: ExecSpec[] };
  exec.calls = calls;
  return exec;
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
  commitFile(game.repo, "README.md", "game\n", "initial");
  gitSync(game.repo, "remote", "add", "origin", origin);
  gitSync(game.repo, "push", "-q", "origin", "main");
  gitSync(game.repo, "fetch", "-q", "origin");
  mkdirSync(game.busDir, { recursive: true });
  return { base, config: validateProjectConfig(config), game, layout, origin, repo: game.repo };
}

export interface ContextParts {
  readonly exec?: Exec;
  readonly clock?: Clock;
  readonly events?: Events;
  readonly load?: number;
  readonly startCi?: (sha: string) => void;
}

export function testContext(
  test: TestGame,
  parts: ContextParts = {},
): BusContext & { lines: string[] } {
  const lines: string[] = [];
  const context = busContext(
    {
      clock: parts.clock ?? manualClock(1_800_000_000),
      events: parts.events ?? recordingEvents(),
      exec: parts.exec ?? fakeExec(() => ok()),
      loadAverage: () => parts.load ?? 0,
      log: (line) => lines.push(line),
      ...(parts.startCi === undefined ? {} : { startCi: parts.startCi }),
    },
    test.layout,
    test.game,
    test.config,
  );
  return Object.assign(context, { lines });
}

/** Create `bus/<name>` in the game checkout with one commit and queue it. */
export function queueBranch(
  test: TestGame,
  name: string,
  file = `${name.replace(/\W/g, "-")}.txt`,
): string {
  gitSync(test.repo, "checkout", "-q", "-b", name, "main");
  const tip = commitFile(test.repo, file, `${name}\n`);
  gitSync(test.repo, "checkout", "-q", "main");
  writeFileSync(join(test.game.busDir, "bus-queue"), `${name}\n`, { flag: "a" });
  return tip;
}
