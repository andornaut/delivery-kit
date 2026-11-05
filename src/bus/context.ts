// Everything a bus mechanism needs: the resolved game, its configuration, its state paths
// and the injectable process, clock, event and log dependencies.
import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";

import type { ProjectConfig } from "../config.ts";
import { emitEvent, flushEvents } from "../events.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { type Exec, spawnExec } from "./exec.ts";
import { type BusPaths, busPaths } from "./state.ts";

export interface Clock {
  /** Epoch seconds. */
  now(): number;
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

export interface Events {
  emit(kind: string, key: string, message: string): void;
  flush(): void;
}

/** A game's configuration with the schedule timezone resolved from config.json when omitted. */
export type BusConfig = ProjectConfig & {
  readonly schedule: ProjectConfig["schedule"] & { readonly timezone: string };
};

export interface BusContext {
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly config: BusConfig;
  readonly paths: BusPaths;
  readonly exec: Exec;
  readonly clock: Clock;
  readonly events: Events;
  /** One runner log line; the runner appends it to bus/runner.log. */
  readonly log: (line: string) => void;
  /** `<remote>/<main>`, the integration base. */
  readonly base: string;
  /** Load average source, injectable for tests. */
  readonly loadAverage: () => number;
  /** Start the in-runner CI watch for a pushed SHA. */
  readonly startCi: (sha: string) => void;
}

const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: (seconds, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
};

/** Events through events.ts. Persistence failures are logged and never stop a departure. */
function busEvents(game: GameLayout, project: string, log: (line: string) => void): Events {
  return {
    emit(kind, key, message) {
      try {
        emitEvent(game, { project }, kind, key, message);
      } catch (error) {
        log(`bus: event persistence failed; operator review required (${String(error)})`);
        return;
      }
      this.flush();
    },
    flush() {
      flushEvents(game).catch((error: unknown) => log(`bus: event flush failed: ${String(error)}`));
    },
  };
}

function fileLog(path: string): (line: string) => void {
  return (line) => appendFileSync(path, `${line}\n`, { mode: 0o600 });
}

export interface ContextOptions {
  readonly exec?: Exec;
  readonly clock?: Clock;
  readonly events?: Events;
  readonly log?: (line: string) => void;
  readonly loadAverage?: () => number;
  readonly startCi?: (sha: string) => void;
}

export function busContext(
  options: ContextOptions,
  layout: Layout,
  game: GameLayout,
  config: ProjectConfig,
): BusContext {
  const paths = busPaths(game.busDir);
  const log = options.log ?? fileLog(paths.runnerLog);
  const schedule = {
    ...config.schedule,
    timezone: config.schedule.timezone ?? layout.config.timezone,
  };
  return {
    base: `${config.git.remote}/${config.git.main}`,
    clock: options.clock ?? systemClock,
    config: { ...config, schedule },
    events: options.events ?? busEvents(game, config.reports.project, log),
    exec: options.exec ?? spawnExec,
    game,
    layout,
    loadAverage: options.loadAverage ?? defaultLoad,
    log,
    paths,
    startCi: options.startCi ?? ((sha) => log(`bus: no CI watcher in this process for ${sha}`)),
  };
}

// The one-minute load average from /proc/loadavg.
function defaultLoad(): number {
  return loadavg()[0] ?? 0;
}

/** True when the one-minute load is below the configured limit. */
export function loadOk(context: BusContext): boolean {
  return context.loadAverage() < context.config.resources.loadLimit;
}
