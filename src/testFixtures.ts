// Scratch game-dev trees for tests. Every fixture lives under a fresh temporary directory.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLAUDE_TECH = "00000000-0000-4000-8000-000000000001";
export const CODEX_TECH = "00000000-0000-4000-8000-000000000002";
export const CLAUDE_GAME_DEV = "00000000-0000-4000-8000-000000000003";

export function gameDevConfig(): Record<string, unknown> {
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
    sharedRoles: ["game-dev", "art-kit", "delivery-kit", "game-kit"],
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
    reports: { project, recipient: "monitor", scheduledTicks: true, workerParents: ["monitor"] },
    resources: { cpus: 4, loadLimit: 24 },
    schedule: { departures: ["00"], timezone: "America/Toronto" },
    schema: 1,
  };
}

export function registryInput(): Record<string, unknown> {
  return {
    harness: "claude",
    host: { nativeProjectId: "project-1", root: "." },
    operations: {
      "archies-dog-walks": { activation: { marker: "adopt-1" }, busOwner: "game-dev" },
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
      "game-dev": {
        conversations: { claude: CLAUDE_GAME_DEV },
        duties: ["monitor", "coordinator"],
        ownership: "active",
        worktree: ".",
      },
    },
    schema: 1,
    transfers: [],
  };
}

export interface Fixture {
  /** The game-dev root. */
  readonly root: string;
  readonly base: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A scratch tree: base/game-dev with config.json and base/<game>/delivery-kit.json per game. */
export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "delivery-kit-"));
  const root = join(base, "game-dev");
  mkdirSync(root);
  writeJson(join(root, "config.json"), gameDevConfig());
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
