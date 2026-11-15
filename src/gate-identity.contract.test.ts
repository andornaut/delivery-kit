// Docker filesystem transport is emulated; every gate script and Git operation runs for real.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { busContext } from "./bus/context.ts";
import type { Exec, ExecResult, ExecSpec } from "./bus/exec.ts";
import { validateProjectConfig } from "./config.ts";
import { runGate } from "./gate.ts";
import { gameLayout, loadLayout } from "./layout.ts";
import { makeFixture, projectConfig } from "./testFixtures.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function childEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...childEnvironment(),
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`fixture Git operation failed: ${args[0]}`);
  }
  return result.stdout.trim();
}

async function execute(env: NodeJS.ProcessEnv, spec: ExecSpec): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", () =>
      resolve({ status: 127, stdout, stderr: "fixture child unavailable" }),
    );
    child.once("close", (status) => {
      if (spec.logFile !== undefined) {
        appendFileSync(spec.logFile, stdout + stderr);
      }
      resolve({ status, stdout, stderr });
    });
  });
}

function dockerFilesystem(root: string) {
  const container = join(root, "container");
  const mounts = new Map<string, string>();
  const calls: string[][] = [];
  const containerEnv: NodeJS.ProcessEnv = {};
  const resolvePath = (value: string): string => {
    const mapping = [...mounts]
      .sort(([a], [b]) => b.length - a.length)
      .find(([target]) => value === target || value.startsWith(`${target}/`));
    return mapping === undefined
      ? join(container, value)
      : mapping[1] + value.slice(mapping[0].length);
  };
  const shellPaths = (text: string): string =>
    text.replace(/\/(?:src|tmp)(?:\/[A-Za-z0-9_.-]+)*/g, (path) => resolvePath(path));
  const exec: Exec = async (spec) => {
    if (spec.command !== "docker") {
      return execute(childEnvironment(), spec);
    }
    const args = [...spec.args];
    calls.push(args);
    const ok = { status: 0, stdout: "", stderr: "" };
    if (["ps", "start", "network", "rm"].includes(args[0]!)) {
      return ok;
    }
    if (args[0] === "create") {
      mkdirSync(container, { recursive: true });
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "-e") {
          const value = args[++index]!;
          const at = value.indexOf("=");
          containerEnv[value.slice(0, at)] = value.slice(at + 1);
        }
        if (args[index] === "--mount") {
          const fields = Object.fromEntries(
            args[++index]!.split(",").map((field) => field.split("=")),
          );
          if (fields.type === "bind") {
            mounts.set(fields.target ?? fields.dst!, fields.source ?? fields.src!);
          }
        }
      }
      return ok;
    }
    if (args[0] === "exec") {
      const env = { ...childEnvironment(), ...containerEnv };
      let index = 1;
      while (args[index] === "-e") {
        const value = args[index + 1]!;
        const at = value.indexOf("=");
        env[value.slice(0, at)] = value.slice(at + 1);
        index += 2;
      }
      index++;
      const command = args[index++]!;
      const childArgs = args.slice(index);
      if (command === "sh" && childArgs[0] === "-c") {
        childArgs[1] = shellPaths(childArgs[1]!);
      } else {
        for (let position = 0; position < childArgs.length; position++) {
          if (childArgs[position]!.startsWith("/")) {
            childArgs[position] = resolvePath(childArgs[position]!);
          }
        }
      }
      return execute(env, { ...spec, command, args: childArgs });
    }
    if (args[0] === "cp") {
      const [from, to] = args.slice(args[1] === "--quiet" ? 2 : 1);
      const local = (value: string) =>
        value.includes(":") ? resolvePath(value.slice(value.indexOf(":") + 1)) : value;
      const source = local(from!);
      const target = local(to!);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
      return ok;
    }
    throw new Error("unsupported fixture Docker transport command");
  };
  return { calls, exec, container };
}

