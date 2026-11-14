import { describe, expect, it } from "vitest";

import { validateProjectConfig } from "./config.ts";
import { projectConfig } from "./testFixtures.ts";
import { ValidationError } from "./validate.ts";

type Json = Record<string, unknown>;

function issuesFor(mutate: (config: Json) => void): readonly string[] {
  const config = projectConfig("Archie");
  mutate(config);
  try {
    validateProjectConfig(config);
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

function section(config: Json, key: string): Json {
  return config[key] as Json;
}

describe("validateProjectConfig", () => {
  it("accepts the documented game configuration", () => {
    expect(validateProjectConfig(projectConfig("Archie")).gate.install).toBe("npm ci");
  });

  it("requires explicit integer memory in MiB from 6 through 8192", () => {
    for (const memoryMiB of [6, 8192]) {
      expect(issuesFor((config) => (section(config, "resources").memoryMiB = memoryMiB))).toEqual(
        [],
      );
    }
    for (const memoryMiB of [undefined, 0, -1, 1, 5, 1.5, 8193, "4096", null, NaN, Infinity]) {
      const issues = issuesFor((config) => {
        const resources = section(config, "resources");
        if (memoryMiB === undefined) {
          delete resources.memoryMiB;
        } else {
          resources.memoryMiB = memoryMiB;
        }
      });
      expect(
        issues.some((issue) => issue.startsWith("/resources/memoryMiB:")),
        String(memoryMiB),
      ).toBe(true);
    }
  });

  it("rejects each invalid field at its JSON pointer", () => {
    const rows: [string, (c: Json) => unknown, string][] = [
      [
        "conversation IDs",
        (c: Json) => (section(c, "reports").recipient = "00000000-0000-4000-8000-000000000001"),
        "/reports/recipient",
      ],
      ["absolute paths", (c: Json) => (section(c, "git").remote = "/srv/remote"), "/git/remote"],
      ["secret-like keys", (c: Json) => (section(c, "deploy").apiToken = "x"), "/deploy/apiToken"],
      [
        "inline secrets",
        (c: Json) => (section(c, "gate").install = "NPM_TOKEN=x npm ci"),
        "/gate/install",
      ],
      ["unknown keys", (c: Json) => (c.repo = "../game"), "/repo"],
      [
        "the removed maxWorkers key",
        (c: Json) => (section(c, "resources").maxWorkers = 4),
        "/resources/maxWorkers",
      ],
      ["more than four CPUs", (c: Json) => (section(c, "resources").cpus = 5), "/resources/cpus"],
      [
        "a load limit above 30",
        (c: Json) => (section(c, "resources").loadLimit = 31),
        "/resources/loadLimit",
      ],
      [
        "invalid departure minutes",
        (c: Json) => (section(c, "schedule").departures = ["60"]),
        "/schedule/departures/0",
      ],
      [
        "unknown time zones",
        (c: Json) => (section(c, "schedule").timezone = "Mars/Base"),
        "/schedule/timezone",
      ],
      ["invalid deploy modes", (c: Json) => (section(c, "deploy").mode = "rsync"), "/deploy/mode"],
      [
        "invalid skip patterns",
        (c: Json) => (section(c, "deploy").skipPattern = "("),
        "/deploy/skipPattern",
      ],
      [
        "duplicate step names",
        (c: Json) =>
          (section(c, "gate").steps = [
            { name: "a", run: "x" },
            { name: "a", run: "y" },
          ]),
        "/gate/steps/1/name",
      ],
      [
        "empty required CI names",
        (c: Json) => (section(c, "ci").requiredNames = []),
        "/ci/requiredNames",
      ],
    ];
    for (const [label, mutate, pointer] of rows) {
      const issues = issuesFor(mutate);
      expect(
        issues.some((issue) => issue.startsWith(`${pointer}:`)),
        `${label}: ${issues.join("\n")}`,
      ).toBe(true);
    }
  });
});
