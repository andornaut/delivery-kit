import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JsonFileError,
  readJson,
  readJsonIfExists,
  writeDurable,
  writeJsonDurable,
} from "./durable.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "durable-"));
}

describe("writeDurable", () => {
  it("replaces the target with exact bytes and the requested mode, leaving no temp file", () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");
    writeDurable(path, "new\n", { mode: 0o640 });
    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("syncs the temp file before the rename and keeps the old target until then", () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");
    const stages: string[] = [];
    writeDurable(path, "new", {
      onStage: (stage, temp) => {
        stages.push(stage);
        if (stage === "synced") {
          expect(readFileSync(path, "utf8")).toBe("old");
          expect(readFileSync(temp, "utf8")).toBe("new");
        }
      },
    });
    expect(stages).toEqual(["synced", "renamed"]);
  });

  it("removes its temp file and leaves the target unchanged when the write fails", () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");
    expect(() =>
      writeDurable(path, "new", {
        onStage: () => {
          throw new Error("interrupted");
        },
      }),
    ).toThrow("interrupted");
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("JSON helpers", () => {
  it("round-trips JSON and distinguishes missing from invalid files", () => {
    const dir = scratch();
    const path = join(dir, "value.json");
    writeJsonDurable(path, { a: 1 });
    expect(readJson(path)).toEqual({ a: 1 });
    expect(readJsonIfExists(join(dir, "absent.json"))).toBeUndefined();
    expect(() => readJson(join(dir, "absent.json"))).toThrow(JsonFileError);
    writeFileSync(path, "{");
    expect(() => readJsonIfExists(path)).toThrow("invalid JSON");
  });
});
