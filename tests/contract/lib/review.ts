// Helpers for review-tick cases: a scheduled review tick driven through the resident runner, with
// the fake coordination-kit CLI at the coordinator root answering `review deliver`.
import { readFileSync } from "node:fs";

import { type Result, startRunnerAt } from "./adapter.ts";
import type { Workspace } from "./workspace.ts";

export function virtualNow(ws: Workspace): number {
  const clock = JSON.parse(readFileSync(ws.clockFile, "utf8")) as {
    epoch: number;
    realStartMs: number;
    speed: number;
  };
  return clock.epoch + ((Date.now() - clock.realStartMs) * clock.speed) / 1000;
}

/**
 * The slot start the runner passes to `review deliver --slot`: an ISO minute start with the
 * America/Toronto offset, the fixture coordinator's timezone.
 */
export function iso(slot: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: "America/Toronto",
      year: "numeric",
    })
      .formatToParts(new Date(slot * 1000))
      .map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  const offset = (local - slot * 1000) / 60_000;
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00${sign}${hours}:${minutes}`;
}

/** The slots of the `review deliver` calls the fake CLI received, in order. */
export function reviewCalls(ws: Workspace): string[] {
  return ws
    .coordinatorCalls()
    .filter((call) => call.args[0] === "review" && call.args[1] === "deliver")
    .map((call) => call.args[call.args.indexOf("--slot") + 1]!);
}

export interface Tick extends Result {
  /** Parsed `bus: scheduled review SLOT: TEXT` lines, in order. */
  review: Array<{ slot: number; text: string }>;
}

function parseReview(stdout: string): Tick["review"] {
  const rows: Tick["review"] = [];
  for (const match of stdout.matchAll(/^bus: scheduled review (\d+): (.*)$/gm)) {
    rows.push({ slot: Number(match[1]), text: match[2]! });
  }
  return rows;
}

/**
 * Run the resident runner from `lead` virtual seconds before `slot` until the observer reports
 * that slot (or `done` holds), then stop it. The clock is held until the runner is armed, and the
 * default lead of one observer interval puts the observer's first wakeup at the slot itself, so
 * the whole wall minute absorbs scheduling lag. The observer dispatches only the current wall
 * minute; a negative lead starts the runner after the slot has begun, which it never replays.
 * Without a report it settles for `settle` virtual seconds, enough for two observer passes.
 */
export async function tick(
  ws: Workspace,
  slot: number,
  options: {
    done?: (out: { stdout: string; stderr: string }) => boolean;
    settle?: number;
    lead?: number;
  } = {},
): Promise<Tick> {
  const runner = await startRunnerAt(ws, slot - (options.lead ?? 60));
  const done =
    options.done ??
    (({ stdout, stderr }) =>
      stdout.includes(`bus: scheduled review ${slot}`) ||
      /review (deferred|\d+ unavailable)/.test(stderr));
  const settle = slot + (options.settle ?? 150);
  await runner.until(() => done(runner.output()) || virtualNow(ws) >= settle, 30_000);
  const result = await runner.stop();
  return { ...result, review: parseReview(result.stdout) };
}

/** Occurrences of `text` in `output`. */
export function occurrences(output: string, text: string): number {
  return output.split(text).length - 1;
}
