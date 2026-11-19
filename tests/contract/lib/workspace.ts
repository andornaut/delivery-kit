// Scratch workspace shared by both implementation adapters: a game-coordinator root with a fake
// coordinator-installed coordination-kit CLI, one or more game checkouts, scratch HOME and XDG
// state, and fake external tools on PATH.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = join(HERE, "..", "..", "..");
const FAKE_TOOLS = ["claude", "docker", "gh", "git", "wrangler"] as const;
export type FakeTool = (typeof FAKE_TOOLS)[number];

function objectId(type: string, body: Buffer | string): string {
  const bytes = Buffer.from(body);
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}

const FIXTURE_IGNORE = "dist/\n";
const FIXTURE_TREE = objectId(
  "tree",
  Buffer.concat([
    Buffer.from("100644 .gitignore\0"),
    Buffer.from(objectId("blob", FIXTURE_IGNORE), "hex"),
  ]),
);
export const SHA = objectId(
  "commit",
  `tree ${FIXTURE_TREE}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`,
);
const BASE = "b".repeat(40);

/** The committed game `delivery-kit.json` (plan schema 1). Values are passed through as given. */
export interface GameConfig {
  schema?: unknown;
  git?: { main?: unknown; remote?: unknown; github?: unknown };
  schedule?: { departures?: unknown; timezone?: unknown };
  gate?: { image?: unknown; install?: unknown; steps?: unknown };
  /** `maxWorkers` is a removed key that check-config rejects as unknown. */
  resources?: { cpus?: unknown; maxWorkers?: unknown; loadLimit?: unknown; memoryMiB?: unknown };
  ci?: { requiredNames?: unknown; pollSeconds?: unknown; timeoutSeconds?: unknown };
  deploy?: { mode?: unknown; skipPattern?: unknown };
  reports?: {
    project?: unknown;
    scheduledTicks?: unknown;
    recipient?: unknown;
    workerParents?: unknown;
  };
}

export type HostLoad = "ignore" | "real";

export interface RoleRecord {
  ownership?: string;
  conversations: { claude?: string | null; codex?: string | null };
  [key: string]: unknown;
}

export interface Registry {
  schema: 1;
  revision: number;
  harness: "claude" | "codex";
  roles: Record<string, RoleRecord>;
  [key: string]: unknown;
}

export interface GameOptions {
  /** Key in game-coordinator `config.json`; the checkout is created beside game-coordinator. */
  game?: string;
  config?: GameConfig;
  /** Use native Git for remote/history operations too, instead of scripting those operations. */
  realGit?: boolean;
  /** Harness-only; see Workspace.hostLoad. */
  hostLoad?: HostLoad;
  /** Explicit fixture adoption; null leaves the production control record absent. */
  deliveryState?: "enabled" | "paused" | null;
}

function defaultConfig(): GameConfig {
  return {
    schema: 1,
    git: { main: "main", remote: "origin", github: "" },
    schedule: { departures: ["00", "20", "40"], timezone: "America/Toronto" },
    gate: {
      image: "unused",
      install: "npm ci",
      steps: [
        { name: "check", run: "check" },
        { name: "lint", run: "lint" },
        { name: "test", run: "test" },
        { name: "build", run: "build" },
      ],
    },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    ci: { requiredNames: ["Test"] },
    deploy: { mode: "wrangler", skipPattern: "(\\.md$|^art/|^gameplay/)" },
    reports: {},
  };
}

export interface Control {
  sha?: string;
  base?: string;
  maxRealSleep?: number;
  git?: {
    real?: boolean;
    /** Local main HEAD for `rev-parse main` (1.0 trunk-based departures). */
    localMain?: string;
    files?: string;
    status?: string;
  };
  docker?: {
    cpus?: number;
    gateFail?: boolean;
    installFail?: boolean;
    /** The install provides no node_modules/wrangler/bin/wrangler.js. */
    noWrangler?: boolean;
  };
  gh?: { exitCode?: number; default?: unknown[]; checks?: Record<string, unknown[]> };
  wrangler?: { fail?: boolean };
  claude?: { exitCode?: number; agents?: unknown };
}

export interface Call {
  tool: FakeTool;
  args: string[];
  cwd: string;
}

/** The coordinator root's coordination-kit CLI, which the runner spawns for reviews and events. */
export const COORDINATOR_CLI = join(
  "node_modules",
  "@andornaut",
  "coordination-kit",
  "dist",
  "cli.js",
);

/** One call the fake coordination-kit CLI received. */
export interface CoordinatorCall {
  args: string[];
  cwd: string;
  execPath: string;
  root: string;
}

