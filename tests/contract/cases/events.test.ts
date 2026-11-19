// Runner-side bus events: the lines a departure appends to bus/events.jsonl, the ingest the resident
// observer requests from the coordinator CLI, the cursor that makes status drained, rotation,
// torn-line repair and the import of the 6.0 outbox. Ingest deduplication, quarantine and the
// COMPLETE projection are coordination-kit's contract; the fake CLI consumes lines per the cursor
// contract so these cases exercise both sides of the file seam.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { expect } from "vitest";

import { cli, impl, type Resident, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at, sleep } from "../lib/time.ts";
import { type Workspace } from "../lib/workspace.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));
const SHA = "c".repeat(40);

function bus(ws: Workspace, options: { github?: string } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: { "game-coordinator": { conversations: { codex: RECIPIENT } } },
  });
  ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
}

/** A game whose only departure (minute 05) is never reached and with no review slot. */
function idle(ws: Workspace): void {
  bus(ws);
  ws.config.schedule = { departures: ["05"], timezone: "America/Toronto" };
  ws.updateCoordinatorConfig({ wakeMinutes: [] });
}

function types(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.type));
}

function start(ws: Workspace, speed = 30): Resident {
  ws.setClock(at(59, 58), speed);
  return startRunner(ws);
}

/** A synthetic event line, as the runner writes it. */
function line(ws: Workspace, type: string, key: string, detail = "Fixture bus: seeded"): string {
  const id = createHash("sha256").update(`${ws.game}\n${type}\n${key}`).digest("hex");
  return `${JSON.stringify({
    schema: 1,
    id,
    game: ws.game,
    kind: "runner",
    type,
    key,
    at: "2026-11-18T21:30:00Z",
    sha: null,
    status: null,
    detail,
    work: null,
  })}\n`;
}

function size(ws: Workspace, name: string): number {
  return ws.exists(name) ? statSync(ws.path(name)).size : 0;
}

/** Ingest has consumed every complete line of events.jsonl and no rotated log remains. */
function drained(ws: Workspace): boolean {
  return (
    ws.exists("events.cursor") &&
    Number(ws.readJson("events.cursor").offset) === size(ws, "events.jsonl") &&
    !ws.list().some((name) => /^events\.\d+\.jsonl$/u.test(name))
  );
}

function ingestCalls(ws: Workspace): number {
  return ws.coordinatorCalls().filter((call) => call.args[0] === "events").length;
}

