// Scratch workspace shared by both implementation adapters: a game-dev root, one or more
// game checkouts, scratch HOME and XDG state, and fake external tools on PATH.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
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

export const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

/** The committed game `delivery-kit.json` (plan schema 1). Values are passed through as given. */
export interface GameConfig {
  schema?: unknown;
  git?: { main?: unknown; remote?: unknown; github?: unknown };
  schedule?: { departures?: unknown; timezone?: unknown };
  gate?: { image?: unknown; install?: unknown; steps?: unknown };
  /** `maxWorkers` is a removed key that check-config rejects as unknown. */
  resources?: { cpus?: unknown; maxWorkers?: unknown; loadLimit?: unknown };
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
  /** Key in game-dev `config.json`; the checkout is created beside game-dev. */
  game?: string;
  config?: GameConfig;
  /** Use a real Git repository instead of the scripted fake. */
  realGit?: boolean;
  /** Harness-only; see Workspace.hostLoad. */
  hostLoad?: HostLoad;
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
    resources: { cpus: 4, loadLimit: 24 },
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

export class Workspace {
  readonly root: string;
  readonly home: string;
  readonly xdgState: string;
  readonly gameDev: string;
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
  /** Extra environment for every CLI invocation (adapter overrides such as CODEX_CONTROL_SOCKET). */
  env: Record<string, string> = {};

  constructor(options: GameOptions = {}) {
    // Short paths keep Unix socket names under the 108-byte limit.
    this.root = mkdtempSync(join(tmpdir(), "dk-"));
    this.home = join(this.root, "home");
    this.xdgState = join(this.home, ".local", "state");
    this.gameDev = join(this.root, "game-dev");
    this.fakeDir = join(this.root, "fakes");
    this.fakeBin = join(this.fakeDir, "bin");
    this.game = options.game ?? "fixture-game";
    this.repo = join(this.root, this.game);
    this.state = join(this.gameDev, "var", "games", this.game, "bus");
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
    this.writeGameDev();
    if (this.realGit) this.initRealGit();
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

  private writeGameDev(): void {
    writeJson(join(this.gameDev, "config.json"), {
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
      sharedRoles: ["game-dev", "art-kit", "delivery-kit", "game-kit"],
    });
    this.writeRegistry({ schema: 1, revision: 1, harness: "claude", roles: {} });
  }

  /** Update game-dev `config.json` fields (for example `wakeMinutes`). */
  updateGameDevConfig(change: Record<string, unknown>): void {
    const path = join(this.gameDev, "config.json");
    writeJson(path, { ...JSON.parse(readFileSync(path, "utf8")), ...change });
  }

  gameDevConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(this.gameDev, "config.json"), "utf8"));
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
    writeJson(join(this.gameDev, "var", "registry.json"), complete);
    const config = this.gameDevConfig();
    const shared = new Set(config.sharedRoles as string[]);
    for (const key of Object.keys(roles)) if (!key.includes("/")) shared.add(key);
    writeJson(join(this.gameDev, "config.json"), { ...config, sharedRoles: [...shared] });
  }

  registry(): Registry {
    return JSON.parse(readFileSync(join(this.gameDev, "var", "registry.json"), "utf8"));
  }

  get routeFile(): string {
    return join(this.gameDev, "var", "route.json");
  }

  /** The last 0.x route a case wrote; the Node adapter translates it to a role-name route. */
  legacyRoute: unknown;

  /**
   * Write a 0.x monitor route (version 1 Codex or version 2 Claude, or raw text). The adapter
   * rewrites var/route.json as a schema 1 role-name route at each command.
   */
  writeRoute(route: unknown): void {
    this.legacyRoute = route;
    writeFileSync(this.routeFile, typeof route === "string" ? route : JSON.stringify(route));
  }

  get configFile(): string {
    return join(this.repo, "delivery-kit.json");
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
    this.commit("fixture", { ".gitignore": "dist/\n" });
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.repo, ...args], {
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

  /** Outbox events, oldest first. */
  events(): Array<Record<string, unknown>> {
    return this.list("events")
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson(join("events", name)))
      .sort((a, b) => Number(a.created) - Number(b.created));
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
