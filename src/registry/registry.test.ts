import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Layout, loadLayout } from "../layout.ts";
import { holdLock, LockBusy, LockError, lockIsFree } from "../lock.ts";
import {
  CLAUDE_GAME_DEV,
  CLAUDE_TECH,
  CODEX_TECH,
  makeFixture,
  registryInput,
} from "../testFixtures.ts";
import { ValidationError } from "../validate.ts";
import {
  AmbiguousRole,
  createRegistry,
  readRegistry,
  type Registry,
  RegistryExists,
  RegistryMissing,
  RegistrySchema,
  resolveConversation,
  resolveRole,
  RevisionConflict,
  UnknownRole,
  updateRegistry,
} from "./index.ts";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const NOW = (): Date => new Date("2026-11-04T03:00:00.000Z");

function setup(): Layout {
  const layout = loadLayout(makeFixture().root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">, {
    now: NOW,
  });
  return layout;
}

// A child process importing the TypeScript source directly; Node strips the types.
function childScript(body: string): string {
  return `import * as registry from ${JSON.stringify(MODULE)};\n${body}`;
}

function runChild(
  body: string,
  args: readonly string[],
): Promise<{ code: number | null; signal: string | null }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(body), ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("createRegistry and readRegistry", () => {
  it("creates revision 1 once and reads a validated snapshot", () => {
    const layout = setup();
    const registry = readRegistry(layout);
    expect(registry.revision).toBe(1);
    expect(registry.updatedAt).toBe("2026-11-04T03:00:00.000Z");
    expect(RegistrySchema.validate(layout.config, registry)).toEqual(registry);
    expect(() => createRegistry(layout, registry)).toThrow(RegistryExists);
  });

  it("reports a missing registry", () => {
    const layout = loadLayout(makeFixture().root);
    expect(() => readRegistry(layout)).toThrow(RegistryMissing);
  });

  it("rejects role keys, games and transfers that config.json does not define", () => {
    const layout = setup();
    const value = structuredClone(registryInput()) as Record<string, Record<string, unknown>>;
    Object.assign(value, { revision: 1, updatedAt: "2026-11-04T03:00:00Z" });
    value.roles!["unknown-game/tech"] = { conversations: {}, ownership: "active", worktree: "." };
    value.operations!["unknown-game"] = { busOwner: "nobody" };
    try {
      RegistrySchema.validate(layout.config, value);
      expect.unreachable();
    } catch (error) {
      const issues = (error as ValidationError).issues.join("\n");
      expect(issues).toContain("/roles/unknown-game/tech: is not a role in config.json");
      expect(issues).toContain("/operations/unknown-game: is not a game in config.json");
      expect(issues).toContain(
        "/operations/unknown-game/busOwner: is not a registered role or duty",
      );
    }
  });
});