async function status(ws: Workspace): Promise<Record<string, unknown>> {
  const result = await cli(ws, ["status"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

suite("events", () => {
  const workspace = workspaces();

  contract("a failed gate appends one blocked event of the gate stage's type", async () => {
    const ws = workspace();
    bus(ws);
    ws.updateControl((c) => (c.docker = { gateFail: true }));
    impl.offer(ws, ["bus/feature"]);
    const runner = start(ws);
    await runner.until(() => types(ws).some((type) => type.startsWith("blocked-")));
    await sleep(500);
    await runner.stop();
    const blocked = ws.events().filter((event) => String(event.type).startsWith("blocked-"));
    expect(blocked.map((event) => [event.type, event.kind, event.status])).toEqual([
      ["blocked-full-gate", "gate", "failed"],
    ]);
    expect(types(ws).filter((type) => type === "runner.started")).toHaveLength(1);
  });

  contract("a passed gate appends gate_passed before the push and ingest receives it", async () => {
    const ws = workspace();
    bus(ws);
    ws.config.deploy = { mode: "none", skipPattern: "" };
    impl.offer(ws, ["bus/feature"]);
    const runner = start(ws);
    try {
      await runner.until(() => {
        const ingested = ws.ingested().map((event) => event.type);
        return ingested.includes("gate_passed") && ingested.includes("push");
      });
    } finally {
      await runner.stop();
    }
    const departed = types(ws).filter((type) => type !== "runner.started");
    expect(departed.indexOf("gate_passed")).toBeLessThan(departed.indexOf("push"));
    expect(departed.filter((type) => type === "gate_passed")).toHaveLength(1);
    const gate = ws.ingested().filter((event) => event.type === "gate_passed");
    expect(gate).toHaveLength(1);
    const sha = String(gate[0]!.key);
    expect(gate[0]).toMatchObject({
      detail: `Fixture bus: Gate passed for ${sha}.`,
      kind: "gate",
      sha,
      status: "ok",
    });
    expect(ws.events().find((event) => event.type === "push")!.key).toBe(sha);
  });

  contract("runner.started carries the runner token and both CLI identities", async () => {
    const ws = workspace();
    idle(ws);
    const runner = start(ws);
    try {
      await runner.until(() => types(ws).includes("runner.started"));
    } finally {
      await runner.stop();
    }
    const event = ws.events().find((row) => row.type === "runner.started")!;
    const token = ws.readJson("runner.identity.json").token;
    expect([event.kind, event.key, event.status, event.sha]).toEqual(["runner", token, null, null]);
    expect(JSON.parse(String(event.detail))).toEqual({
      cliSha256: ws.readJson("runner.identity.json").cli_sha256,
      coordinationKitVersion: "2.0.1",
      deliveryKitVersion: ws.readJson("runner.identity.json").version,
      distSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      token,
    });
  });

  contract("the observer asks the coordinator CLI to ingest once a minute", async () => {
    const ws = workspace();
    idle(ws);
    // The runner starts at minute 00 at wall speed.
    ws.updateControl((c) => (c.maxRealSleep = 0.2));
    ws.setClock(at(0, 0, -1), 1);
    const runner = startRunner(ws);
    try {
      await runner.armed();
      await runner.until(() => types(ws).includes("runner.started") && drained(ws));
      await sleep(1_000);
      const before = ingestCalls(ws);
      // A line appended outside an append request waits for the next observer pass.
      ws.write("events.jsonl", ws.read("events.jsonl") + line(ws, "scheduled-status", "seeded"));
      await sleep(1_500);
      expect(ingestCalls(ws)).toBe(before);
      expect(drained(ws)).toBe(false);
      ws.advanceClock(60);
      await runner.until(() => drained(ws));
      expect(ingestCalls(ws)).toBe(before + 1);
    } finally {
      await runner.stop();
    }
    expect(ws.coordinatorCalls().find((call) => call.args[0] === "events")!.args).toEqual([
      "events",
      "ingest",
      "--game",
      ws.game,
    ]);
    expect(ws.ingested().map((event) => event.type)).toEqual([
      "runner.started",
      "scheduled-status",
    ]);
  });

  contract("a deferred ingest is logged once and moves no cursor", async () => {
    const ws = workspace();
    idle(ws);
    ws.scriptCoordinator({
      ingest: { consume: false, detail: "store busy", reason: "cli-error", status: "deferred" },
    });
    const logged = "bus: event ingest deferred: cli-error: store busy";
    const runner = start(ws);
    try {
      await runner.until(() => ingestCalls(ws) >= 3);
    } finally {
      await runner.stop();
    }
    expect(runner.output().stdout.split(logged).length - 1).toBe(1);
    expect(ws.exists("events.cursor")).toBe(false);
    const report = await status(ws);
    expect(report.drained).toBe(false);
    expect(report.reporter_blockers).toEqual([`events_uningested:${size(ws, "events.jsonl")}`]);
  });

  contract("an ingested log over 1 MiB rotates and ingest deletes the rotated file", async () => {
    const ws = workspace();
    idle(ws);
    ws.config.schedule = { departures: ["01"], timezone: "America/Toronto" };
    ws.config.reports = { ...ws.config.reports, scheduledTicks: true };
    impl.offer(ws, []);
    const filler = "x".repeat(900);
    let seeded = "";
    for (let index = 0; seeded.length <= 1024 * 1024; index += 1) {
      seeded += line(ws, "attempt", `seed-${index}`, filler);
    }
    ws.write("events.jsonl", seeded);
    // The clock holds until runner.started is ingested with the seed; the minute-01 report then
    // finds the log fully ingested and rotates it.
    ws.holdClock(at(0, 30));
    const runner = startRunner(ws);
    try {
      await runner.armed();
      await runner.until(() => types(ws).includes("runner.started") && drained(ws));
      ws.setClock(at(0, 30), 30);
      await runner.until(() => types(ws).includes("scheduled-status") && drained(ws));
    } finally {
      await runner.stop();
    }
    expect(runner.output().stdout).toMatch(
      /bus: rotated events\.jsonl \(\d+ bytes, ingested\) to events\.\d+\.jsonl/u,
    );
    expect(types(ws)).toEqual(["scheduled-status"]);
    const ingested = ws.ingested().map((event) => event.type);
    expect(ingested.filter((type) => type === "runner.started")).toHaveLength(1);
    expect(ingested.length).toBe(seeded.split("\n").length - 1 + 2);
    const report = await status(ws);
    expect(report.drained).toBe(true);
    expect(report.events).toMatchObject({ drained: true, rotated: [], torn: false });
  });

  contract("a torn last line is terminated at start and ingest quarantines it", async () => {
    const ws = workspace();
    idle(ws);
    const whole = line(ws, "scheduled-status", "before-crash");
    ws.write("events.jsonl", `${whole}{"schema":1,"id":"ab`);
    const runner = start(ws);
    try {
      await runner.until(() => types(ws).includes("runner.started") && drained(ws));
    } finally {
      await runner.stop();
    }
    expect(runner.output().stdout).toContain(
      "bus: terminated a torn last line in events.jsonl; ingest quarantines it",
    );
    expect(ws.read("events.quarantine.jsonl")).toBe('{"schema":1,"id":"ab\n');
    expect(ws.ingested().map((event) => event.type)).toEqual([
      "scheduled-status",
      "runner.started",
    ]);
    expect((await status(ws)).drained).toBe(true);
  });

  contract(
    "the first start imports the 6.0 outbox in creation order before runner.started",
    async () => {
      const ws = workspace();
      idle(ws);
      const legacy = (name: string, fields: Record<string, unknown>, created: number) =>
        ws.write(
          `events/${name}.json`,
          `${JSON.stringify({
            key: SHA,
            message: `Fixture bus: ${name}`,
            sent: false,
            ...fields,
          }).replace(/^\{/u, `{"created":${created},`)}\n`,
        );
      legacy("second", { kind: "ci_success" }, 2);
      legacy("first", { kind: "push" }, 1);
      legacy("delivered", { kind: "attempt", sent: true }, 0);
      ws.write(`events/${SHA}.state`, '{"ci":"pending","deploy":"pending","pushed":true}\n');
      // The last push, whose CI failed, never completed: the import adds its push line.
      const last = "d".repeat(40);
      ws.write("last-push.sha", `${last}\n`);
      ws.write(`ci/${last}.status`, "failure\n");
      const runner = start(ws);
      try {
        await runner.until(() => types(ws).includes("runner.started") && drained(ws));
      } finally {
        await runner.stop();
      }
      expect(
        ws.events().map((event) => [event.type, event.kind, event.status, event.detail]),
      ).toEqual([
        ["push", "push", "ok", "Fixture bus: first"],
        ["ci_success", "ci", "ok", "Fixture bus: second"],
        ["push", "push", "ok", "imported at 6.1 start"],
        ["runner.started", "runner", null, expect.any(String)],
      ]);
      expect(ws.events()[2]!.key).toBe(last);
      expect(ws.exists("events")).toBe(false);
      const imported = ws.list().filter((name) => name.startsWith("events.imported-"));
      expect(imported).toHaveLength(1);
      expect(ws.list(imported[0]!)).toContain(`${SHA}.state`);
      expect((await status(ws)).drained).toBe(true);
    },
  );
});
