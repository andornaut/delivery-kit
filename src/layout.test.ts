import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gameLayout, loadLayout, roleKeys, UnknownGame } from "./layout.ts";
import { gameDevConfig, makeFixture, writeFixtureJson } from "./testFixtures.ts";
import { ValidationError } from "./validate.ts";

describe("loadLayout", () => {
  it("resolves var/ and per-game paths relative to game-dev", () => {
    const { base, root } = makeFixture();
    const layout = loadLayout(root);
    expect(layout.registryFile).toBe(join(root, "var/registry.json"));
    expect(layout.registryLock).toBe(join(root, "var/registry.lock"));
    expect(layout.routeFile).toBe(join(root, "var/route.json"));
    const game = gameLayout(layout, "archies-dog-walks");
    expect(game.repo).toBe(join(base, "archies-dog-walks"));
    expect(game.configFile).toBe(join(base, "archies-dog-walks/delivery-kit.json"));
    expect(game.busDir).toBe(join(root, "var/games/archies-dog-walks/bus"));
    expect(() => gameLayout(layout, "unknown")).toThrow(UnknownGame);
    expect(roleKeys(layout.config)).toContain("chibis-way-home/tech");
    expect(roleKeys(layout.config)).toContain("game-dev");
  });

  it("accepts an empty wake minute list, which schedules no review", () => {
    const { root } = makeFixture();
    writeFixtureJson(join(root, "config.json"), { ...gameDevConfig(), wakeMinutes: [] });
    expect(loadLayout(root).config.wakeMinutes).toEqual([]);
  });

  it("rejects absolute paths, invalid IDs and unknown keys", () => {
    const { root } = makeFixture();
    const config = gameDevConfig();
    (config.games as Record<string, Record<string, unknown>>).Bad_ID = {
      name: "Bad",
      path: "/abs",
      roles: ["tech"],
    };
    config.extra = true;
    writeFixtureJson(join(root, "config.json"), config);
    try {
      loadLayout(root);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).issues.join("\n");
      expect(issues).toContain("/games/Bad_ID: game ID must match");
      expect(issues).toContain("/games/Bad_ID/path: must be a relative path");
      expect(issues).toContain("/extra: unknown key");
    }
  });

  it("reports unreadable config.json", () => {
    const { root } = makeFixture();
    writeFileSync(join(root, "config.json"), "not json");
    expect(() => loadLayout(root)).toThrow("invalid JSON");
  });
});
