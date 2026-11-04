// 0.9 source archive packaging (from tests/test_package.py), run on the v0.9.1 release tree. 1.0 replaces package.sh with an
// npm pack script owned by P2, so this contract runs against the Bash release only, and
// scheduled-once is retired (decision 6).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { execute } from "../lib/adapter.ts";
import { bashOnly, retired, suite, workspaces } from "../lib/cases.ts";
import { BASH_ROOT } from "../lib/parity.ts";

suite("packaging", () => {
  const workspace = workspaces();

  bashOnly("a pinned archive is reproducible and excludes dirty and local files", async () => {
    const ws = workspace();
    const source = join(ws.root, "source");
    mkdirSync(source);
    for (const name of ["bin", "examples", "libexec", "scripts", "tests"]) {
      cpSync(join(BASH_ROOT, name), join(source, name), {
        recursive: true,
        filter: (path) => !path.includes("__pycache__") && !path.includes("node_modules"),
      });
    }
    for (const name of ["README.md", "VERSION", "LICENSE"])
      cpSync(join(BASH_ROOT, name), join(source, name));
    // Packaging uses the real Git; the fakes stay off PATH.
    const env = { ...ws.baseEnv(), PATH: "/usr/local/bin:/usr/bin:/bin" };
    const sh = async (script: string, ...args: string[]) => {
      const result = await execute({
        argv: ["bash", "-c", script, "sh", ...args],
        cwd: source,
        env,
      });
      return result;
    };
    expect(
      (
        await sh(
          "git init -q -b main && git add -- bin examples libexec scripts tests README.md VERSION LICENSE && git -c core.hooksPath=/dev/null commit -q --no-verify -m Fixture",
        )
      ).code,
    ).toBe(0);
    const revision = (await sh("git rev-parse HEAD")).stdout.trim();
    const original = readFileSync(join(source, "README.md"));
    writeFileSync(join(source, "README.md"), "uncommitted edit");
    writeFileSync(join(source, "local-only"), "not packaged");
    const outputs = [join(ws.root, "first"), join(ws.root, "second")];
    for (const [index, output] of outputs.entries()) {
      const umask = index ? "077" : "022";
      const result = await sh(
        `umask ${umask}; bash scripts/package.sh "$1" "$2"`,
        revision,
        output,
      );
      expect(result.code, result.stderr).toBe(0);
      expect((await sh(`cd "$1" && sha256sum --check SHA256SUMS`, output)).code).toBe(0);
      expect(readFileSync(join(output, "SOURCE_COMMIT"), "utf8")).toBe(revision + "\n");
    }
    const name = `delivery-kit-${readFileSync(join(source, "VERSION"), "utf8").trim()}`;
    const archives = outputs.map((output) => join(output, `${name}.tar.gz`));
    expect(readFileSync(archives[0]!).equals(readFileSync(archives[1]!))).toBe(true);
    const listing = (await sh(`tar -tvzf "$1"`, archives[0]!)).stdout.split("\n");
    const names = (await sh(`tar -tzf "$1"`, archives[0]!)).stdout.split("\n").filter(Boolean);
    const extract = async (path: string) =>
      (await sh(`tar -xOzf "$1" "$2"`, archives[0]!, `${name}/${path}`)).stdout;
    expect(Buffer.from(await extract("README.md")).equals(original)).toBe(true);
    expect(await extract("SOURCE_COMMIT")).toBe(revision + "\n");
    expect(listing.find((row) => row.endsWith(`${name}/bin/delivery-kit`))).toMatch(/^-..x/);
    expect(names).toContain(`${name}/LICENSE`);
    expect(names).not.toContain(`${name}/local-only`);
    expect(names.some((entry) => /(^|\/)\.git(\/|$)/.test(entry))).toBe(false);
    for (const [arg, destination] of [
      ["HEAD", join(ws.root, "invalid")],
      [revision, outputs[0]!],
    ] as const) {
      expect((await sh(`bash scripts/package.sh "$1" "$2"`, arg, destination)).code).not.toBe(0);
    }
  });
});

retired(
  "scheduled-once (tests/verify-once.py)",
  "the native one-shot command is removed in 1.0 (plan decision 6); runs only from the resident runner remain",
  [
    "rejects a scheduled-at outside the five-minute window before and after the slot",
    "a held runner lock blocks the slot without a receipt and retains the queue",
    "a due slot departs once; a duplicate invocation for the same slot is a no-op",
    "a failed slot records finished exit=1 and is never retried; a later slot is independent",
    "an empty due slot succeeds silently and records finished exit=0",
  ],
);
