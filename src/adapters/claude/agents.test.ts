import { describe, expect, it } from "vitest";

import { claudeFixture, RECIPIENT } from "../../review/fixtures.ts";
import { BLOCKED_REASON, MISSING_REASON, recipientAvailability, sessionStatus } from "./agents.ts";
import { claudeAdapter } from "./index.ts";

const interactive = (status: unknown) => ({ kind: "interactive", sessionId: RECIPIENT, status });

describe("recipientAvailability", () => {
  it.each(["idle", "busy", "shell", "waiting"])("accepts the live %s status", (status) => {
    expect(recipientAvailability([interactive(status)], RECIPIENT)).toEqual({ status });
  });

  it.each([
    ["an unrecognized status", [interactive("starting")], "starting"],
    [
      "a background state",
      [{ kind: "background", sessionId: RECIPIENT, state: "running" }],
      "running",
    ],
    [
      "a live status beside a state",
      [{ sessionId: RECIPIENT, state: "running", status: "waiting" }],
      "running",
    ],
    ["a token outside the reported pattern", [interactive("Waiting <now>")], "unknown"],
    ["a non-string status", [interactive(7)], "unknown"],
  ])("defers %s and names the reported token", (_name, entries, token) => {
    expect(recipientAvailability(entries, RECIPIENT)).toEqual({
      reason: `recipient session state unknown (reported: ${token})`,
      status: null,
    });
  });

  it("keeps the missing and blocked reasons", () => {
    expect(recipientAvailability([], RECIPIENT)).toEqual({ reason: MISSING_REASON, status: null });
    expect(
      recipientAvailability(
        [interactive("idle"), { kind: "background", sessionId: RECIPIENT, state: "blocked" }],
        RECIPIENT,
      ),
    ).toEqual({ reason: BLOCKED_REASON, status: null });
  });

  it("leaves sessionStatus reporting the raw token", () => {
    expect(sessionStatus([interactive("waiting")], RECIPIENT)).toBe("waiting");
    expect(sessionStatus([interactive("shell")], RECIPIENT)).toBe("shell");
    expect(sessionStatus([interactive("Bad token")], RECIPIENT)).toBe("unknown");
  });
});

describe("claudeAdapter status", () => {
  it.each([
    [[interactive("idle")], { status: "available" }],
    [[interactive("busy")], { status: "busy" }],
    [[interactive("shell")], { status: "busy" }],
    [[interactive("waiting")], { status: "busy" }],
    [
      [interactive("missing")],
      { reason: "recipient session state unknown (reported: missing)", status: "unavailable" },
    ],
    [[], { reason: MISSING_REASON, status: "missing" }],
    [
      [{ kind: "background", sessionId: RECIPIENT, state: "blocked" }],
      { reason: BLOCKED_REASON, status: "blocked" },
    ],
  ])("maps listing %j to %j", async (rows, expected) => {
    const fixture = claudeFixture();
    fixture.agents(rows);
    expect(await claudeAdapter(fixture.env, fixture.game).status(RECIPIENT)).toEqual(expected);
  });
});
