// Step the resident runner's review observer one wall-clock minute at a time.
// The virtual clock is effectively frozen (speed 0.001) and every minute is a wake minute,
// so each advance of 60 seconds dispatches exactly one scheduled review slot. Real-time mode
// runs the clock at wall speed for collectors that compare slots with the real time.
import { type Resident, startRunner } from "./adapter.ts";
import { at, sleep } from "./time.ts";
import type { Workspace } from "./workspace.ts";

export interface SlotOutput {
  slot: number;
  /** The helper's status JSON, or undefined when the runner reported it unavailable. */
  output: Record<string, unknown> | undefined;
}

export class ReviewSchedule {
  private runner: Resident | undefined;
  private lines: string[] = [];
  private now: number;

  private readonly realtime: boolean;

  constructor(
    private readonly ws: Workspace,
    options: { start?: number; realtime?: boolean } = {},
  ) {
    this.realtime = options.realtime ?? false;
    this.now = this.realtime ? Math.floor(Date.now() / 1000) : (options.start ?? at(0, 30));
    // Every minute is a wake minute; the only departure minute is never reached by a case.
    ws.updateGameDevConfig({ wakeMinutes: Array.from({ length: 60 }, (_, minute) => minute) });
    ws.config.schedule = { departures: ["59"], timezone: "America/Toronto" };
    ws.updateControl((control) => (control.maxRealSleep = 0.15));
  }

  async start(): Promise<void> {
    this.ws.setClock(this.now, this.realtime ? 1 : 0.001);
    this.runner = startRunner(this.ws);
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      this.lines.push(...parts);
    };
    this.runner.child.stdout.on("data", collect);
    this.runner.child.stderr.on("data", collect);
    await this.runner.until(() => this.ws.exists("runner.identity.json"));
    // Let the observer record its first minute before time advances.
    await sleep(800);
  }

  /** Advance one minute and wait for that slot's scheduled review result. */
  async slot(timeoutMs = 30_000): Promise<SlotOutput> {
    let slot: number;
    if (this.realtime) {
      // The next wall-clock minute after the previous slot.
      slot = this.now - (this.now % 60) + 60;
      this.now = slot;
      timeoutMs = Math.max(timeoutMs, 120_000);
    } else {
      this.now += 60;
      this.ws.advanceClock(60);
      slot = this.now - (this.now % 60);
    }
    const prefix = `bus: scheduled review ${slot}`;
    let line: string | undefined;
    await this.runner!.until(
      () => (line = this.lines.find((row) => row.startsWith(prefix))) !== undefined,
      timeoutMs,
    );
    const json = line!.slice(prefix.length);
    return {
      slot,
      output: json.startsWith(": ")
        ? (JSON.parse(json.slice(2)) as Record<string, unknown>)
        : undefined,
    };
  }

  output(): string {
    return this.lines.join("\n");
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
  }
}
