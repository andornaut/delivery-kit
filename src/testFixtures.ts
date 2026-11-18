// Scratch game-coordinator trees for tests. Every fixture lives under a fresh temporary directory.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Layout } from "@andornaut/coordination-kit/build/shared";

export const CLAUDE_TECH = "00000000-0000-4000-8000-000000000001";
export const CODEX_TECH = "00000000-0000-4000-8000-000000000002";
export const CLAUDE_COORDINATOR = "00000000-0000-4000-8000-000000000003";

export function coordinatorConfig(): Record<string, unknown> {
  return {
    games: {
      "archies-dog-walks": {
        name: "Archie",
        path: "../archies-dog-walks",
        roles: ["art", "gameplay", "tech"],
      },
      "chibis-way-home": {
        name: "Chibi",
        path: "../chibis-way-home",
        roles: ["art", "gameplay", "tech"],
      },
    },
    kits: { "art-kit": { path: "../art-kit" }, "delivery-kit": { path: "../delivery-kit" } },
    schema: 1,
    sharedRoles: ["game-coordinator", "art-kit", "delivery-kit", "game-kit"],
    timezone: "America/Toronto",
    wakeMinutes: [20, 50],
  };
}

export function projectConfig(project: string): Record<string, unknown> {
  return {
    ci: { pollSeconds: 60, requiredNames: ["Lint", "Test"], timeoutSeconds: 1800 },
    deploy: { mode: "wrangler", skipPattern: "\\.md$" },
    gate: {
      image: "node:24.21.0",
      install: "npm ci",
      steps: [
        { name: "lint", run: "npm run lint" },
        { name: "test", run: "npm test -- --maxWorkers=4" },
      ],
    },
    git: { github: "owner/game", main: "main", remote: "origin" },
    reports: {
      project,
      recipient: "game-coordinator",
      scheduledTicks: true,
      workerParents: ["game-coordinator"],
    },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    schedule: { departures: ["00"], timezone: "America/Toronto" },
    schema: 1,
  };
}

export function registryInput(): Record<string, unknown> {
  return {
    harness: "claude",
    host: { nativeProjectId: "project-1", root: "." },
    operations: {
      "archies-dog-walks": { activation: { marker: "adopt-1" }, busOwner: "game-coordinator" },
    },
    roles: {
      "archies-dog-walks/tech": {
        activation: { checkpoint: "var/handoffs/tech.json", marker: "tech-1" },
        branch: "claude-tech",
        conversations: { claude: CLAUDE_TECH, codex: CODEX_TECH },
        ownership: "active",
        phase: "active",
        worktree: "../archies-dog-walks/.worktrees/tech",
      },
      "game-coordinator": {
        conversations: { claude: CLAUDE_COORDINATOR },
        ownership: "active",
        worktree: ".",
      },
    },
    schema: 1,
    transfers: [],
  };
}

export interface Fixture {
  /** The game-coordinator root. */
  readonly root: string;
  readonly base: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A scratch tree: base/game-coordinator with config.json and base/<game>/delivery-kit.json per game. */
export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "delivery-kit-"));
  const root = join(base, "game-coordinator");
  mkdirSync(root);
  writeJson(join(root, "config.json"), coordinatorConfig());
  for (const [game, project] of [
    ["archies-dog-walks", "Archie"],
    ["chibis-way-home", "Chibi"],
  ] as const) {
    mkdirSync(join(base, game));
    writeJson(join(base, game, "delivery-kit.json"), projectConfig(project));
  }
  return { base, root };
}

export function writeFixtureJson(path: string, value: unknown): void {
  writeJson(path, value);
}

/** An active work protocol at generation 1: fixture configuration only, never a migration. */
export function activateProtocolFixture(layout: Layout): string {
  const stateRoot = mkdtempSync(join(tmpdir(), "protocol-runtime-state-"));
  const workspace = { generation: 1, schema: 1, workspaceId: "fixture" };
  mkdirSync(layout.varDir, { recursive: true });
  writeFileSync(join(stateRoot, "workspace.json"), JSON.stringify(workspace));
  for (const name of ["work-protocol-fence.json", "work-protocol.json"]) {
    writeFileSync(join(layout.varDir, name), JSON.stringify({ ...workspace, stateRoot }));
  }
  return stateRoot;
}

/** A coordination-kit manifest in `repo`'s node_modules, as the pin guard reads it. */
export function installCoordinationKit(repo: string, version = "1.0.0"): void {
  const installed = join(repo, "node_modules", "@andornaut", "coordination-kit");
  mkdirSync(installed, { recursive: true });
  writeJson(join(installed, "package.json"), { name: "@andornaut/coordination-kit", version });
}
