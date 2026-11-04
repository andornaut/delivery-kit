import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { spawnExec } from "./exec.ts";
import {
  captureRequest,
  claimRequest,
  finishRequest,
  recoverRequests,
  type RequestStore,
  validateRequest,
} from "./requests.ts";
import { busPaths } from "./state.ts";
import { makeGame, mergeFastForward, type TestGame } from "./testGame.ts";

function store(): RequestStore & { file: (id: string) => string; test: TestGame } {
  const test = makeGame();
  const paths = busPaths(test.game.busDir);
  return {
    exec: spawnExec,
    file: (id) => join(paths.requestsDir, `${id}.json`),
    main: "main",
    paths,
    repo: test.repo,
    test,
  };
}

describe("one-off requests", () => {
  it("captures the current main HEAD once per ID and refuses one with nothing new", async () => {
    const requests = store();
    const head = mergeFastForward(requests.test, "feature");
    const expected = `{"head": "${head}", "id": "r1", "state": "pending"}\n`;
    expect(await captureRequest(requests, "r1")).toBe(expected);
    expect(readFileSync(requests.file("r1"), "utf8")).toBe(expected);
    expect(await captureRequest(requests, "r1")).toBe(expected);
    writeFileSync(requests.paths.lastPushSha, `${head}\n`);
    await expect(captureRequest(requests, "r2")).rejects.toThrow("nothing new to depart");
    await expect(captureRequest(requests, "-bad")).rejects.toThrow("request ID must be 1-64");
  });

  it("refuses a HEAD whose gate already failed", async () => {
    const requests = store();
    const head = mergeFastForward(requests.test, "feature");
    mkdirSync(requests.paths.gateFailedDir, { recursive: true });
    writeFileSync(join(requests.paths.gateFailedDir, head), "failed\n");
    await expect(captureRequest(requests, "r1")).rejects.toThrow("gate already failed");
  });

  it("claims, validates, finishes and recovers through the documented states", async () => {
    const requests = store();
    mergeFastForward(requests.test, "feature");
    await captureRequest(requests, "a1");
    await captureRequest(requests, "b1");
    expect(await claimRequest(requests)).toBe("a1");
    expect(await validateRequest(requests, "a1")).toBe(true);
    await finishRequest(requests, "a1", 0);
    expect(JSON.parse(readFileSync(requests.file("a1"), "utf8"))).toMatchObject({
      completion: "departure flow only; consult exact-commit CI and deployment state",
      departure_exit: 0,
      state: "finished",
    });
    expect(await claimRequest(requests)).toBe("b1");
    await recoverRequests(requests);
    expect(JSON.parse(readFileSync(requests.file("b1"), "utf8")).state).toBe("interrupted");
    expect(await claimRequest(requests)).toBeUndefined();
  });

  it("rejects a request whose main HEAD moved after capture", async () => {
    const requests = store();
    mergeFastForward(requests.test, "feature");
    await captureRequest(requests, "r1");
    mergeFastForward(requests.test, "later");
    expect(await validateRequest(requests, "r1")).toBe(false);
    expect(JSON.parse(readFileSync(requests.file("r1"), "utf8"))).toMatchObject({
      reason: "main moved since the request",
      state: "rejected",
    });
  });
});