export class Workspace {
  readonly root: string;
  readonly home: string;
  readonly xdgState: string;
  readonly coordinator: string;
  readonly fakeDir: string;
  readonly fakeBin: string;
  readonly game: string;
  readonly repo: string;
  readonly state: string;
  config: GameConfig;
  readonly realGit: boolean;
  /**
   * Harness-only fixture flag, never written to delivery-kit.json. "ignore" (the default)
   * keeps the host's real load from blocking departures; "real" applies resources.loadLimit
   * against the actual load, which cases use with loadLimit 0 to force a load block.
   */
  hostLoad: HostLoad;
  /** Extra environment for every CLI invocation (test overrides and adapter variables). */
  env: Record<string, string> = {};

  constructor(options: GameOptions = {}) {
    // Short paths keep Unix socket names under the 108-byte limit.
    this.root = mkdtempSync(join(tmpdir(), "dk-"));
    this.home = join(this.root, "home");
    this.xdgState = join(this.home, ".local", "state");
    this.coordinator = join(this.root, "game-coordinator");
    this.fakeDir = join(this.root, "fakes");
    this.fakeBin = join(this.fakeDir, "bin");
    this.game = options.game ?? "fixture-game";
    this.repo = join(this.root, this.game);
    this.state = join(this.coordinator, "var", "games", this.game, "bus");
    this.config = options.config ?? defaultConfig();
    this.realGit = options.realGit ?? false;
    this.hostLoad = options.hostLoad ?? "ignore";
    for (const path of [this.xdgState, this.fakeBin, this.repo, this.state])
      mkdirSync(path, { recursive: true });
    // Docker would create a missing bind source as root; consumers keep this cache in state.
    mkdirSync(join(this.state, "npm-cache"));
    this.installFakes();
    // CI reports the default required check green unless a case scripts gh: every departure
    // watches CI before deploying.
    const gh = { default: [{ conclusion: "success", id: 1, name: "Test", status: "completed" }] };
    this.setControl(this.realGit ? { gh, git: { real: true } } : { gh });
    this.writeCoordinator();
    if (options.deliveryState !== null)
      this.adoptDeliveryControl(options.deliveryState ?? "enabled");
    this.initRealGit();
    writeJson(join(this.fakeDir, "identity.json"), { sha: SHA, tree: FIXTURE_TREE });
  }

  private installFakes(): void {
    const script = join(HERE, "fake-tool.mjs");
    for (const tool of FAKE_TOOLS) {
      if (tool === "git" && this.realGit) continue;
      const path = join(this.fakeBin, tool);
      writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' ${tool} "$@"\n`);
      chmodSync(path, 0o755);
    }
  }

  private writeCoordinator(): void {
    writeJson(join(this.coordinator, "config.json"), {
      schema: 1,
      timezone: "America/Toronto",
      wakeMinutes: [20, 50],
      games: {
        [this.game]: {
          name: "Fixture",
          path: `../${this.game}`,
          roles: ["art", "gameplay", "tech"],
        },
      },
      kits: {},
      sharedRoles: ["game-coordinator", "art-kit", "delivery-kit", "game-kit"],
    });
    this.writeRegistry({ schema: 1, revision: 1, harness: "claude", roles: {} });
    this.installCoordinatorCli();
  }

  /**
   * Install the fake coordination-kit CLI (lib/fake-coordination-kit.mjs) at the coordinator
   * root. Unscripted, every review is skipped with nothing-due and every ingest consumes the event
   * log per the cursor contract.
   */
  installCoordinatorCli(): void {
    const cli = join(this.coordinator, COORDINATOR_CLI);
    mkdirSync(dirname(cli), { recursive: true });
    copyFileSync(join(HERE, "fake-coordination-kit.mjs"), cli);
    writeJson(join(dirname(dirname(cli)), "package.json"), {
      name: "@andornaut/coordination-kit",
      type: "module",
      version: "2.0.1",
    });
  }

  /** Install the coordination-kit release this checkout builds against, its real CLI included. */
  installReleasedCoordinatorCli(): void {
    const target = join(this.coordinator, "node_modules", "@andornaut", "coordination-kit");
    rmSync(target, { force: true, recursive: true });
    cpSync(join(KIT_ROOT, "node_modules", "@andornaut", "coordination-kit"), target, {
      recursive: true,
    });
  }

  /** Remove the coordinator CLI, as `npm ci` at the root briefly does. */
  removeCoordinatorCli(): void {
    rmSync(join(this.coordinator, COORDINATOR_CLI), { force: true });
  }

  /** Script the fake coordination-kit CLI; the control fields are in its header. */
  scriptCoordinator(control: Record<string, unknown>): void {
    writeJson(join(this.coordinator, "fake-coordination-kit", "control.json"), control);
  }

