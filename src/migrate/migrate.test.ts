// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../commands/migrate.ts";
import { gameLayout, loadLayout } from "../layout.ts";
import { holdLock, type LockHandle } from "../lock.ts";
import { readRegistry } from "../registry/store.ts";
import { type Fixture, makeFixture } from "../testFixtures.ts";
import { runRemoveLegacy } from "./migrate.ts";
import type { ProcessProbe } from "./runnerRecord.ts";
import { removeOwnedTree } from "./tree.ts";

const ARCHIE = "archies-dog-walks";
const CHIBI = "chibis-way-home";
const SHA = "a".repeat(40);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function put(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function link(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

function writeJson(path: string, value: unknown): void {
  put(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface Tree {
  readonly fixture: Fixture;
  readonly env: NodeJS.ProcessEnv;
  readonly archieBus: string;
  readonly chibiBus: string;
  readonly monitor: string;
  readonly libraries: string;
  readonly route: string;
}

function libraryEntry(name: string, claude: number, codex: number, checkpoint?: string): unknown {
  return {
    ownership: "active",
    active_owner: {
      harness: "claude",
      activation_marker: `${name}-marker`,
      worktree: `~/game-dev/.worktrees/${name}`,
    },
    ...(checkpoint === undefined ? {} : { activation_checkpoint: checkpoint }),
    providers: {
      claude: {
        session_id: id(claude),
        phase: "active",
        worktree: `~/game-dev/.worktrees/${name}`,
      },
      codex: { thread_id: id(codex), phase: "retired" },
    },
  };
}

function buildTree(): Tree {
  const fixture = makeFixture();
  const { base, root } = fixture;
  // The 0.x skills record home-relative paths; HOME is the fixture base, so ~/game-dev is root.
  const home = base;
  const archieBus = join(base, ARCHIE, ".claude", "bus");
  const chibiBus = join(base, CHIBI, ".claude", "bus");
  const monitor = join(root, ".claude", "monitor", "codex");

  for (const name of [
    "batch.sh",
    "bus-common.sh",
    "resource-check.sh",
    "runner.sh",
    "event.py",
    "unblock.py",
  ]) {
    put(join(archieBus, name), `#!/bin/sh\n# ${name}\n`);
  }
  put(join(archieBus, "bus-common.sh.map-migration-backup"), "backup\n");
  put(join(archieBus, "bus.conf"), "MAIN=main\n");
  put(join(archieBus, "runner.log"), "current runner log\n");
  put(join(archieBus, "codex-bus.log"), "older log\n");
  for (const name of [
    "bus-queue",
    "bus-queue.lock",
    "runner.lock",
    "loop.lock",
    "active-departure",
    "requests/requests.lock",
    "events/state.lock",
    "events/dispatch.lock",
    "unblock/unblock.lock",
    `ci/${SHA}.lock`,
  ]) {
    put(join(archieBus, name));
  }
  put(join(archieBus, "last-push.sha"), `${SHA}\n`);
  writeJson(join(archieBus, "feature-queued.json"), { branch: "bus/feature" });
  writeJson(join(archieBus, "feature-ready.json"), { branch: "bus/feature" });
  put(join(archieBus, `ci/${SHA}.status`), "success\n");
  writeJson(join(archieBus, "requests/one.json"), { id: "one", state: "finished" });
  writeJson(join(archieBus, "unblock/claude-spool/brief.json"), { text: "pending" });
  put(join(archieBus, "npm-cache/_cacache/index"), "cache\n");
  put(join(archieBus, "__pycache__/event.pyc"), "bytecode");
  put(join(archieBus, "tests/wiring.py"), "# nested scripts are state\n");
  link(join(archieBus, "last-push.link"), "last-push.sha");
  link(join(archieBus, "check/venv/bin/node"), "/usr/bin/node");
  chmodSync(join(archieBus, "requests/one.json"), 0o640);

  for (const name of ["batch.sh", "bus-common.sh", "event.py", "unblock.py"]) {
    link(join(chibiBus, name), join(archieBus, name));
  }
  put(join(chibiBus, "runner.sh"), "#!/bin/sh\n");
  put(join(chibiBus, "runner.before-monitor-041.sh"), "#!/bin/sh\n");
  put(join(chibiBus, "bus.conf.before-upgrade"), "MAIN=main\n");
  put(join(chibiBus, "codex-bus.log"), "chibi runner log\n");
  put(join(chibiBus, "delivery-kit-rollback-1/bus.conf"), "MAIN=main\n");
  put(join(chibiBus, "active-departure"));
  writeJson(join(chibiBus, "release-approved.json"), { approved: true });

  writeJson(join(monitor, "current-state.json"), { slot: "20" });
  const route = join(base, ARCHIE, ".claude", "monitor", "route.json");
  // A version 1 Codex route: the game-dev monitor, Archie Tech and art-kit by Codex thread ID,
  // with Archie Tech also listed by its Claude session ID.
  writeJson(route, {
    host_project_root: join(base, ARCHIE),
    monitor_thread_id: id(32),
    state: "active",
    targets: [
      { ownership: "active", thread_id: id(57) },
      { ownership: "held", thread_id: id(12) },
      { ownership: "active", thread_id: id(52) },
    ],
    version: 1,
  });
  chmodSync(route, 0o600);
  writeJson(join(monitor, "acks/one.json"), { ack: true });
  put(join(monitor, "delivery-kit/0123abc/README.md"), "snapshot\n");
  put(join(monitor, "__pycache__/monitor.pyc"), "bytecode");
  put(join(monitor, "adopt.py"), "# script\n");

  const checkpoint = join(root, ".claude", "handoffs", "monitor-transfer.json");
  writeJson(checkpoint, { checkpoint: true });
  const transferCheckpoint = join(root, ".claude", "handoffs", "kit-transfer.md");
  put(transferCheckpoint, "# transfer\n");
  const libraries = join(base, "state", "game-sessions", "libraries.json");
  const kit = libraryEntry(
    "delivery-kit",
    21,
    22,
    "~/game-dev/.claude/handoffs/monitor-transfer.json",
  );
  writeJson(libraries, {
    version: 3,
    host: { game: "game-dev", native_project_id: id(90), root: "~/game-dev" },
    active_projects: {
      [join(base, ARCHIE)]: { active: true, game: ARCHIE },
      [join(base, CHIBI)]: { active: false, game: CHIBI },
    },
    "game-dev": {
      ownership: "active",
      active_owner: {
        harness: "claude",
        confirmation_marker: "monitor-transfer:claude",
        thread_id: id(31),
      },
      activation_checkpoint: checkpoint,
      bus_operations: {
        [CHIBI]: { ownership: "active", activation_marker: "bus-operations:monitor" },
      },
      providers: {
        claude: { session_id: id(31), phase: "active", worktree: "~/game-dev" },
        codex: {
          thread_id: id(32),
          phase: "stopped",
          worktree: "~/game-dev/.claude/monitor/codex",
        },
      },
      provider_transfer: { marker: "codex-to-claude", phase: "target-held" },
      projects: [
        { game: ARCHIE, providers: { codex: { art: id(55), gameplay: id(56), tech: id(57) } } },
      ],
    },
    libraries: {
      "art-kit": libraryEntry("art-kit", 11, 12),
      "delivery-kit": {
        ...(kit as object),
        provider_transfer: {
          marker: "kit-transfer",
          phase: "active-confirmed",
          checkpoint: transferCheckpoint,
          source: { harness: "codex" },
        },
      },
      "game-kit": libraryEntry("game-kit", 13, 14),
    },
  });
  writeJson(join(root, ".claude", "session-state", "shared-host.json"), {
    native_project_id: id(90),
    roles: { monitor: id(32), "art-kit": id(12) },
    claude_roles: { "art-kit": id(99) },
  });
  for (const [game, offset] of [
    [ARCHIE, 50],
    [CHIBI, 60],
  ] as const) {
    const sessions: Record<string, unknown> = {};
    const codex: Record<string, string> = {};
    for (const [index, role] of ["art", "gameplay", "tech"].entries()) {
      sessions[role] = {
        activation_marker: `${game}-${role}`,
        phase: "active",
        session_id: id(offset + index),
        worktree: join(base, game, ".claude", "worktrees", `claude-${role}`),
      };
      codex[role] = id(offset + 5 + index);
    }
    writeJson(join(base, game, ".claude", "session-state", "game-sessions.json"), {
      claude: sessions,
    });
    writeJson(join(base, game, ".claude", "session-state", "game-sessions-project.json"), {
      codex,
      game,
    });
  }
  return {
    archieBus,
    chibiBus,
    env: { HOME: home, XDG_STATE_HOME: join(base, "state") },
    fixture,
    libraries,
    monitor,
    route,
  };
}

interface Run {
  readonly status: number;
  readonly out: string;
  readonly err: string;
}

async function run(tree: Tree, ...args: string[]): Promise<Run> {
  let out = "";
  let err = "";
  const status = await migrate(
    {
      cwd: tree.fixture.root,
      env: tree.env,
      err: (text) => (err += text),
      out: (text) => (out += text),
    },
    tree.fixture.root,
    args,
  );
  return { err, out, status };
}

function listing(root: string): string[] {
  const names: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      names.push(path);
      const stats = lstatSync(join(root, path));
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        walk(path);
      }
    }
  };
  walk("");
  return names;
}

function writable(path: string): boolean {
  return (statSync(path).mode & 0o222) !== 0;
}

let tree: Tree;
const locks: LockHandle[] = [];

beforeEach(() => {
  tree = buildTree();
});

afterEach(() => {
  for (const lock of locks.splice(0)) {
    lock.release();
  }
  removeOwnedTree(tree.fixture.base);
});

describe("migrate --dry-run", () => {
  it("reports the plan and writes nothing", async () => {
    const result = await run(tree, "--dry-run");
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(result.out).toContain(`${ARCHIE}: copy ${tree.archieBus}`);
    expect(result.out).toContain("runner log: runner.log -> runner.log (moved)");
    expect(result.out).toContain("runner log: codex-bus.log -> runner.log (moved)");
    expect(result.out).toContain("dry run: nothing written");
    expect(existsSync(join(tree.fixture.root, "var"))).toBe(false);
    expect(writable(tree.archieBus)).toBe(true);
    expect(existsSync(join(tree.archieBus, "runner.log"))).toBe(true);
  });
});

describe("migrate", () => {
  it("copies state, moves runner logs, builds the registry and locks the old trees", async () => {
    const before = readFileSync(tree.libraries, "utf8");
    const result = await run(tree);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    const layout = loadLayout(tree.fixture.root);
    const archie = gameLayout(layout, ARCHIE);
    const chibi = gameLayout(layout, CHIBI);

    expect(listing(archie.busDir)).toEqual([
      "active-departure",
      "bus-queue",
      "bus-queue.lock",
      "check",
      "check/venv",
      "check/venv/bin",
      "check/venv/bin/node",
      "ci",
      `ci/${SHA}.lock`,
      `ci/${SHA}.status`,
      "codex-bus.log",
      "events",
      "events/dispatch.lock",
      "events/state.lock",
      "feature-queued.json",
      "feature-ready.json",
      "last-push.link",
      "last-push.sha",
      "loop.lock",
      "requests",
      "requests/one.json",
      "requests/requests.lock",
      "runner.lock",
      "runner.log",
      "tests",
      "tests/wiring.py",
      "unblock",
      "unblock/claude-spool",
      "unblock/claude-spool/brief.json",
      "unblock/unblock.lock",
    ]);
    expect(readFileSync(join(archie.busDir, "runner.log"), "utf8")).toBe("current runner log\n");
    // Tech-owned records alone never block: they are copied unchanged and listed.
    for (const name of ["feature-queued.json", "feature-ready.json"]) {
      expect(readFileSync(join(archie.busDir, name))).toEqual(
        readFileSync(join(tree.archieBus, name)),
      );
    }
    expect(result.out).toContain(
      "Tech-owned records, copied, not acted on: feature-queued.json, feature-ready.json",
    );
    expect(readFileSync(join(archie.busDir, "codex-bus.log"), "utf8")).toBe("older log\n");
    expect(readlinkSync(join(archie.busDir, "last-push.link"))).toBe("last-push.sha");
    expect(readlinkSync(join(archie.busDir, "check/venv/bin/node"))).toBe("/usr/bin/node");
    expect(statSync(join(archie.busDir, "requests/one.json")).mode & 0o777).toBe(0o640);
    expect(existsSync(join(tree.archieBus, "runner.log"))).toBe(false);

    expect(listing(chibi.busDir)).toEqual([
      "active-departure",
      "release-approved.json",
      "runner.log",
    ]);
    expect(readFileSync(join(chibi.busDir, "runner.log"), "utf8")).toBe("chibi runner log\n");
    expect(existsSync(join(tree.chibiBus, "codex-bus.log"))).toBe(false);

    expect(listing(layout.monitorDir)).toEqual(["acks", "acks/one.json", "current-state.json"]);

    const marker = JSON.parse(readFileSync(archie.migratedFile, "utf8")) as Record<string, unknown>;
    expect(marker).toMatchObject({
      log: { from: "runner.log", to: "runner.log" },
      schema: 1,
      source: tree.archieBus,
      target: archie.busDir,
    });
    expect(marker.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(marker.excluded).toEqual(
      expect.arrayContaining(["batch.sh", "bus.conf", "npm-cache/", "__pycache__/"]),
    );

    const registry = readRegistry(layout);
    expect(registry.revision).toBe(1);
    expect(registry.harness).toBe("claude");
    expect(registry.host).toEqual({ nativeProjectId: id(90), root: "." });
    expect(registry.roles[`${ARCHIE}/tech`]).toEqual({
      activation: { marker: `${ARCHIE}-tech` },
      conversations: { claude: id(52), codex: id(57) },
      ownership: "active",
      phase: "active",
      worktree: `../${ARCHIE}/.claude/worktrees/claude-tech`,
    });
    expect(registry.roles[`${CHIBI}/art`]?.conversations).toEqual({
      claude: id(60),
      codex: id(65),
    });
    expect(registry.roles[`${CHIBI}/art`]?.ownership).toBe("inactive");
    expect(registry.roles["game-dev"]).toMatchObject({
      activation: {
        checkpoint: "var/handoffs/game-dev/monitor-transfer.json",
        marker: "monitor-transfer:claude",
      },
      conversations: { claude: id(31), codex: id(32) },
      duties: ["monitor", "coordinator"],
      worktree: ".",
    });
    expect(registry.operations).toEqual({
      [ARCHIE]: { busOwner: `${ARCHIE}/tech` },
      [CHIBI]: { activation: { marker: "bus-operations:monitor" }, busOwner: "game-dev" },
    });
    expect(registry.transfers).toEqual([
      {
        checkpoint: "var/handoffs/kits/delivery-kit/kit-transfer.md",
        from: "codex",
        marker: "kit-transfer",
        phase: "active-confirmed",
        roles: ["delivery-kit"],
        to: "claude",
      },
    ]);
    expect(
      readFileSync(join(layout.handoffsDir, "kits/delivery-kit/kit-transfer.md"), "utf8"),
    ).toBe("# transfer\n");
    expect(registry.roles["delivery-kit"]?.activation?.checkpoint).toBe(
      "var/handoffs/kits/delivery-kit/monitor-transfer.json",
    );

    const provenance = JSON.parse(
      readFileSync(join(layout.varDir, "registry-provenance.json"), "utf8"),
    ) as {
      fields: Record<string, { source: string; key: string }>;
      conflicts: string[];
      skipped: string[];
    };
    expect(provenance.fields[`/roles/${ARCHIE}~1tech/conversations/codex`]).toEqual({
      key: "game-dev.projects[0].providers.codex.tech",
      source: tree.libraries,
    });
    expect(provenance.fields[`/roles/${CHIBI}~1tech/conversations/codex`]?.key).toBe("codex.tech");
    expect(provenance.conflicts).toEqual([
      expect.stringContaining("/roles/art-kit/conversations/claude"),
    ]);
    expect(provenance.skipped).toEqual([expect.stringContaining("game-dev.provider_transfer")]);

    for (const path of [
      tree.archieBus,
      join(tree.archieBus, "bus-queue"),
      tree.chibiBus,
      tree.monitor,
    ]) {
      expect(writable(path)).toBe(false);
    }
    expect(readFileSync(tree.libraries, "utf8")).toBe(before);

    expect(JSON.parse(readFileSync(layout.routeFile, "utf8"))).toEqual({
      host: ARCHIE,
      monitor: "game-dev",
      schema: 1,
      state: "active",
      targets: [`${ARCHIE}/tech`, "art-kit"],
    });
    expect(readFileSync(layout.routeFile, "utf8")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(statSync(layout.routeFile).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(join(layout.varDir, "route.migrated.json"), "utf8")),
    ).toMatchObject({
      entries: 1,
      schema: 1,
      source: tree.route,
      sourceDigest: createHash("sha256").update(readFileSync(tree.route)).digest("hex"),
      target: layout.routeFile,
      unit: "route",
    });
    expect(writable(tree.route)).toBe(false);
  });

  it("is a no-op when the marker matches", async () => {
    expect((await run(tree)).status).toBe(0);
    const layout = loadLayout(tree.fixture.root);
    const registry = readFileSync(layout.registryFile, "utf8");
    const second = await run(tree);
    expect(second.err).toBe("");
    expect(second.status).toBe(0);
    expect(second.out).toContain(`${ARCHIE}: already migrated`);
    expect(second.out).toContain("route: already migrated");
    expect(second.out).toContain("exists; not rebuilt");
    expect(readFileSync(layout.registryFile, "utf8")).toBe(registry);
  });

  it("stops when the source changed after migration", async () => {
    expect((await run(tree)).status).toBe(0);
    chmodSync(tree.archieBus, 0o700);
    put(join(tree.archieBus, "late-state.json"), "{}\n");
    const result = await run(tree, "--game", ARCHIE);
    expect(result.status).toBe(1);
    expect(result.err).toContain("changed since it was migrated");
  });

  it("stops on a target without a marker", async () => {
    const busDir = gameLayout(loadLayout(tree.fixture.root), ARCHIE).busDir;
    mkdirSync(busDir, { recursive: true });
    const result = await run(tree, "--game", ARCHIE);
    expect(result.status).toBe(1);
    expect(result.err).toContain("exists without");
    expect(writable(tree.archieBus)).toBe(true);
  });

  it("discards a leftover staging directory", async () => {
    const stateDir = gameLayout(loadLayout(tree.fixture.root), ARCHIE).stateDir;
    put(join(stateDir, ".bus.staging", "partial"), "half\n");
    chmodSync(join(stateDir, ".bus.staging"), 0o500);
    const result = await run(tree, "--game", ARCHIE);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(stateDir, ".bus.staging"))).toBe(false);
    expect(existsSync(join(stateDir, "bus", "partial"))).toBe(false);
  });

  it("with --game migrates only that game and leaves the registry alone", async () => {
    const result = await run(tree, "--game", CHIBI);
    expect(result.status).toBe(0);
    const layout = loadLayout(tree.fixture.root);
    expect(existsSync(gameLayout(layout, CHIBI).migratedFile)).toBe(true);
    expect(existsSync(gameLayout(layout, ARCHIE).busDir)).toBe(false);
    expect(existsSync(layout.registryFile)).toBe(false);
    expect(writable(tree.archieBus)).toBe(true);
  });
});

