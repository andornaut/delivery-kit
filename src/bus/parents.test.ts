import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../config.ts";
import {
  CLAUDE_COORDINATOR,
  CLAUDE_TECH,
  CODEX_TECH,
  projectConfig,
  registryInput,
} from "../testFixtures.ts";
import { workerParentProblems } from "./parents.ts";

function problems(raw: unknown, parents: readonly string[]) {
  const config = projectConfig("Archie") as unknown as ProjectConfig;
  return workerParentProblems(
    "delivery-kit.json",
    {
      ...config,
      reports: { ...config.reports, workerParents: parents },
    },
    raw,
  );
}

function registry() {
  return registryInput() as { harness: string; roles: Record<string, Record<string, unknown>> };
}

describe("worker parent effective transports", () => {
  it("validates each parent's selected ID independently of the global harness", () => {
    const raw = registry();
    raw.roles["archies-dog-walks/tech"]!.harness = "codex";
    raw.roles["archies-dog-walks/tech"]!.conversations = { claude: "invalid", codex: CODEX_TECH };
    expect(problems(raw, ["game-coordinator", "archies-dog-walks/tech"])).toEqual([]);
  });

  it("rejects invalid or unavailable overrides instead of falling back to an inactive ID", () => {
    for (const harness of ["other", null, "codex"]) {
      const raw = registry();
      Object.assign(raw.roles["game-coordinator"]!, { harness });
      expect(problems(raw, ["game-coordinator"])).toEqual([
        "delivery-kit.json: /reports/workerParents/0: game-coordinator has no canonical lowercase " +
          "conversation UUID in registry.json",
      ]);
    }
  });

  it("detects duplicate active IDs including cross-provider collisions", () => {
    const raw = registry();
    raw.roles["archies-dog-walks/tech"]!.harness = "codex";
    raw.roles["archies-dog-walks/tech"]!.conversations = {
      claude: CLAUDE_TECH,
      codex: CLAUDE_COORDINATOR,
    };
    expect(problems(raw, ["game-coordinator", "archies-dog-walks/tech"])).toEqual([
      "delivery-kit.json: /reports/workerParents/1: archies-dog-walks/tech resolves " +
        "to the same conversation as workerParents/0",
    ]);
  });
});
