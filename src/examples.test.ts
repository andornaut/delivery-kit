// The committed examples are valid 3.0 configuration.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateRoleRoute } from "./adapters/shared/route.ts";
import { addressedRoles, loadProjectConfig } from "./config.ts";
import { validateGameCoordinatorConfig } from "./layout.ts";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

describe("examples", () => {
  it("delivery-kit.json is a valid project configuration addressing the game-coordinator role", () => {
    const config = loadProjectConfig(join(examples, "delivery-kit.json"));
    expect(addressedRoles(config)).toEqual(["game-coordinator"]);
  });

  it("config.json is a valid game-coordinator configuration naming each report project", () => {
    const config = validateGameCoordinatorConfig(
      JSON.parse(readFileSync(join(examples, "config.json"), "utf8")),
    );
    const project = loadProjectConfig(join(examples, "delivery-kit.json")).reports.project;
    expect(Object.values(config.games).map((game) => game.name)).toContain(project);
    expect(config.sharedRoles).toContain(
      loadProjectConfig(join(examples, "delivery-kit.json")).reports.recipient,
    );
  });

  it("route.json is a valid schema 2 role-name route for config.json", () => {
    const config = validateGameCoordinatorConfig(
      JSON.parse(readFileSync(join(examples, "config.json"), "utf8")),
    );
    const route = validateRoleRoute(
      config,
      JSON.parse(readFileSync(join(examples, "route.json"), "utf8")),
    );
    expect(route).toMatchObject({ schema: 2, state: "active" });
  });

  it("the channel server runs the packaged CLI", () => {
    const mcp = JSON.parse(readFileSync(join(examples, "claude-channel.mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers["delivery-kit-channel"];
    expect(server?.command).toBe("npx");
    expect(server?.args.slice(-2)).toEqual(["claude", "channel"]);
  });
});
