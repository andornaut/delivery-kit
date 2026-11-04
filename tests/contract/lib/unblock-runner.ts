// Drive the resident runner's scheduled monitor and departure ticks under the virtual clock.
// The clock runs at wall speed with short real sleeps; a slot is reached by jumping the clock
// one second past it, so each observer iteration sees exactly one new minute.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Resident, startRunner } from "./adapter.ts";
import { CodexSocket } from "./codex-socket.ts";
import { at, sleep } from "./time.ts";
import { ART, GAMEPLAY, NativeWorld, TECH } from "./unblock-native.ts";
import type { Workspace } from "./workspace.ts";

export function virtualNow(ws: Workspace): number {
  const clock = JSON.parse(readFileSync(ws.clockFile, "utf8")) as {
    epoch: number;
    realStartMs: number;
    speed: number;
  };
  let offset = 0;
  const offsets = join(ws.fakeDir, "clock-offsets");
  if (existsSync(offsets)) {
    for (const line of readFileSync(offsets, "utf8").split("\n"))
      if (line.trim()) offset += Number(line);
  }
  return Math.floor(clock.epoch + offset + ((Date.now() - clock.realStartMs) * clock.speed) / 1000);
}

/** A version 1 Codex monitor route; host defaults to this game's checkout. */
export function codexRoute(
  ws: Workspace,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    harness: "codex",
    state: "active",
    host_project_root: ws.repo,
    monitor_thread_id: TECH,
    targets: [
      { thread_id: ART, ownership: "active" },
      { thread_id: GAMEPLAY, ownership: "active" },
    ],
    ...change,
  };
}

export function codexRegistry(ws: Workspace): void {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: {
      monitor: { conversations: { codex: TECH } },
      art: { conversations: { codex: ART } },
      gameplay: { conversations: { codex: GAMEPLAY } },
    },
  });
}

export function decide(ws: Workspace, recipient: string, record: unknown): void {
  ws.write(
    `unblock/decisions/${recipient}.json`,
    typeof record === "string" ? record : JSON.stringify(record),
  );
}

/** Real UTC now, for owner attestations that the collectors check against wall time. */
export function confirmedAt(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export interface Tick {
  /** Parsed `bus: scheduled monitor SLOT: {...}` JSON, when the helper ran. */
  result: Record<string, unknown> | undefined;
  /** Runner output produced for this tick. */
  output: string;
}

export class Monitored {
  readonly world = new NativeWorld();
  readonly socket: CodexSocket;
  runner: Resident | undefined;
  private output = "";

  constructor(readonly ws: Workspace) {
    this.socket = new CodexSocket(ws);
  }

  /** Route-mode setup: registry, route, clear monitor decision and departures that never fire. */
  static async routed(ws: Workspace, route: Record<string, unknown> = {}): Promise<Monitored> {
    codexRegistry(ws);
    ws.config.schedule = { departures: ["05"], timezone: "America/Toronto" };
    ws.writeRoute(codexRoute(ws, route));
    decide(ws, TECH, { thread_id: TECH, state: "clear" });
    const monitored = new Monitored(ws);
    await monitored.listen();
    return monitored;
  }

  async listen(): Promise<void> {
    await this.socket.listen();
    this.world.install(this.socket);
    this.ws.env.CODEX_CONTROL_SOCKET = this.socket.path;
  }

  /** Start one runner at local 19:00 of HOUR's previous hour (minute 0, hour -1). */
  async start(epoch = at(0, 0, -1)): Promise<void> {
    this.ws.updateControl((c) => (c.maxRealSleep = 0.2));
    this.ws.setClock(epoch, 1);
    this.output = "";
    const runner = startRunner(this.ws);
    runner.child.stdout.on("data", (chunk: Buffer) => (this.output += chunk.toString()));
    runner.child.stderr.on("data", (chunk: Buffer) => (this.output += chunk.toString()));
    this.runner = runner;
    await runner.until(() => this.ws.exists("runner.identity.json"));
    // The observer records its first `previous` time right after the identity record.
    await sleep(500);
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
    this.runner = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    await this.socket.close();
  }

  /** Jump the clock to second 1 of the epoch's minute and wait for `predicate` on new output. */
  async jump(
    epoch: number,
    predicate: (output: string) => boolean,
    // A slot runs the native helper, whose own deadline is 25 seconds; leave room under load.
    timeoutMs = 45_000,
  ): Promise<string> {
    // A departure still finishing when the clock jumps would cross the slot, which the loop
    // never replays; wait for the previous one to end first.
    await this.runner!.until(
      () => !this.ws.exists("active-departure") || this.ws.read("active-departure") === "",
      timeoutMs,
    );
    const mark = this.output.length;
    const now = virtualNow(this.ws);
    if (epoch + 1 <= now) throw new Error(`clock already past ${epoch}`);
    this.ws.advanceClock(epoch + 1 - now);
    await this.runner!.until(() => predicate(this.output.slice(mark)), timeoutMs);
    // Let the helper finish writing receipts after it reported.
    await sleep(100);
    return this.output.slice(mark);
  }

  /** Reach a monitor wake slot and return the helper's reported status. */
  async slot(epoch: number): Promise<Tick> {
    const marker = `scheduled monitor ${epoch}`;
    const output = await this.jump(
      epoch,
      (text) => text.includes(marker) || text.includes("monitor deferred"),
    );
    const line = output.split("\n").find((row) => row.includes(`${marker}: `));
    const result = line
      ? (JSON.parse(line.slice(line.indexOf(`${marker}: `) + marker.length + 2)) as Record<
          string,
          unknown
        >)
      : undefined;
    return { result, output };
  }

  /** Output written so far by the current runner. */
  text(): string {
    return this.output;
  }

  receipt(epoch: number, coordinator = TECH): Record<string, unknown> {
    return this.ws.readJson(`unblock/${coordinator}-${epoch}.json`);
  }

  health(coordinator = TECH): Record<string, unknown> {
    return this.ws.readJson(`unblock/health/${coordinator}.json`);
  }
}

/** Wake slots: minute 20 and 50 of successive hours. */
export function wake(index: number): number {
  return at(index % 2 === 0 ? 20 : 50, 0, Math.floor(index / 2));
}
