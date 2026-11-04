// Fake external tools for contract cases. Each PATH entry is a shell wrapper that runs
// `node fake-tool.mjs <tool> ...args`. Behaviour is read from DK_FAKE_DIR/control.json on
// every invocation, so a case can change it while a resident runner keeps running.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [, , tool, ...args] = process.argv;
const dir = process.env.DK_FAKE_DIR;
if (!dir) {
  process.stderr.write("fake tool: DK_FAKE_DIR is required\n");
  process.exit(97);
}
const control = readJson(join(dir, "control.json"), {});
const sha = control.sha ?? "a".repeat(40);
const remoteHeadFile = join(dir, "remote-head");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function log(extra = {}) {
  appendFileSync(
    join(dir, "calls.jsonl"),
    JSON.stringify({ tool, args, cwd: process.cwd(), ...extra }) + "\n",
  );
}

function remoteHead() {
  return existsSync(remoteHeadFile)
    ? readFileSync(remoteHeadFile, "utf8").trim()
    : (control.base ?? "b".repeat(40));
}

function realBinary(name) {
  for (const prefix of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    const path = join(prefix, name);
    if (existsSync(path)) return path;
  }
  return name;
}

function passthrough(binary, argv) {
  const result = spawnSync(binary, argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function virtualNow() {
  const clock = readJson(join(dir, "clock.json"), null);
  if (!clock) return Math.floor(Date.now() / 1000);
  let offset = 0;
  try {
    for (const line of readFileSync(join(dir, "clock-offsets"), "utf8").split("\n")) {
      if (line.trim()) offset += Number(line);
    }
  } catch {
    // No offsets recorded.
  }
  return Math.floor(clock.epoch + offset + ((Date.now() - clock.realStartMs) * clock.speed) / 1000);
}

function advanceClock(seconds) {
  if (seconds) appendFileSync(join(dir, "clock-offsets"), `${seconds}\n`);
}

function git() {
  const behaviour = control.git ?? {};
  log();
  if (behaviour.real) passthrough(realBinary("git"), args);
  let rest = args;
  while (rest[0] === "-C" || rest[0] === "-c") rest = rest.slice(2);
  const [command, ...tail] = rest;
  const last = rest.at(-1) ?? "";
  const out = (text) => process.stdout.write(text);
  switch (command) {
    case "rev-parse":
      if (last.endsWith("^{tree}")) {
        out(`${last === "HEAD^{tree}" ? (behaviour.wrongTree ?? "f".repeat(40)) : "f".repeat(40)}\n`);
      } else if (last.startsWith("refs/heads/bus/")) {
        const branch = last.replace(/^refs\/heads\//, "").replace(/\^\{commit\}$/, "");
        const tip = behaviour.tips?.[branch] ?? behaviour.branchTip ?? sha;
        if (tip === null) {
          process.stderr.write(`fatal: Needed a single revision\n`);
          process.exit(128);
        }
        out(`${tip}\n`);
      } else {
        out(`${last === "HEAD" ? sha : remoteHead()}\n`);
      }
      return 0;
    case "merge-base":
      out(`${control.base ?? "b".repeat(40)}\n`);
      return 0;
    case "diff":
      out(`${behaviour.files ?? "src/example.ts"}\n`);
      return 0;
    case "status":
      out(behaviour.status ?? "");
      return 0;
    case "log":
      out(`${sha} fixture\n`);
      return 0;
    case "fetch":
      return behaviour.fetchFail ? 1 : 0;
    case "rebase":
      return behaviour.rebaseFail ? 1 : 0;
    case "cherry-pick":
      return behaviour.conflict?.length && tail[0] !== "--abort" ? 1 : 0;
    case "worktree":
      if (tail[0] === "add") mkdirSync(rest.at(-2), { recursive: true });
      return 0;
    case "push":
      if (behaviour.pushFail) return 1;
      writeFileSync(remoteHeadFile, sha);
      return 0;
    default:
      return 0;
  }
}

function docker() {
  const behaviour = control.docker ?? {};
  log();
  if (args[0] === "ps") return 0;
  const fail = (reason) => {
    process.stderr.write(`fake docker: ${reason}\n`);
    return 99;
  };
  const cpus = args[args.indexOf("--cpus") + 1];
  if (cpus !== String(behaviour.cpus ?? 4)) return fail(`unexpected --cpus ${cpus}`);
  // Scripted Git stamps the control SHA; a real repository stamps its own scratch HEAD.
  const stamp = args.find((x) => x.startsWith("WORKERS_CI_COMMIT_SHA="))?.slice(22) ?? "";
  if (control.git?.real ? !/^[0-9a-f]{40}$/.test(stamp) : stamp !== sha) return fail("missing exact commit stamp");
  const user = args.indexOf("-u");
  const ids = `${process.getuid()}:${process.getgid()}`;
  if (user < 0 || args[user + 1] !== ids) return fail("gate must run as the invoking user");
  // 0.9.0 uses `-v SRC:/npmcache`; 0.9.1 uses `--mount type=bind,src=SRC,dst=/npmcache`.
  const cache =
    args.find((x) => x.endsWith(",dst=/npmcache"))?.split(",").find((x) => x.startsWith("src="))?.slice(4) ??
    args.find((x) => x.endsWith(":/npmcache"))?.slice(0, -":/npmcache".length);
  if (!cache || !existsSync(cache)) return fail("npm cache bind source must exist before mounting");
  if (behaviour.blockWhile) {
    // Hold the gate open while the file exists, so a case can act mid-departure.
    while (existsSync(behaviour.blockWhile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (args.includes("--network")) {
    if (behaviour.gateFail) return 1;
    if (behaviour.moveBase) writeFileSync(remoteHeadFile, "9".repeat(40));
    if (behaviour.changeApproval) writeFileSync(behaviour.changeApproval, "changed");
    if (behaviour.advanceClock) advanceClock(behaviour.advanceClock);
    const mount = args.find((x) => x.endsWith(":/app"));
    if (mount) {
      const work = mount.slice(0, -":/app".length);
      mkdirSync(join(work, "dist"), { recursive: true });
      writeFileSync(join(work, "dist", "index.html"), sha.slice(0, 8));
    }
  } else if (behaviour.installFail) {
    return 1;
  }
  return 0;
}

function gh() {
  const behaviour = control.gh ?? {};
  log();
  if (behaviour.exitCode) return behaviour.exitCode;
  const path = args.find((x) => x.includes("/check-runs")) ?? "";
  const commit = /\/commits\/([0-9a-f]{40})\//.exec(path)?.[1] ?? "";
  const runs = behaviour.checks?.[commit] ?? behaviour.default ?? [];
  process.stdout.write(JSON.stringify(runs) + "\n");
  return 0;
}

function wrangler(argv) {
  const behaviour = control.wrangler ?? {};
  log({ args: argv });
  if (behaviour.append) appendFileSync(behaviour.append[0], behaviour.append[1]);
  return behaviour.fail ? 1 : 0;
}

function claude() {
  const behaviour = control.claude ?? {};
  log();
  if (args[0] !== "agents") return 2;
  if (behaviour.exitCode) return behaviour.exitCode;
  const agents = behaviour.agents ?? [];
  process.stdout.write(typeof agents === "string" ? agents : JSON.stringify(agents));
  return 0;
}

function codex() {
  const behaviour = control.codex ?? {};
  if (behaviour.blockWhile) {
    while (existsSync(behaviour.blockWhile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (behaviour.fail) return 1;
  log();
  return 0;
}

function date() {
  if (args.length === 1 && args[0] === "+%s") {
    process.stdout.write(`${virtualNow()}\n`);
    return 0;
  }
  const real = realBinary("date");
  if (args.includes("-d") || args.some((x) => x.startsWith("--date"))) passthrough(real, args);
  passthrough(real, ["-d", `@${virtualNow()}`, ...args]);
  return 0;
}

function sleep() {
  const clock = readJson(join(dir, "clock.json"), null);
  const seconds = Number(args[0] ?? 0);
  const speed = clock?.speed ?? 1;
  // Real waits stay short; virtual time advances by wall time times the clock speed.
  const realSeconds = Math.min(seconds / speed, control.maxRealSleep ?? 30);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, realSeconds * 1000));
  return 0;
}

function node() {
  // The Bash deployment runs `node node_modules/wrangler/bin/wrangler.js deploy ...`.
  if (args[0] && basename(args[0]) === "wrangler.js") return wrangler(args.slice(1));
  passthrough(process.execPath, args);
  return 0;
}

const handlers = { claude, codex, date, docker, gh, git, node, sleep, wrangler: () => wrangler(args) };
const handler = handlers[tool];
if (!handler) {
  process.stderr.write(`fake tool: unknown ${tool}\n`);
  process.exit(98);
}
process.exit(handler());
