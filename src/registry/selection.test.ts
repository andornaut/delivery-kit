import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadLayout, roleKeys } from "../layout.ts";
import { holdLock, LockBusy } from "../lock.ts";
import { makeFixture, registryInput, writeFixtureJson } from "../testFixtures.ts";
import { ValidationError } from "../validate.ts";
import {
  createRegistry,
  type HarnessSelection,
  readRegistry,
  type Registry,
  type RegistryDraft,
  resolveConversation,
  resolveHarness,
  resolveSelectedRoles,
  RevisionConflict,
  selectHarness,
  UnknownRole,
  updateRegistry,
} from "./index.ts";

function setup() {
  const fixture = makeFixture();
  const original = loadLayout(fixture.root);
  writeFixtureJson(original.configFile, {
    ...original.config,
    games: {
      ...original.config.games,
      ada: { name: "Ada the Navigator", path: "../ada", roles: ["art", "gameplay", "tech"] },
    },
  });
  const layout = loadLayout(fixture.root);
  const roles = Object.fromEntries(
    roleKeys(layout.config).map((key, index) => [
      key,
      {
        activation: { checkpoint: "var/handoffs/role.json", marker: `role-${index}` },
        branch: "main",
        conversations: {
          claude: `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
          codex: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        },
        ownership: "active",
        phase: "source-held",
        worktree: `.worktrees/${key.replaceAll("/", "-")}`,
      },
    ]),
  );
  const input = { ...registryInput(), harness: "codex", roles } as unknown as Omit<
    Registry,
    "revision" | "updatedAt"
  >;
  createRegistry(layout, input);
  return layout;
}

const ARCHIE = "archies-dog-walks";

describe("resolveSelectedRoles", () => {
  it("expands configured game roles and deduplicates explicit roles", () => {
    const layout = setup();
    expect(
      resolveSelectedRoles(layout, readRegistry(layout), {
        games: [ARCHIE],
        roles: ["game-dev", `${ARCHIE}/tech`],
      }),
    ).toEqual([`${ARCHIE}/art`, `${ARCHIE}/gameplay`, `${ARCHIE}/tech`, "game-dev"]);
  });

  it("rejects missing, empty, malformed and unknown selectors", () => {
    const layout = setup();
    for (const selection of [
      {},
      { games: [] },
      { roles: [] },
      { games: ["absent"] },
      { roles: ["game-dev", "game-dev"] },
      { roles: [null] },
      { all: true },
      null,
    ]) {
      expect(() => resolveSelectedRoles(layout, readRegistry(layout), selection as never)).toThrow(
        ValidationError,
      );
    }
    expect(() => resolveSelectedRoles(layout, readRegistry(layout), { roles: ["absent"] })).toThrow(
      UnknownRole,
    );
  });

  it("rejects games with unregistered roles", () => {
    const layout = setup();
    const registry = updateRegistry(layout, 1, (draft) => {
      delete draft.roles[`${ARCHIE}/art`];
    });
    expect(() => resolveSelectedRoles(layout, registry, { games: [ARCHIE] })).toThrow(UnknownRole);
  });
});

describe("selectHarness", () => {
  it("changes only selected overrides and preserves Ada, Chibi, kits and operational evidence", () => {
    const layout = setup();
    const before = readRegistry(layout);
    const next = selectHarness(layout, before.revision, { harness: "claude", games: [ARCHIE] });
    const expected = structuredClone(before.roles) as RegistryDraft["roles"];
    for (const role of layout.config.games[ARCHIE]!.roles) {
      expected[`${ARCHIE}/${role}`]!.harness = "claude";
    }
    expect(next.roles).toEqual(expected);
    expect(next).toEqual({ ...before, revision: 2, updatedAt: next.updatedAt, roles: expected });
    expect(readRegistry(layout)).toEqual(next);
    expect(resolveHarness(next, `${ARCHIE}/tech`)).toBe("claude");
    expect(resolveHarness(next, "chibis-way-home/tech")).toBe("codex");
    expect(resolveHarness(next, "ada/tech")).toBe("codex");
    expect(resolveHarness(next, "game-dev")).toBe("codex");
    expect(next.roles[`${ARCHIE}/tech`]!.phase).toBe("source-held");
  });

  it("clears only selected overrides for default and resolves the global transport", () => {
    const layout = setup();
    const selected = selectHarness(layout, 1, { harness: "claude", games: [ARCHIE] });
    const next = selectHarness(layout, selected.revision, {
      harness: "default",
      roles: [`${ARCHIE}/tech`],
    });
    expect(Object.hasOwn(next.roles[`${ARCHIE}/tech`]!, "harness")).toBe(false);
    expect(resolveHarness(next, `${ARCHIE}/tech`)).toBe("codex");
    expect(next.roles[`${ARCHIE}/art`]).toEqual(selected.roles[`${ARCHIE}/art`]);
    expect(next.roles[`${ARCHIE}/gameplay`]).toEqual(selected.roles[`${ARCHIE}/gameplay`]);
  });

  it("selects a shared role and retains both providers' conversation IDs", () => {
    const layout = setup();
    const before = readRegistry(layout);
    const next = selectHarness(layout, 1, { harness: "claude", roles: ["game-dev"] });
    expect(resolveHarness(next, "game-dev")).toBe("claude");
    expect(next.roles["game-dev"]!.conversations).toEqual(before.roles["game-dev"]!.conversations);
    expect(resolveConversation(next, "game-dev")).toBe(
      before.roles["game-dev"]!.conversations.claude,
    );
  });

  it("rejects a partially invalid selection atomically", () => {
    const layout = setup();
    const before = readFileSync(layout.registryFile);
    expect(() =>
      selectHarness(layout, 1, { harness: "claude", roles: [`${ARCHIE}/tech`, "absent"] }),
    ).toThrow(UnknownRole);
    expect(readFileSync(layout.registryFile)).toEqual(before);
  });

  it("rejects an unavailable selected ID without falling back to the other provider", () => {
    const layout = setup();
    const registry = updateRegistry(layout, 1, (draft) => {
      draft.roles[`${ARCHIE}/art`]!.conversations.claude = null;
    });
    const before = readFileSync(layout.registryFile);
    expect(() =>
      selectHarness(layout, registry.revision, { harness: "claude", games: [ARCHIE] }),
    ).toThrow(/selected conversation is unavailable/);
    expect(readFileSync(layout.registryFile)).toEqual(before);
  });

  it("rejects invalid harnesses, absent selectors and extra fields without writing", () => {
    const layout = setup();
    const before = readFileSync(layout.registryFile);
    for (const selection of [
      { harness: "other", roles: ["game-dev"] },
      { harness: "claude" },
      { harness: "claude", roles: [] },
      { harness: "claude", roles: ["game-dev"], activation: true },
      null,
    ]) {
      expect(() => selectHarness(layout, 1, selection as HarnessSelection)).toThrow(
        ValidationError,
      );
      expect(readFileSync(layout.registryFile)).toEqual(before);
    }
  });

  it("checks the revision before resolving selection against the locked current registry", () => {
    const layout = setup();
    updateRegistry(layout, 1, (draft) => {
      delete draft.roles["art-kit"];
    });
    const before = readFileSync(layout.registryFile);
    expect(() => selectHarness(layout, 1, { harness: "claude", roles: ["art-kit"] })).toThrow(
      RevisionConflict,
    );
    expect(() => selectHarness(layout, 2, { harness: "claude", roles: ["art-kit"] })).toThrow(
      UnknownRole,
    );
    expect(readFileSync(layout.registryFile)).toEqual(before);
  });

  it("uses the existing lock and supports the caller's held registry lock", () => {
    const layout = setup();
    const held = holdLock(layout.registryLock);
    const before = readFileSync(layout.registryFile);
    try {
      expect(() =>
        selectHarness(layout, 1, { harness: "claude", roles: ["game-dev"] }, { timeoutSeconds: 0 }),
      ).toThrow(LockBusy);
      expect(readFileSync(layout.registryFile)).toEqual(before);
      expect(
        selectHarness(layout, 1, { harness: "claude", roles: ["game-dev"] }, { held }).revision,
      ).toBe(2);
    } finally {
      held.release();
    }
  });
});
