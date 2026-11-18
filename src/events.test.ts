import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { eventsDir } from "@andornaut/coordination-kit/build/events";
import { createRegistry, type Registry } from "@andornaut/coordination-kit/build/registry";
import { type GameLayout, gameLayout, loadLayout } from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import { emitEvent } from "./events.ts";
import { makeFixture, registryInput } from "./testFixtures.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OPTIONS = { project: "Archie" };

function setup(): GameLayout {
  const { root } = makeFixture();
  const layout = loadLayout(root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  return gameLayout(layout, "archies-dog-walks");
}

function events(game: GameLayout): Record<string, unknown>[] {
  const directory = eventsDir(game);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>,
    );
}

describe("emitEvent", () => {
  it("tracks commit state only for a 40-hex key", () => {
    const game = setup();
    emitEvent(game, OPTIONS, "push", "not-a-sha", "pushed");
    expect(existsSync(join(eventsDir(game), "not-a-sha.state"))).toBe(false);
    expect(events(game).map((event) => event.kind)).toEqual(["push"]);
  });

  it("never records quiet kinds but tracks commit state to completion", () => {
    const game = setup();
    emitEvent(game, OPTIONS, "push", SHA, "pushed");
    emitEvent(game, OPTIONS, "ci_pending", SHA, "pending");
    emitEvent(game, OPTIONS, "ci_success", SHA, "CI green");
    emitEvent(game, OPTIONS, "ci_running", SHA, "late progress");
    const state = () =>
      JSON.parse(readFileSync(join(eventsDir(game), `${SHA}.state`), "utf8")) as unknown;
    expect(state()).toEqual({ ci: "success", deploy: "pending", pushed: true });
    expect(events(game).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["push", "ci_success"]),
    );
    emitEvent(game, OPTIONS, "deploy_skipped", SHA, "docs only");
    const complete = events(game).find((event) => event.kind === "complete");
    expect(complete?.message).toBe(
      `Archie bus: COMPLETE ${SHA}: full gate passed; CI success; deployment skipped.`,
    );
    expect(
      events(game)
        .map((event) => event.kind)
        .sort(),
    ).toEqual(["ci_success", "complete", "deploy_skipped", "push"]);
  });

  it("reports a docs-only push as complete without claiming a gate", () => {
    const game = setup();
    emitEvent(game, OPTIONS, "gate_skipped", SHA, "gate skipped");
    emitEvent(game, OPTIONS, "push", SHA, "pushed");
    emitEvent(game, OPTIONS, "deploy_skipped", SHA, "docs only");
    emitEvent(game, OPTIONS, "ci_success", SHA, "CI green");
    expect(events(game).find((event) => event.kind === "complete")?.message).toBe(
      `Archie bus: COMPLETE ${SHA}: docs-only, gate skipped; CI success; deployment skipped.`,
    );
    expect(events(game).map((event) => event.kind)).not.toContain("gate_skipped");
  });
});