describe("migrate route", () => {
  const writeRoute = (value: Record<string, unknown>): void =>
    writeJson(tree.route, { host_project_root: join(tree.fixture.base, ARCHIE), ...value });

  it("converts a version 2 Claude route by session ID and keeps a held state", async () => {
    writeRoute({
      monitor: { name: "monitor", ownership: "active", session_id: id(31) },
      state: "held",
      targets: [
        { name: "Chibi tech", ownership: "active", session_id: id(62) },
        { name: "kit", ownership: "held", session_id: id(21) },
      ],
      version: 2,
    });
    const result = await run(tree);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(tree.fixture.root, "var", "route.json"), "utf8"))).toEqual({
      host: ARCHIE,
      monitor: "game-dev",
      schema: 1,
      state: "held",
      targets: [`${CHIBI}/tech`, "delivery-kit"],
    });
  });

  it("stops before any write when an ID maps to no role, listing every one", async () => {
    writeRoute({
      monitor_thread_id: id(32),
      state: "active",
      targets: [{ thread_id: id(800) }, { thread_id: id(57) }, { thread_id: id(801) }],
      version: 1,
    });
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain(`map to no registry role: ${id(800)}, ${id(801)}`);
    expect(existsSync(join(tree.fixture.root, "var", "route.json"))).toBe(false);
    expect(existsSync(join(tree.fixture.root, "var", "registry.json"))).toBe(false);
    expect(writable(tree.route)).toBe(true);
  });

  it("stops when an ID belongs to more than one role", async () => {
    const libraries = JSON.parse(readFileSync(tree.libraries, "utf8")) as {
      libraries: Record<string, { providers: { claude: { session_id: string } } }>;
    };
    const gameKit = libraries.libraries["game-kit"];
    if (gameKit === undefined) {
      throw new Error("fixture has no game-kit library");
    }
    gameKit.providers.claude.session_id = id(11);
    writeJson(tree.libraries, libraries);
    writeRoute({
      monitor_thread_id: id(32),
      state: "active",
      targets: [{ thread_id: id(11) }],
      version: 1,
    });
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain(`more than one registry role: ${id(11)} (art-kit, game-kit)`);
    expect(existsSync(join(tree.fixture.root, "var", "route.json"))).toBe(false);
  });

  it("stops on a route of an unknown version or state", async () => {
    writeRoute({ monitor_thread_id: id(32), state: "active", targets: [], version: 3 });
    expect((await run(tree, "--dry-run")).err).toContain("version must be 1 or 2");
    writeRoute({ monitor_thread_id: id(32), state: "paused", targets: [], version: 1 });
    expect((await run(tree, "--dry-run")).err).toContain("invalid monitor route schema");
  });

  it("stops on an active route with no targets", async () => {
    writeRoute({ monitor_thread_id: id(32), state: "active", targets: [], version: 1 });
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain("an active route needs targets distinct from its monitor");
    expect(existsSync(join(tree.fixture.root, "var", "route.json"))).toBe(false);
    expect(existsSync(join(tree.fixture.root, "var", "registry.json"))).toBe(false);
  });

  it("stops on an active route that lists its monitor as a target", async () => {
    // The game-dev Claude session as a target resolves to the monitor role itself.
    writeRoute({
      monitor_thread_id: id(32),
      state: "active",
      targets: [{ thread_id: id(57) }, { thread_id: id(31) }],
      version: 1,
    });
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain("an active route needs targets distinct from its monitor");
    expect(existsSync(join(tree.fixture.root, "var", "route.json"))).toBe(false);
  });

  it("maps through an existing registry and is a no-op on rerun", async () => {
    const source = readFileSync(tree.route, "utf8");
    unlinkSync(tree.route);
    expect((await run(tree)).out).toContain("route: no game has");
    put(tree.route, source);
    const routeFile = join(tree.fixture.root, "var", "route.json");
    const converted = await run(tree);
    expect(converted.err).toBe("");
    expect(converted.out).toContain("exists; not rebuilt");
    expect(JSON.parse(readFileSync(routeFile, "utf8"))).toMatchObject({ monitor: "game-dev" });
    const written = readFileSync(routeFile, "utf8");
    const rerun = await run(tree);
    expect(rerun.err).toBe("");
    expect(rerun.status).toBe(0);
    expect(rerun.out).toContain("route: already migrated");
    expect(readFileSync(routeFile, "utf8")).toBe(written);
  });

  it("stops when the route changed after migration", async () => {
    expect((await run(tree)).status).toBe(0);
    chmodSync(tree.route, 0o600);
    writeJson(tree.route, { host_project_root: join(tree.fixture.base, ARCHIE), version: 2 });
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain("route: ");
    expect(result.err).toContain("changed since it was migrated");
  });

  it("stops on var/route.json without a marker", async () => {
    put(join(tree.fixture.root, "var", "route.json"), "{}\n");
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain("route.json exists without");
    expect(writable(tree.route)).toBe(true);
  });

  it("stops when more than one game has a route", async () => {
    writeJson(join(tree.fixture.base, CHIBI, ".claude", "monitor", "route.json"), {
      host_project_root: join(tree.fixture.base, CHIBI),
    });
    const result = await run(tree, "--dry-run");
    expect(result.status).toBe(1);
    expect(result.err).toContain("more than one game");
  });

  it("stops when the route names another host", async () => {
    writeJson(tree.route, { host_project_root: join(tree.fixture.base, CHIBI), version: 1 });
    const result = await run(tree, "--dry-run");
    expect(result.status).toBe(1);
    expect(result.err).toContain("host_project_root does not name");
  });

  it("notes a missing route and continues", async () => {
    removeOwnedTree(join(tree.fixture.base, ARCHIE, ".claude", "monitor"));
    const result = await run(tree);
    expect(result.status).toBe(0);
    expect(result.out).toContain("route: no game has .claude/monitor/route.json");
    expect(existsSync(join(tree.fixture.root, "var", "route.json"))).toBe(false);
  });

  it("leaves the route alone with --game", async () => {
    expect((await run(tree, "--game", ARCHIE)).status).toBe(0);
    expect(existsSync(join(tree.fixture.root, "var", "route.json"))).toBe(false);
    expect(writable(tree.route)).toBe(true);
  });
});