describe("updateRegistry", () => {
  it("increments the revision, sets updatedAt and persists the mutation", () => {
    const layout = setup();
    const next = updateRegistry(
      layout,
      1,
      (draft) => {
        draft.operations["archies-dog-walks"]!.lastAdoption = {
          at: "2026-11-04T03:00:00Z",
          cliSha256: "a".repeat(64),
          version: "1.0.0",
        };
      },
      { now: () => new Date("2026-11-04T04:00:00.000Z") },
    );
    expect(next.revision).toBe(2);
    expect(next.updatedAt).toBe("2026-11-04T04:00:00.000Z");
    expect(readRegistry(layout)).toEqual(next);
  });

  it("rejects a stale revision with RevisionConflict and leaves the file unchanged", () => {
    const layout = setup();
    updateRegistry(layout, 1, () => undefined);
    const before = readFileSync(layout.registryFile);
    expect(() => updateRegistry(layout, 1, () => undefined)).toThrow(RevisionConflict);
    expect(readFileSync(layout.registryFile)).toEqual(before);
  });

  it("rejects an invalid result and leaves the file unchanged", () => {
    const layout = setup();
    const before = readFileSync(layout.registryFile);
    expect(() =>
      updateRegistry(layout, 1, (draft) => {
        draft.roles["game-dev"]!.worktree = "/absolute";
      }),
    ).toThrow(ValidationError);
    expect(readFileSync(layout.registryFile)).toEqual(before);
    expect(readdirSync(layout.varDir).sort()).toEqual(["registry.json", "registry.lock"]);
  });

  it("serializes concurrent writers in separate processes without losing an update", async () => {
    const layout = setup();
    const writers = 6;
    const rounds = 5;
    const body = `
const [root, id, rounds] = process.argv.slice(1);
const layout = registry.loadLayout(root);
for (let round = 0; round < Number(rounds); round += 1) {
  for (;;) {
    const current = registry.readRegistry(layout);
    try {
      registry.updateRegistry(layout, current.revision, (draft) => {
        draft.transfers.push({ checkpoint: "var/handoffs/x.json", from: "codex", marker: \`w\${id}-\${round}\`,
          phase: "source-held", roles: ["game-dev"], to: "claude" });
      });
      break;
    } catch (error) {
      if (!(error instanceof registry.RevisionConflict)) throw error;
    }
  }
}`;
    const results = await Promise.all(
      Array.from({ length: writers }, (_, id) =>
        runChild(body, [layout.root, String(id), String(rounds)]),
      ),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);
    const registry = readRegistry(layout);
    expect(registry.revision).toBe(1 + writers * rounds);
    expect(new Set(registry.transfers.map((transfer) => transfer.marker)).size).toBe(
      writers * rounds,
    );
  });

  it("keeps the previous registry when a writer dies between the synced write and the rename", async () => {
    const layout = setup();
    const before = readFileSync(layout.registryFile);
    const body = `
const layout = registry.loadLayout(process.argv[1]);
registry.updateRegistry(layout, 1, (draft) => { draft.harness = "codex"; }, {
  onStage: (stage) => { if (stage === "synced") process.kill(process.pid, "SIGKILL"); },
});`;
    expect(await runChild(body, [layout.root])).toEqual({ code: null, signal: "SIGKILL" });
    expect(readFileSync(layout.registryFile)).toEqual(before);
    expect(readdirSync(layout.varDir).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    expect(lockIsFree(layout.registryLock)).toBe(true);
    expect(updateRegistry(layout, 1, () => undefined).revision).toBe(2);
    expect(readdirSync(layout.varDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the new registry when a writer dies after the rename", async () => {
    const layout = setup();
    const body = `
const layout = registry.loadLayout(process.argv[1]);
registry.updateRegistry(layout, 1, (draft) => { draft.harness = "codex"; }, {
  onStage: (stage) => { if (stage === "renamed") process.kill(process.pid, "SIGKILL"); },
});`;
    expect(await runChild(body, [layout.root])).toEqual({ code: null, signal: "SIGKILL" });
    expect(readRegistry(layout)).toMatchObject({ harness: "codex", revision: 2 });
  });

  it("waits for a registry lock held by another process", () => {
    const layout = setup();
    const holder = spawnSync("flock", [
      layout.registryLock,
      process.execPath,
      "--input-type=module",
      "-e",
      childScript(`
const layout = registry.loadLayout(process.argv[1]);
try { registry.updateRegistry(layout, 1, () => undefined, { timeoutSeconds: 1 }); }
catch (error) { if (error instanceof registry.LockBusy) process.exit(3); throw error; }`),
      layout.root,
    ]);
    expect(holder.status).toBe(3);
  });

  it("writes under a registry lock the caller already holds", () => {
    const fixture = makeFixture();
    const layout = loadLayout(fixture.root);
    mkdirSync(layout.varDir, { recursive: true });
    const held = holdLock(layout.registryLock);
    try {
      const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
      // A second descriptor waits on the caller's own lock.
      expect(() => createRegistry(layout, input, { timeoutSeconds: 1 })).toThrow(LockBusy);
      createRegistry(layout, input, { held, timeoutSeconds: 1 });
      const updated = updateRegistry(
        layout,
        1,
        (draft) => {
          draft.harness = "codex";
        },
        { held, timeoutSeconds: 1 },
      );
      expect(updated).toMatchObject({ harness: "codex", revision: 2 });
      expect(lockIsFree(layout.registryLock)).toBe(false);
    } finally {
      held.release();
    }
    expect(lockIsFree(layout.registryLock)).toBe(true);
  });

  it("rejects a held lock that is not var/registry.lock", () => {
    const layout = setup();
    const other = holdLock(join(layout.varDir, "other.lock"));
    try {
      expect(() =>
        updateRegistry(layout, 1, () => undefined, { held: other, timeoutSeconds: 1 }),
      ).toThrow(LockError);
      expect(readRegistry(layout).revision).toBe(1);
    } finally {
      other.release();
    }
  });
});

describe("resolveConversation", () => {
  it("follows a harness flip and keeps the other harness's IDs", () => {
    const layout = setup();
    const claude = readRegistry(layout);
    expect(resolveConversation(claude, "archies-dog-walks/tech")).toBe(CLAUDE_TECH);
    expect(resolveConversation(claude, "monitor")).toBe(CLAUDE_GAME_DEV);
    const codex = updateRegistry(layout, claude.revision, (draft) => {
      draft.harness = "codex";
    });
    expect(resolveConversation(codex, "archies-dog-walks/tech")).toBe(CODEX_TECH);
    expect(resolveConversation(codex, "game-dev")).toBeNull();
    expect(codex.roles["archies-dog-walks/tech"]?.conversations.claude).toBe(CLAUDE_TECH);
  });

  it("rejects unknown roles and duties held by more than one role", () => {
    const layout = setup();
    const registry = updateRegistry(layout, 1, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.duties = ["coordinator"];
    });
    expect(() => resolveRole(registry, "nobody")).toThrow(UnknownRole);
    expect(() => resolveRole(registry, "coordinator")).toThrow(AmbiguousRole);
    expect(resolveRole(registry, "monitor")).toBe("game-dev");
  });
});
