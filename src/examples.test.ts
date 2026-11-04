// The committed examples are valid 1.0 configuration.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

  it("the channel server runs the packaged CLI", () => {
    const mcp = JSON.parse(readFileSync(join(examples, "claude-channel.mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers["delivery-kit-monitor"];
    expect(server?.command).toBe("npx");
    expect(server?.args.slice(-1)).toEqual(["channel"]);
  });
});