describe("migrate checkpoints", () => {
  interface Libraries {
    "game-dev": Record<string, unknown>;
    libraries: Record<string, Record<string, unknown>>;
  }

  function editLibraries(edit: (value: Libraries) => void): void {
    const value = JSON.parse(readFileSync(tree.libraries, "utf8")) as Libraries;
    edit(value);
    writeJson(tree.libraries, value);
  }

  function handoff(path: string): string {
    return join(loadLayout(tree.fixture.root).handoffsDir, path);
  }

  it("copies two same-named checkpoints of different scopes to their own scopes", async () => {
    const art = join(tree.fixture.base, "art-kit", ".claude", "SOURCE_HELD.json");
    const kit = join(tree.fixture.base, "delivery-kit", ".claude", "SOURCE_HELD.json");
    writeJson(art, { kit: "art-kit" });
    writeJson(kit, { kit: "delivery-kit" });
    editLibraries((value) => {
      (value.libraries["art-kit"] as Record<string, unknown>).source_hold_checkpoint = art;
      (value.libraries["delivery-kit"] as Record<string, unknown>).source_hold_checkpoint = kit;
    });
    const dry = await run(tree, "--dry-run");
    expect(dry.err).toBe("");
    expect(dry.status).toBe(0);
    const result = await run(tree);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(handoff("kits/art-kit/SOURCE_HELD.json"), "utf8")).toBe(
      readFileSync(art, "utf8"),
    );
    expect(readFileSync(handoff("kits/delivery-kit/SOURCE_HELD.json"), "utf8")).toBe(
      readFileSync(kit, "utf8"),
    );
    expect(existsSync(handoff("SOURCE_HELD.json"))).toBe(false);
  });

  it("reports and skips a referenced checkpoint that does not exist", async () => {
    const missing = join(tree.fixture.base, "art-kit", ".claude", "gone", "SOURCE_HELD.json");
    unlinkSync(join(tree.fixture.root, ".claude", "handoffs", "monitor-transfer.json"));
    editLibraries((value) => {
      (value.libraries["art-kit"] as Record<string, unknown>).source_hold_checkpoint = missing;
    });
    const dry = await run(tree, "--dry-run");
    expect(dry.err).toBe("");
    expect(dry.status).toBe(0);
    expect(dry.out).toContain(`checkpoint ${missing} (kits/art-kit): not a readable file`);
    expect(dry.out).toContain("monitor-transfer.json (game-dev): not a readable file");
    const result = await run(tree);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    const registry = readRegistry(loadLayout(tree.fixture.root));
    expect(registry.roles["game-dev"]?.activation).toEqual({ marker: "monitor-transfer:claude" });
    expect(existsSync(handoff("kits/art-kit"))).toBe(false);
    expect(existsSync(handoff("game-dev/monitor-transfer.json"))).toBe(false);
  });

  it("skips a byte-identical existing checkpoint and leaves live handoffs alone", async () => {
    put(handoff("kits/delivery-kit/kit-transfer.md"), "# transfer\n");
    put(handoff("kits/delivery-kit/current.md"), "# live checkpoint\n");
    const result = await run(tree);
    expect(result.err).toBe("");
    expect(result.status).toBe(0);
    expect(result.out).toContain(
      "checkpoint var/handoffs/kits/delivery-kit/kit-transfer.md already holds",
    );
    expect(readFileSync(handoff("kits/delivery-kit/current.md"), "utf8")).toBe(
      "# live checkpoint\n",
    );
  });

  it("stops before any write when an existing checkpoint differs", async () => {
    put(handoff("kits/delivery-kit/kit-transfer.md"), "# someone else's\n");
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain(
      "checkpoint var/handoffs/kits/delivery-kit/kit-transfer.md exists with different content",
    );
    const layout = loadLayout(tree.fixture.root);
    expect(existsSync(layout.registryFile)).toBe(false);
    expect(existsSync(join(layout.varDir, "games"))).toBe(false);
    expect(readFileSync(handoff("kits/delivery-kit/kit-transfer.md"), "utf8")).toBe(
      "# someone else's\n",
    );
    expect(writable(tree.archieBus)).toBe(true);
  });
});

