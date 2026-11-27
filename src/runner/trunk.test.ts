import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { spawnExec } from "../lib/exec.ts";
import { commitFile, gitSync, makeGame } from "../testing/game.ts";
import { changedPaths, docsOnly } from "./trunk.ts";

describe("docsOnly", () => {
  it("accepts only a known, non-empty range under docs/", () => {
    expect(docsOnly(["docs/reference/runner.md", "docs/guides/upgrading.md"])).toBe(true);
    expect(docsOnly(["docs/reference/runner.md", "README.md"])).toBe(false);
    expect(docsOnly(["docsite/index.md"])).toBe(false);
    expect(docsOnly(["src/docs/notes.md"])).toBe(false);
    expect(docsOnly([])).toBe(false);
    expect(docsOnly(undefined)).toBe(false);
  });
});

describe("changedPaths", () => {
  it("lists both sides of a rename and leaves an unknown range undefined", async () => {
    const { game } = makeGame();
    const from = gitSync(game.repo, "rev-parse", "HEAD");
    mkdirSync(join(game.repo, "docs"));
    gitSync(game.repo, "mv", "README.md", "docs/README.md");
    gitSync(game.repo, "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-qm", "move");
    const to = commitFile(game.repo, "docs/guide.md", "guide\n");
    const paths = await changedPaths(spawnExec, game.repo, from, to);
    expect(paths?.sort()).toEqual(["README.md", "docs/README.md", "docs/guide.md"]);
    expect(docsOnly(paths)).toBe(false);
    expect(await changedPaths(spawnExec, game.repo, undefined, to)).toBeUndefined();
    expect(await changedPaths(spawnExec, game.repo, "f".repeat(40), to)).toBeUndefined();
  });
});
