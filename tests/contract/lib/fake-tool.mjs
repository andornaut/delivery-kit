// Fake external tools for contract cases. Each PATH entry is a shell wrapper that runs
// `node fake-tool.mjs <tool> ...args`. Behaviour is read from DK_FAKE_DIR/control.json on
// every invocation, so a case can change it while a resident runner keeps running.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
        out(`${"f".repeat(40)}\n`);
      } else if (
        behaviour.localMain &&
        ["main", "refs/heads/main", "refs/heads/main^{commit}"].includes(last)
      ) {
        out(`${behaviour.localMain}\n`);
      } else {
        out(`${last === "HEAD" ? sha : remoteHead()}\n`);
      }
      return 0;
    case "ls-remote":
      out(`${remoteHead()}\trefs/heads/main\n`);
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
    case "worktree":
      // `git worktree add` creates the checkout; node_modules/ comes only from an install.
      if (tail[0] === "add") mkdirSync(rest.at(-2), { recursive: true });
      return 0;
    case "push":
      writeFileSync(remoteHeadFile, sha);
      return 0;
    default:
      return 0;
  }
}

/** Host bind mounts without a read-only flag, from `-v`/`--volume` and `--mount type=bind`. */
function writableBinds(argv) {
  const found = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    let value;
    if (flag === "-v" || flag === "--volume" || flag === "--mount") value = argv[++i];
    else if (flag.startsWith("--volume=") || flag.startsWith("--mount="))
      value = flag.slice(flag.indexOf("=") + 1);
    else continue;
    if (flag.startsWith("--mount")) {
      const fields = value.split(",");
      if (!fields.includes("type=bind")) continue;
      if (
        !fields.some((f) =>
          ["readonly", "ro", "readonly=true", "ro=true", "readonly=1"].includes(f),
        )
      )
        found.push(value);
    } else {
      const [source, , options = ""] = value.split(":");
      // Named volumes are not host binds.
      if (!source.startsWith("/")) continue;
      if (!options.split(",").includes("ro")) found.push(value);
    }
  }
  return found;
}

/**
 * Write the Wrangler entry an install leaves in `nodeModules`. The runner deploys with
 * `node_modules/wrangler/bin/wrangler.js` from the gated worktree; the entry forwards to the fake
 * `wrangler`. Only a passing gate container provides it, through the node_modules/ copy-out.
 */
function plantWrangler(nodeModules) {
  const entry = join(nodeModules, "wrangler", "bin");
  mkdirSync(entry, { recursive: true });
  writeFileSync(
    join(entry, "wrangler.js"),
    `import { spawnSync } from "node:child_process";\n` +
      `const r = spawnSync(process.execPath, [${JSON.stringify(process.argv[1])}, "wrangler", ...process.argv.slice(2)], { stdio: "inherit" });\n` +
      `process.exit(r.status ?? 1);\n`,
  );
}

/**
 * The 1.0 gate protocol (src/gate.ts): create, start, exec copy with EXPECTED_TREE, exec install,
 * network disconnect, exec the loopback check, exec the gate script, cp logs, dist and
 * node_modules out, rm.
 * Container state lives in DK_FAKE_DIR/containers/<name>.json.
 */