describe("migrate preconditions", () => {
  const cases: [string, (tree: Tree) => void, string][] = [
    [
      "a departure is active",
      (t) => put(join(t.archieBus, "active-departure"), "bus/x\n"),
      "active-departure",
    ],
    [
      "deployment is pending",
      (t) => put(join(t.archieBus, "deploy-pending"), "x\n"),
      "deploy-pending",
    ],
    [
      "a request is started",
      (t) => writeJson(join(t.archieBus, "requests/two.json"), { id: "two", state: "started" }),
      "request is started",
    ],
    [
      "a spool entry is claimed",
      (t) => put(join(t.archieBus, "unblock/claude-spool/brief.claimed"), "{}"),
      "claimed but not delivered",
    ],
    [
      "the runner lock is held",
      (t) => locks.push(holdLock(join(t.archieBus, "runner.lock"))),
      "0.x runner",
    ],
    [
      "the loop lock is held",
      (t) => locks.push(holdLock(join(t.archieBus, "loop.lock"))),
      "0.x runner",
    ],
    [
      "a queue lock is held",
      (t) => locks.push(holdLock(join(t.archieBus, "bus-queue.lock"))),
      "bus-queue.lock",
    ],
    [
      "the 0.x queue has a branch",
      (t) => put(join(t.archieBus, "bus-queue"), "bus/feature\n"),
      "bus-queue: bus/feature is queued",
    ],
    [
      "a 0.x batch scratch worktree exists",
      (t) => put(join(t.archieBus, "batch-1700000000", "file.txt"), "scratch\n"),
      "batch-1700000000: a 0.x batch scratch worktree exists",
    ],
    [
      "a request is pending",
      (t) => writeJson(join(t.archieBus, "requests/two.json"), { id: "two", state: "pending" }),
      "requests/two.json: request is pending",
    ],
    [
      "a CI watch is running",
      (t) => locks.push(holdLock(join(t.archieBus, `ci/${SHA}.lock`))),
      "CI watch is running",
    ],
  ];
  it.each(cases)("stops before writing when %s", async (_name, arrange, reason) => {
    arrange(tree);
    const result = await run(tree);
    expect(result.status).toBe(1);
    expect(result.err).toContain(reason);
    const layout = loadLayout(tree.fixture.root);
    expect(existsSync(layout.registryFile)).toBe(false);
    expect(existsSync(join(layout.varDir, "games"))).toBe(false);
    expect(writable(tree.archieBus)).toBe(true);
  });

  it("stops when the active harness is ambiguous, and accepts --harness", async () => {
    const libraries = JSON.parse(readFileSync(tree.libraries, "utf8")) as {
      "game-dev": { active_owner: { harness: string } };
    };
    libraries["game-dev"].active_owner.harness = "codex";
    writeJson(tree.libraries, libraries);
    const ambiguous = await run(tree);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.err).toContain("pass --harness");
    expect(existsSync(join(tree.fixture.root, "var", "games"))).toBe(false);
    const chosen = await run(tree, "--harness", "claude");
    expect(chosen.err).toBe("");
    expect(chosen.status).toBe(0);
    expect(readRegistry(loadLayout(tree.fixture.root)).harness).toBe("claude");
  });

  it("rejects an unknown game and a bad harness as usage errors", async () => {
    expect((await run(tree, "--game", "nope")).status).toBe(2);
    expect((await run(tree, "--harness", "other")).status).toBe(2);
    expect((await run(tree, "--remove-legacy", "--game", ARCHIE)).status).toBe(2);
  });
});

