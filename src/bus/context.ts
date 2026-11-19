// Everything a bus mechanism needs: the resolved game, its configuration, its state paths
// and the injectable process, clock, event, coordinator seam and log dependencies.
import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";

import {
  type GameLayout,
  type Layout,
  type ProjectConfig,
} from "@andornaut/coordination-kit/build/shared";

import { type EventType, type RunnerStarted, startedDetail } from "../events.ts";
import { EventLog } from "./eventlog.ts";
import { type Exec, spawnExec } from "./exec.ts";
import { type Coordinator, CoordinatorCli } from "./seam.ts";
import { type BusPaths, busPaths } from "./state.ts";

export interface Clock {
  /** Epoch seconds. */
  now(): number;
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

export interface Events {
  /** Prepare the log at runner start: torn-tail repair, dedupe rebuild, legacy outbox import. */
  open(): void;
  /** Append one event at most once per (type, key) and request an ingest. */
  emit(type: EventType, key: string, message: string): void;
  /** Append `runner.started` for this start, keyed by the runner token. */
  started(key: string, started: RunnerStarted): void;
  /** Request a `coordination-kit events ingest`. */
  ingest(): void;
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
  /** The coordinator-installed coordination-kit CLI: scheduled reviews and event delivery. */
  readonly coordinator: Coordinator;
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

/**
 * Events appended to bus/events.jsonl and ingested by the coordinator CLI. A failed append is
 * logged and never stops a departure; every appended event requests an ingest. The detail keeps
 * the operator-facing `<project> bus: ` prefix the 6.0 outbox gave each message.
 */
function busEvents(
  log: EventLog,
  options: { readonly coordinator: Coordinator; readonly project: string },
): Events {
  return {
    emit(type, key, message) {
      if (log.append(type, key, `${options.project} bus: ${message}`)) {
        this.ingest();
      }
    },
    ingest() {
      options.coordinator.ingest();
    },
    open() {
      log.open();
    },
    started(key, started) {
      if (log.append("runner.started", key, startedDetail(started))) {
        this.ingest();
      }
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
  readonly coordinator?: Coordinator;
  /** The seam's spawn deadline; tests shorten it. */
  readonly seamTimeoutMs?: number;
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
  const clock = options.clock ?? systemClock;
  const coordinator =
    options.coordinator ??
    new CoordinatorCli({
      game: game.id,
      log,
      now: () => clock.now(),
      root: layout.root,
      seamFile: paths.seam,
      timezone: layout.config.timezone,
      ...(options.seamTimeoutMs === undefined ? {} : { timeoutMs: options.seamTimeoutMs }),
    });
  return {
    base: `${config.git.remote}/${config.git.main}`,
    clock,
    config: { ...config, schedule },
    coordinator,
    events:
      options.events ??
      busEvents(
        new EventLog({
          game: game.id,
          log,
          now: () => clock.now(),
          paths,
          repo: game.repo,
        }),
        { coordinator, project: config.reports.project },
      ),
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