function fixture() {
  const layoutFixture = makeFixture();
  roots.push(layoutFixture.base);
  const layout = loadLayout(layoutFixture.root);
  const game = gameLayout(layout, "archies-dog-walks");
  git(game.repo, ["init", "--template=", "--initial-branch=main"]);
  writeFileSync(join(game.repo, ".gitignore"), "dist/\nnode_modules/\n");
  writeFileSync(join(game.repo, "source.txt"), "first source\n");
  writeFileSync(
    join(game.repo, "check.mjs"),
    `import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const git = args => execFileSync('git',args,{encoding:'utf8'}).trim();
const commit = git(['rev-parse','HEAD']);
const tree = git(['rev-parse','HEAD^{tree}']);
const workingTreeMatches = git(['rev-parse','--show-toplevel']) === process.cwd();
const commits = Number(git(['rev-list','--count','HEAD']));
const detached = spawnSync('git',['symbolic-ref','-q','HEAD']).status === 1;
const dirty = git(['status','--porcelain=v1','--untracked-files=all']);
const qualified = workingTreeMatches && detached && commits === 1 &&
  commit === process.env.WORKERS_CI_COMMIT_SHA && dirty === '';
if (!qualified) {
  throw new Error('unqualified source identity');
}
mkdirSync('dist');
writeFileSync('dist/proof.json',JSON.stringify({commit,tree,detached,commits,workingTreeMatches}));
`,
  );
  git(game.repo, ["add", "."]);
  git(game.repo, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial fixture source"]);
  const parent = git(game.repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(game.repo, "source.txt"), "current source\n");
  git(game.repo, ["add", "."]);
  git(game.repo, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Current fixture source"]);
  const commit = git(game.repo, ["rev-parse", "HEAD"]);
  const tree = git(game.repo, ["rev-parse", "HEAD^{tree}"]);
  const config = validateProjectConfig({
    ...projectConfig("Archie"),
    gate: {
      image: "stock-node-fixture",
      install: "",
      steps: [{ name: "identity", run: "node check.mjs" }],
    },
  });
  const root = mkdtempSync(join(tmpdir(), "gate-identity-"));
  roots.push(root);
  const docker = dockerFilesystem(root);
  const context = busContext({ exec: docker.exec, log: () => {} }, layout, game, config);
  const logs = join(root, "logs");
  mkdirSync(logs);
  return {
    game,
    parent,
    commit,
    tree,
    docker,
    context,
    input: { work: game.repo, sha: commit, logs, departure: commit.slice(0, 12) },
  };
}

describe("stock gate genuine source identity", () => {
  it("runs the real gate script with the exact detached commit and tree", async () => {
    const test = fixture();
    const before = readFileSync(join(test.game.repo, "source.txt"));
    const result = await runGate(test.context, test.input);
    expect(result, result.ok ? undefined : result.reason).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(test.game.repo, "dist/proof.json"), "utf8"))).toEqual({
      commit: test.commit,
      tree: test.tree,
      detached: true,
      commits: 1,
      workingTreeMatches: true,
    });
    expect(readFileSync(join(test.game.repo, "source.txt"))).toEqual(before);
    expect(git(test.game.repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    expect(test.docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it.each(["dirty", "ignored", "missing", "mismatched"] as const)(
    "refuses %s source identity before any gate step",
    async (fault) => {
      const test = fixture();
      if (fault === "dirty") {
        writeFileSync(join(test.game.repo, "source.txt"), "dirty copied source\n");
      }
      if (fault === "missing") {
        rmSync(join(test.game.repo, ".git"), { recursive: true });
      }
      if (fault === "ignored") {
        mkdirSync(join(test.game.repo, "node_modules"));
        writeFileSync(
          join(test.game.repo, "node_modules", "fixture.txt"),
          "ignored fixture cache\n",
        );
      }
      const input = fault === "mismatched" ? { ...test.input, sha: test.parent } : test.input;
      const before = readFileSync(join(test.game.repo, "source.txt"));
      const result = await runGate(test.context, input);
      expect(result).toMatchObject({ ok: false, failure: "infrastructure" });
      expect(existsSync(join(test.game.repo, "dist/proof.json"))).toBe(false);
      expect(readFileSync(join(test.game.repo, "source.txt"))).toEqual(before);
      if (fault === "ignored") {
        expect(test.docker.calls.some((args) => args[0] === "create")).toBe(false);
      }
      expect(
        test.docker.calls.some((args) => args.some((arg) => arg.includes("node check.mjs"))),
      ).toBe(false);
      if (test.docker.calls.some((args) => args[0] === "create")) {
        expect(test.docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
      } else {
        expect(test.docker.calls.some((args) => args[0] === "exec")).toBe(false);
      }
    },
  );
});
