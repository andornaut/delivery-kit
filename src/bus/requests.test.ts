import { readFileSync, writeFileSync } from "node:fs";
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
import { commitFile, gitSync, makeGame, queueBranch, type TestGame } from "./testGame.ts";

function store(): RequestStore & { file: (id: string) => string; test: TestGame } {
  const test = makeGame();
  const paths = busPaths(test.game.busDir);
  return {
    exec: spawnExec,
    file: (id) => join(paths.requestsDir, `${id}.json`),
    paths,
    repo: test.repo,
    test,
  };
}

describe("one-off requests", () => {
  it("captures the ordered queue with exact tips in the 0.9.x record format, once per ID", async () => {
    const requests = store();
    const first = queueBranch(requests.test, "bus/one");
    const second = queueBranch(requests.test, "bus/two");
    const entries = `[["bus/one", "${first}"], ["bus/two", "${second}"]]`;
    const expected = `{"entries": ${entries}, "id": "r1", "state": "pending"}\n`;
    expect(await captureRequest(requests, "r1")).toBe(expected);
    expect(readFileSync(requests.file("r1"), "utf8")).toBe(expected);
    writeFileSync(requests.paths.queue, "");
    expect(await captureRequest(requests, "r1")).toBe(expected);
    await expect(captureRequest(requests, "r2")).rejects.toThrow(
      "request requires a nonempty queue",
    );
    await expect(captureRequest(requests, "-bad")).rejects.toThrow("request ID must be 1-64");
  });

  it("claims, validates, finishes and recovers through the documented states", async () => {
    const requests = store();
    queueBranch(requests.test, "bus/one");
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

  it("rejects a request whose branch tip moved after capture", async () => {
    const requests = store();
    queueBranch(requests.test, "bus/one");
    await captureRequest(requests, "r1");
    gitSync(requests.repo, "checkout", "-q", "bus/one");
    commitFile(requests.repo, "later.txt", "later\n");
    gitSync(requests.repo, "checkout", "-q", "main");
    expect(await validateRequest(requests, "r1")).toBe(false);
    expect(JSON.parse(readFileSync(requests.file("r1"), "utf8"))).toMatchObject({
      reason: "queue or branch tips changed",
      state: "rejected",
    });
  });
});