  coordinatorCalls(): CoordinatorCall[] {
    const path = join(this.coordinator, "fake-coordination-kit", "calls.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CoordinatorCall);
  }

  /** Update game-coordinator `config.json` fields (for example `wakeMinutes`). */
  updateCoordinatorConfig(change: Record<string, unknown>): void {
    const path = join(this.coordinator, "config.json");
    writeJson(path, { ...JSON.parse(readFileSync(path, "utf8")), ...change });
  }

  coordinatorConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(this.coordinator, "config.json"), "utf8"));
  }

  /**
   * Write var/registry.json, completing the 1.0 schema fields a case leaves out. Role keys
   * without a game prefix are registered as shared roles in config.json, as the skills do.
   */
  writeRegistry(registry: Registry): void {
    const roles = Object.fromEntries(
      Object.entries(registry.roles).map(([key, role]) => [
        key,
        { ownership: "active", worktree: ".", ...role },
      ]),
    );
    const complete = {
      updatedAt: "2026-11-04T03:00:00Z",
      host: { nativeProjectId: "fixture-project", root: "." },
      operations: {},
      transfers: [],
      ...registry,
      roles,
    };
    writeJson(join(this.coordinator, "var", "registry.json"), complete);
    const config = this.coordinatorConfig();
    const shared = new Set(config.sharedRoles as string[]);
    for (const key of Object.keys(roles)) if (!key.includes("/")) shared.add(key);
    writeJson(join(this.coordinator, "config.json"), { ...config, sharedRoles: [...shared] });
  }

  registry(): Registry {
    return JSON.parse(readFileSync(join(this.coordinator, "var", "registry.json"), "utf8"));
  }

  get routeFile(): string {
    return join(this.coordinator, "var", "route.json");
  }

  /** Write var/route.json: a schema 1 role-name route, or raw text for a malformed one. */
  writeRoute(route: unknown): void {
    writeFileSync(this.routeFile, typeof route === "string" ? route : JSON.stringify(route));
  }

  get configFile(): string {
    return join(this.repo, "delivery-kit.json");
  }

  /** Seed this fixture's approved control state without changing production defaults. */
  adoptDeliveryControl(state: "enabled" | "paused"): void {
    const updatedAt = "2026-11-09T20:00:00.000Z";
    this.write(
      "delivery-control.json",
      JSON.stringify({
        schema: 1,
        revision: 1,
        desired: {
          state,
          reason: "fixture adoption",
          requester: "game-coordinator",
          updatedAt,
          revision: 1,
        },
        observed: null,
        activities: {},
      }),
    );
  }

  setControl(control: Control): void {
    writeJson(join(this.fakeDir, "control.json"), control);
  }

  updateControl(change: (control: Control) => void): void {
    const control = this.control();
    change(control);
    this.setControl(control);
    // Keep an existing clock's sleep cap in step with the control value.
    if (existsSync(this.clockFile)) {
      const clock = JSON.parse(readFileSync(this.clockFile, "utf8")) as Record<string, unknown>;
      delete clock.maxRealSleep;
      writeJson(this.clockFile, { ...clock, ...this.realSleepCap() });
    }
  }

  control(): Control {
    return JSON.parse(readFileSync(join(this.fakeDir, "control.json"), "utf8"));
  }

  /** The fake remote's main head; pushes write it. */
  get remoteHead(): string {
    const path = join(this.fakeDir, "remote-head");
    return existsSync(path) ? readFileSync(path, "utf8").trim() : (this.control().base ?? BASE);
  }

  set remoteHead(value: string) {
    writeFileSync(join(this.fakeDir, "remote-head"), value);
  }

  calls(tool?: FakeTool): Call[] {
    const path = join(this.fakeDir, "calls.jsonl");
    if (!existsSync(path)) return [];
    const rows = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
    return tool ? rows.filter((row) => row.tool === tool) : rows;
  }

  /**
   * Virtual clock for `run`: virtual = epoch + offsets + wall elapsed * speed.
   * The runner reads the file through DELIVERY_KIT_TEST_CLOCK.
   */
  setClock(epoch: number, speed = 60): void {
    rmSync(join(this.fakeDir, "clock-offsets"), { force: true });
    writeJson(join(this.fakeDir, "clock.json"), {
      epoch,
      realStartMs: Date.now(),
      speed,
      ...this.realSleepCap(),
    });
  }

  /**
   * Hold the virtual clock at `epoch` until the next setClock: speed 0.001 keeps the whole second
   * unchanged for over 16 real minutes, and real sleeps of at most 50 ms let the runner see the
   * release promptly.
   */
  holdClock(epoch: number): void {
    rmSync(join(this.fakeDir, "clock-offsets"), { force: true });
    writeJson(join(this.fakeDir, "clock.json"), {
      epoch,
      realStartMs: Date.now(),
      speed: 0.001,
      maxRealSleep: 0.05,
    });
  }

  /**
   * The real-time cap on one runner sleep: control.maxRealSleep (seconds), written into
   * clock.json's optional maxRealSleep.
   */
  private realSleepCap(): { maxRealSleep?: number } {
    const cap = this.control().maxRealSleep;
    return cap !== undefined && cap > 0 ? { maxRealSleep: cap } : {};
  }

  get clockFile(): string {
    return join(this.fakeDir, "clock.json");
  }

  /** Current virtual time, as fake `date +%s` reports it. */
  virtualNow(): number {
    const clock = JSON.parse(readFileSync(this.clockFile, "utf8")) as {
      epoch: number;
      realStartMs: number;
      speed: number;
    };
    const offsetsPath = join(this.fakeDir, "clock-offsets");
    const offsets = existsSync(offsetsPath)
      ? readFileSync(offsetsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .reduce((sum, line) => sum + Number(line), 0)
      : 0;
    return Math.floor(
      clock.epoch + offsets + ((Date.now() - clock.realStartMs) * clock.speed) / 1000,
    );
  }

  advanceClock(seconds: number): void {
    appendFileSync(join(this.fakeDir, "clock-offsets"), `${seconds}\n`);
  }

  /** Base environment: scratch HOME and XDG state, fakes first on PATH. */
  baseEnv(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: `${this.fakeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HOME: this.home,
      XDG_STATE_HOME: this.xdgState,
      DK_FAKE_DIR: this.fakeDir,
      LANG: "C.UTF-8",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    if (existsSync(this.clockFile)) env.DELIVERY_KIT_TEST_CLOCK = this.clockFile;
    return { ...env, ...this.env };
  }

  // Real Git helpers for cases that integrate actual history.
  private initRealGit(): void {
    this.git("init", "-q", "-b", "main");
    // Games ignore build output, so the gate's dist/ does not change the Git fingerprint.
    writeFileSync(join(this.repo, ".gitignore"), FIXTURE_IGNORE);
    this.git("add", "--", ".gitignore");
    execFileSync("/usr/bin/git", ["-C", this.repo, "commit", "--no-verify", "-qm", "fixture"], {
      env: {
        ...this.baseEnv(),
        GIT_AUTHOR_DATE: "1700000000 +0000",
        GIT_COMMITTER_DATE: "1700000000 +0000",
      },
    });
    if (this.git("rev-parse", "HEAD") !== SHA) throw new Error("fixture commit identity differs");
  }

  git(...args: string[]): string {
    return execFileSync("/usr/bin/git", ["-C", this.repo, ...args], {
      env: this.baseEnv(),
      encoding: "utf8",
    }).trim();
  }

  commit(message: string, files: Record<string, string> = {}): string {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.repo, name)), { recursive: true });
      writeFileSync(join(this.repo, name), content);
      this.git("add", "--", name);
    }
    this.git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--no-verify",
      "--allow-empty",
      "-qm",
      message,
    );
    return this.git("rev-parse", "HEAD");
  }

  // State helpers. Paths are relative to the game's bus state directory.
  path(...parts: string[]): string {
    return join(this.state, ...parts);
  }

  read(...parts: string[]): string {
    return readFileSync(this.path(...parts), "utf8");
  }

  readJson<T = Record<string, unknown>>(...parts: string[]): T {
    return JSON.parse(this.read(...parts)) as T;
  }

  exists(...parts: string[]): boolean {
    return existsSync(this.path(...parts));
  }

  write(name: string, content: string): void {
    mkdirSync(dirname(this.path(name)), { recursive: true });
    writeFileSync(this.path(name), content);
  }

  list(...parts: string[]): string[] {
    const path = this.path(...parts);
    return existsSync(path) ? readdirSync(path).sort() : [];
  }

  inode(...parts: string[]): number {
    return statSync(this.path(...parts)).ino;
  }

  /** The events in bus/events.jsonl, oldest first; torn and malformed lines are left out. */
  events(): Array<Record<string, unknown>> {
    if (!this.exists("events.jsonl")) return [];
    return this.read("events.jsonl")
      .split("\n")
      .slice(0, -1)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }

  /** The events the fake coordination-kit CLI ingested, oldest first. */
  ingested(): Array<Record<string, unknown>> {
    const path = join(this.coordinator, "fake-coordination-kit", "ingested.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
