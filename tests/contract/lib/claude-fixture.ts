// Helpers for review-tick cases: a scheduled review tick driven through the resident runner and
// the default Codex world of the original fixtures.
import { readFileSync } from "node:fs";

import { type Result, startRunnerAt } from "./adapter.ts";
import type { CodexSocket } from "./codex-socket.ts";
import type { Workspace } from "./workspace.ts";

export function virtualNow(ws: Workspace): number {
  const clock = JSON.parse(readFileSync(ws.clockFile, "utf8")) as {
    epoch: number;
    realStartMs: number;
    speed: number;
  };
  return clock.epoch + ((Date.now() - clock.realStartMs) * clock.speed) / 1000;
}

export interface Tick extends Result {
  /** Parsed `bus: scheduled review SLOT: JSON` lines, in order. */
  review: Array<{ slot: number; result: Record<string, unknown> }>;
}

function parseReview(stdout: string): Tick["review"] {
  const rows: Tick["review"] = [];
  for (const match of stdout.matchAll(/bus: scheduled review (\d+): (\{.*\})/g)) {
    rows.push({ slot: Number(match[1]), result: JSON.parse(match[2]!) as Record<string, unknown> });
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

/** The default Codex world of the original fixtures: active recipient mid-turn, empty history. */
export function codexWorld(
  socket: CodexSocket,
  queues: Record<string, unknown[]> = {},
): CodexSocket {
  return socket
    .on("thread/queue/list", (params: Record<string, unknown>) => ({
      data: queues[String(params.threadId)] ?? [],
      nextCursor: null,
    }))
    .on("thread/read", {
      thread: { status: { type: "active", activeFlags: [] }, canAcceptDirectInput: true },
    })
    .on("thread/turns/list", { data: [{ id: "turn-one", status: "inProgress" }], nextCursor: null })
    .on("thread/items/list", { data: [], nextCursor: null })
    .on("thread/list", { data: [], nextCursor: null })
    .on("turn/steer", { turnId: "turn-one" });
}

/** Distinct thread IDs in first-call order for a method and parameter. */
export function threads(socket: CodexSocket, method: string, key = "threadId"): string[] {
  return [...new Set(socket.callsOf(method).map((call) => String(call.params[key])))];
}
