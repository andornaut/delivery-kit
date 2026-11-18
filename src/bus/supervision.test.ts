import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_REFUSED } from "../io.ts";
import {
  renderRunnerUnit,
  resolveTools,
  type RunnerUnitInput,
  unitPath,
  UnitUnavailable,
} from "./supervision.ts";

const INPUT: RunnerUnitInput = {
  cliPath: "/games/archie/node_modules/@andornaut/delivery-kit/dist/cli.js",
  coordinatorRoot: "/games/game-coordinator",
  gameId: "archies-dog-walks",
  gameName: "Archie",
  nodePath: "/opt/node/bin/node",
  pathDirectories: ["/opt/node/bin", "/usr/bin"],
  repo: "/games/archie",
  version: "4.7.0",
};

/** The unit's `Key=value` lines by section, ignoring comments and blank lines. */
function sections(unit: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let current = "";
  for (const line of unit.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const header = /^\[(\w+)\]$/u.exec(line)?.[1];
    if (header === undefined) {
      (result[current] ??= []).push(line);
    } else {
      current = header;
      result[current] = [];
    }
  }
  return result;
}

function tool(directory: string, name: string, mode = 0o755): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), "#!/bin/sh\n");
  chmodSync(join(directory, name), mode);
}

describe("renderRunnerUnit", () => {
  it("renders an explicit unit with absolute paths, restart policy and no timer", () => {
    expect(sections(renderRunnerUnit(INPUT))).toEqual({
      Install: ["WantedBy=default.target"],
      Service: [
        "Type=exec",
        "WorkingDirectory=/games/archie",
        'Environment="DELIVERY_KIT_ROOT=/games/game-coordinator"',
        'Environment="PATH=/opt/node/bin:/usr/bin"',
        `ExecStart=/opt/node/bin/node ${INPUT.cliPath} run --game archies-dog-walks`,
        "Restart=on-failure",
        "RestartSec=30",
        "SuccessExitStatus=143",
        `RestartPreventExitStatus=${EXIT_REFUSED}`,
        "KillMode=mixed",
        "KillSignal=SIGTERM",
        "TimeoutStopSec=120",
      ],
      Unit: [
        "Description=delivery-kit resident runner for Archie (archies-dog-walks)",
        "StartLimitIntervalSec=600",
        "StartLimitBurst=5",
      ],
    });
    expect(renderRunnerUnit(INPUT)).not.toMatch(/npx|Timer|OnCalendar/u);
  });

  it("escapes specifiers, quotes ExecStart words with spaces and rejects unsafe paths", () => {
    const unit = renderRunnerUnit({
      ...INPUT,
      cliPath: "/my games/100%/cli.js",
      coordinatorRoot: "/root$1/50%",
    });
    expect(unit).toContain('ExecStart=/opt/node/bin/node "/my games/100%%/cli.js" run --game');
    expect(unit).toContain('Environment="DELIVERY_KIT_ROOT=/root$1/50%%"');
    for (const input of [
      { ...INPUT, repo: "relative/game" },
      { ...INPUT, cliPath: '/games/"quoted"/cli.js' },
      { ...INPUT, coordinatorRoot: "/games/line\nbreak" },
      { ...INPUT, pathDirectories: ["/usr/bin:/bin"] },
    ]) {
      expect(() => renderRunnerUnit(input)).toThrow(UnitUnavailable);
    }
  });
});

describe("resolveTools", () => {
  it("keeps the first absolute PATH entry with an executable file and reports missing tools", () => {
    const base = mkdtempSync(join(tmpdir(), "delivery-kit-tools-"));
    const first = join(base, "first");
    const second = join(base, "second");
    tool(first, "git", 0o644);
    tool(second, "git");
    tool(first, "docker");
    tool(second, "docker");
    mkdirSync(join(first, "flock"), { recursive: true });
    const env = { PATH: ["relative", first, second].join(":") };
    expect(resolveTools(env, ["git", "docker", "flock"])).toEqual({
      directories: { docker: first, git: second },
      missing: ["flock"],
    });
    expect(resolveTools({}, ["gh"])).toEqual({ directories: {}, missing: ["gh"] });
  });

  it("puts the Node directory first and drops repeated directories", () => {
    expect(unitPath("/opt/node/bin/node", ["/usr/bin", "/opt/node/bin", "/usr/bin"])).toEqual([
      "/opt/node/bin",
      "/usr/bin",
    ]);
  });
});