function gateProtocol(behaviour) {
  const fail = (reason) => {
    process.stderr.write(`fake docker: ${reason}\n`);
    return 99;
  };
  const containers = join(dir, "containers");
  const stateOf = (name) => join(containers, `${name}.json`);
  const load = (name) => readJson(stateOf(name), null);
  const save = (name, state) => {
    mkdirSync(containers, { recursive: true });
    writeFileSync(stateOf(name), JSON.stringify(state));
  };
  const [verb] = args;
  if (verb === "create") {
    const name = args[args.indexOf("--name") + 1];
    const cpus = args[args.indexOf("--cpus") + 1];
    if (cpus !== String(behaviour.cpus ?? 4)) return fail(`unexpected --cpus ${cpus}`);
    const stamp = args.find((x) => x.startsWith("WORKERS_CI_COMMIT_SHA="))?.slice(22) ?? "";
    if (control.git?.real ? !/^[0-9a-f]{40}$/.test(stamp) : stamp !== sha)
      return fail("missing exact commit stamp");
    const user = args.indexOf("--user");
    if (user < 0 || args[user + 1] !== "19001:19001")
      return fail("gate must run as --user 19001:19001");
    const writable = writableBinds(args);
    if (writable.length) return fail(`writable bind mount: ${writable.join(" ")}`);
    // Checkouts are group-readable only, so the gate joins each bound checkout's group.
    const groups = args.flatMap((x, i) => (x === "--group-add" ? [args[i + 1]] : []));
    const binds = args.flatMap((x, i) =>
      x === "--mount" && args[i + 1].split(",").includes("type=bind")
        ? [
            args[i + 1]
              .split(",")
              .find((f) => f.startsWith("src="))
              ?.slice(4),
          ]
        : [],
    );
    if (!binds.length) return fail("gate must bind the scratch checkout read-only");
    for (const source of binds) {
      const gid = String(statSync(source).gid);
      if (!groups.includes(gid))
        return fail(`gate must pass --group-add ${gid} (the checkout gid of ${source})`);
    }
    save(name, { built: false, started: false, work: binds[0] });
    process.stdout.write(`${name}\n`);
    return 0;
  }
  if (verb === "rm") return 0;
  if (verb === "start") {
    const name = args.at(-1);
    const state = load(name);
    if (!state) return fail(`no container ${name}`);
    save(name, { ...state, started: true });
    return 0;
  }
  if (verb === "network") return args[1] === "disconnect" ? 0 : 0;
  if (verb === "cp") {
    const [from, to] = args.slice(-2);
    const name = from.split(":")[0];
    const state = load(name);
    if (!state) return fail(`no container ${name}`);
    mkdirSync(to, { recursive: true });
    if (from.endsWith("/tmp/work/dist/.")) {
      if (!state.built) return fail("dist/ does not exist");
      writeFileSync(join(to, "index.html"), sha.slice(0, 8));
    } else if (from.endsWith("/tmp/work/node_modules/.")) {
      if (!state.built) return fail("node_modules/ is copied only from a passing gate");
      if (behaviour.noWrangler) return 0;
      plantWrangler(to);
    }
    return 0;
  }
  if (verb === "exec") {
    let i = 1;
    const env = {};
    while (args[i] === "-e") {
      const [key, ...value] = args[i + 1].split("=");
      env[key] = value.join("=");
      i += 2;
    }
    const name = args[i];
    const command = args.slice(i + 1);
    const state = load(name);
    if (!state?.started) return fail(`container ${name} is not running`);
    const script = command[0] === "sh" ? (command[2] ?? "") : "";
    if (command[0] === "test") return state.built ? 0 : 1;
    if ("EXPECTED_TREE" in env) return env.EXPECTED_TREE !== "f".repeat(40) ? 1 : 0;
    if (script.includes("/sys/class/net")) return 0;
    if (script.startsWith("set -e")) {
      if (behaviour.gateFail) return 1;
      save(name, { ...state, built: true });
      return 0;
    }
    // Anything else is the install step: `cd /tmp/work && <install>`.
    return behaviour.installFail ? 1 : 0;
  }
  return fail(`unmodelled docker ${verb}`);
}

function docker() {
  const behaviour = control.docker ?? {};
  log();
  if (args[0] === "ps") return 0;
  return gateProtocol(behaviour);
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

const handlers = {
  claude,
  docker,
  gh,
  git,
  wrangler: () => wrangler(args),
};
const handler = handlers[tool];
if (!handler) {
  process.stderr.write(`fake tool: unknown ${tool}\n`);
  process.exit(98);
}
process.exit(handler());
