// The committed examples are valid 1.0 configuration.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateRoleRoute } from "./adapters/shared/route.ts";
import { addressedRoles, loadProjectConfig } from "./config.ts";
import { validateGameDevConfig } from "./layout.ts";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

describe("examples", () => {
  it("delivery-kit.json is a valid project configuration addressing the monitor duty", () => {
    const config = loadProjectConfig(join(examples, "delivery-kit.json"));
    expect(addressedRoles(config)).toEqual(["monitor"]);
  });

  it("config.json is a valid game-dev configuration naming each report project", () => {
    const config = validateGameDevConfig(
      JSON.parse(readFileSync(join(examples, "config.json"), "utf8")),
    );
    const project = loadProjectConfig(join(examples, "delivery-kit.json")).reports.project;
    expect(Object.values(config.games).map((game) => game.name)).toContain(project);
    expect(config.sharedRoles).toContain("game-dev");
  });

  it("route.json is a valid schema 1 role-name route for config.json", () => {
    const config = validateGameDevConfig(
      JSON.parse(readFileSync(join(examples, "config.json"), "utf8")),
    );
    const route = validateRoleRoute(
      config,
      JSON.parse(readFileSync(join(examples, "route.json"), "utf8")),
    );
    expect(route).toMatchObject({ monitor: "game-dev", schema: 1, state: "active" });
  });

  it("the channel server runs the packaged CLI", () => {
    const mcp = JSON.parse(readFileSync(join(examples, "claude-channel.mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers["delivery-kit-monitor"];
    expect(server?.command).toBe("npx");
    expect(server?.args.slice(-2)).toEqual(["claude", "channel"]);
  });
});