describe("migrate --remove-legacy", () => {
  function installRunner(game: string, pid: number): void {
    const layout = loadLayout(tree.fixture.root);
    const packageDir = join(tree.fixture.base, game, "node_modules", "@andornaut", "delivery-kit");
    put(join(packageDir, "dist", "cli.js"), "// cli\n");
    writeJson(join(gameLayout(layout, game).busDir, "runner.json"), {
      cliPath: join(packageDir, "dist", "cli.js"),
      cliSha256: "b".repeat(64),
      pid,
      schema: 1,
      startedAt: "2026-11-03T00:00:00Z",
      version: "1.0.0",
    });
  }

  function realProbe(alive: boolean): ProcessProbe {
    return {
      alive: () => alive,
      argv: (pid) => [
        "node",
        join(
          tree.fixture.base,
          pid === 101 ? ARCHIE : CHIBI,
          "node_modules",
          "@andornaut",
          "delivery-kit",
          "dist",
          "cli.js",
        ),
      ],
      realpath: (path) => (existsSync(path) ? path : undefined),
    };
  }

  function capture(): {
    out: string[];
    err: string[];
    reporter: { out: (t: string) => void; err: (t: string) => void };
  } {
    const out: string[] = [];
    const err: string[] = [];
    return { err, out, reporter: { err: (t) => err.push(t), out: (t) => out.push(t) } };
  }

  it("refuses before migration", () => {
    const { err, reporter } = capture();
    expect(runRemoveLegacy(reporter, loadLayout(tree.fixture.root), realProbe(true), false)).toBe(
      1,
    );
    expect(err.join("")).toContain("not migrated");
    expect(existsSync(join(tree.archieBus, "batch.sh"))).toBe(true);
  });

  it("refuses while a runner is not running from node_modules", async () => {
    expect((await run(tree)).status).toBe(0);
    installRunner(ARCHIE, 101);
    installRunner(CHIBI, 102);
    const { err, reporter } = capture();
    expect(runRemoveLegacy(reporter, loadLayout(tree.fixture.root), realProbe(false), false)).toBe(
      1,
    );
    expect(err.join("")).toContain("is not running");
    expect(existsSync(join(tree.archieBus, "batch.sh"))).toBe(true);
  });

  it("lists then deletes only the listed paths", async () => {
    expect((await run(tree)).status).toBe(0);
    installRunner(ARCHIE, 101);
    installRunner(CHIBI, 102);
    const layout = loadLayout(tree.fixture.root);
    const dry = capture();
    expect(runRemoveLegacy(dry.reporter, layout, realProbe(true), true)).toBe(0);
    expect(dry.out.join("")).toContain(`delete: ${join(tree.archieBus, "batch.sh")}`);
    expect(dry.out.join("")).toContain(`absent: ${join(tree.archieBus, "merge.sh")}`);
    expect(dry.out.join("")).toContain(`delete: ${join(tree.archieBus, "resource-check.sh")}`);
    expect(existsSync(join(tree.archieBus, "batch.sh"))).toBe(true);

    const { out, reporter } = capture();
    expect(runRemoveLegacy(reporter, layout, realProbe(true), false)).toBe(0);
    expect(out.join("")).toContain("removed 12 legacy paths");
    // Unlisted entries stay: configuration, logs, backups, nested scripts and state.
    expect(readdirSync(tree.archieBus).sort()).toEqual(
      [
        "active-departure",
        "bus-common.sh.map-migration-backup",
        "bus-queue",
        "bus-queue.lock",
        "bus.conf",
        "check",
        "ci",
        "codex-bus.log",
        "events",
        "feature-queued.json",
        "feature-ready.json",
        "last-push.link",
        "last-push.sha",
        "loop.lock",
        "npm-cache",
        "requests",
        "runner.lock",
        "tests",
        "unblock",
        "__pycache__",
      ].sort(),
    );
    expect(readdirSync(tree.chibiBus).sort()).toEqual(
      [
        "active-departure",
        "bus.conf.before-upgrade",
        "delivery-kit-rollback-1",
        "release-approved.json",
      ].sort(),
    );
    expect(writable(tree.archieBus)).toBe(false);
  });

  it("deletes nothing when a listed path has the wrong kind", async () => {
    expect((await run(tree)).status).toBe(0);
    installRunner(ARCHIE, 101);
    installRunner(CHIBI, 102);
    chmodSync(tree.chibiBus, 0o700);
    put(join(tree.chibiBus, "merge.sh"), "#!/bin/sh\n");
    const { err, reporter } = capture();
    expect(runRemoveLegacy(reporter, loadLayout(tree.fixture.root), realProbe(true), false)).toBe(
      1,
    );
    expect(err.join("")).toContain("merge.sh is not a symlink");
    expect(existsSync(join(tree.archieBus, "batch.sh"))).toBe(true);
  });
});
