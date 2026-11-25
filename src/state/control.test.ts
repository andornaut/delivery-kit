import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  beginDeliveryActivity,
  claimDeliveryRunner,
  ControlInvalid,
  ControlMissing,
  type ControlStore,
  endDeliveryActivity,
  readDeliveryControl,
  resumeDeliveryActivity,
  setDesiredDelivery,
  setObservedDelivery,
  updateDeliveryActivity,
} from "./control.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TOKEN = "runner-1";
const TIME = "2026-11-09T21:15:00.000Z";

function store(): ControlStore {
  return { dir: mkdtempSync(join(tmpdir(), "delivery-control-")), now: () => TIME };
}

function enabled(context: ControlStore): void {
  setDesiredDelivery(context, { state: "enabled", reason: "adopt", requester: "operator" });
  claimDeliveryRunner(context, TOKEN);
}

function child(context: ControlStore, source: string): Promise<string> {
  const module = fileURLToPath(new URL("./control.ts", import.meta.url));
  const process = spawn(
    globalThis.process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import * as control from ${JSON.stringify(module)};
    const store = {dir:${JSON.stringify(context.dir)}};
    ${source}
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let output = "";
    let error = "";
    process.stdout.on("data", (part: Buffer) => {
      output += part.toString();
    });
    process.stderr.on("data", (part: Buffer) => {
      error += part.toString();
    });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(error));
      }
    });
  });
}

describe("persistent delivery control", () => {
  it("fails closed without creating state, and explicit adoption leaves observation unattested", () => {
    const context = store();
    expect(() => readDeliveryControl(context)).toThrow(ControlMissing);
    expect(() => claimDeliveryRunner(context, TOKEN)).toThrow(ControlMissing);
    expect(() =>
      beginDeliveryActivity(context, TOKEN, { id: "a", state: "checking", sha: SHA }),
    ).toThrow(ControlMissing);
    expect(existsSync(join(context.dir, "delivery-control.json"))).toBe(false);
    const initial = setDesiredDelivery(context, {
      state: "paused",
      reason: "adopt",
      requester: "operator",
    });
    expect(initial.observed).toBeNull();
    expect(initial.desired).toEqual({
      state: "paused",
      reason: "adopt",
      requester: "operator",
      updatedAt: TIME,
      revision: 1,
    });
    expect(readDeliveryControl({ dir: context.dir })).toEqual(initial);
  });

  it.each(["{"])("preserves corrupt control %s", (contents) => {
    const context = store();
    const path = join(context.dir, "delivery-control.json");
    writeFileSync(path, contents);
    expect(() => readDeliveryControl(context)).toThrow(ControlInvalid);
    expect(() =>
      setDesiredDelivery(context, { state: "enabled", reason: "adopt", requester: "operator" }),
    ).toThrow(ControlInvalid);
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("serializes pause against admission and lets already admitted work finish", () => {
    const context = store();
    enabled(context);
    expect(
      beginDeliveryActivity(context, TOKEN, { id: "batch", state: "checking", sha: SHA }),
    ).toBe(true);
    const before = readDeliveryControl(context);
    const paused = setDesiredDelivery(context, {
      state: "paused",
      reason: "hold",
      requester: "operator",
    });
    expect(paused.observed).toEqual(before.observed);
    expect(paused.activities).toEqual(before.activities);
    expect(
      beginDeliveryActivity(context, TOKEN, { id: "later", state: "checking", sha: OTHER_SHA }),
    ).toBe(false);
    expect(
      updateDeliveryActivity(context, TOKEN, { id: "batch", state: "deploying", sha: SHA }),
    ).toBe(true);
    expect(readDeliveryControl(context).observed).toMatchObject({ state: "deploying", sha: SHA });
    expect(endDeliveryActivity(context, TOKEN, "batch")).toBe(true);
    expect(readDeliveryControl(context)).toMatchObject({
      desired: paused.desired,
      observed: { state: "idle", sha: null },
      activities: {},
    });
  });

  it("resumes trusted persisted work while paused without admitting new work", () => {
    const context = store();
    enabled(context);
    setDesiredDelivery(context, { state: "paused", reason: "hold", requester: "operator" });
    expect(resumeDeliveryActivity(context, TOKEN, { id: "ci", state: "checking", sha: SHA })).toBe(
      true,
    );
    expect(beginDeliveryActivity(context, TOKEN, { id: "new", state: "checking", sha: SHA })).toBe(
      false,
    );
    expect(setObservedDelivery(context, TOKEN, { state: "stopped", sha: null })).toBe(false);
  });

  it("retains a retired failure until other activities drain and preserves it through pause", () => {
    const context = store();
    enabled(context);
    beginDeliveryActivity(context, TOKEN, { id: "bad", state: "checking", sha: SHA });
    beginDeliveryActivity(context, TOKEN, { id: "other", state: "checking", sha: OTHER_SHA });
    updateDeliveryActivity(context, TOKEN, { id: "bad", state: "failed", sha: SHA });
    endDeliveryActivity(context, TOKEN, "bad");
    const failure = readDeliveryControl(context).lastFailure;
    expect(failure).toMatchObject({ state: "failed", sha: SHA, runnerToken: TOKEN });
    expect(readDeliveryControl(context).observed?.state).toBe("checking");
    setDesiredDelivery(context, { state: "paused", reason: "hold", requester: "operator" });
    expect(readDeliveryControl(context).lastFailure).toEqual(failure);
    endDeliveryActivity(context, TOKEN, "other");
    expect(readDeliveryControl(context)).toMatchObject({
      activities: {},
      observed: { state: "failed", sha: SHA },
    });
  });

  it("rejects stale identities, preserves same-token activity, and replaces old activities on claim", () => {
    const context = store();
    enabled(context);
    beginDeliveryActivity(context, TOKEN, { id: "ci", state: "checking", sha: SHA });
    expect(claimDeliveryRunner(context, TOKEN).activities.ci).toBeDefined();
    claimDeliveryRunner(context, "runner-2");
    const before = readFileSync(join(context.dir, "delivery-control.json"), "utf8");
    expect(updateDeliveryActivity(context, TOKEN, { id: "ci", state: "failed", sha: SHA })).toBe(
      false,
    );
    expect(endDeliveryActivity(context, TOKEN, "ci")).toBe(false);
    expect(beginDeliveryActivity(context, TOKEN, { id: "ci", state: "checking", sha: SHA })).toBe(
      false,
    );
    expect(resumeDeliveryActivity(context, TOKEN, { id: "ci", state: "checking", sha: SHA })).toBe(
      false,
    );
    expect(setObservedDelivery(context, TOKEN, { state: "stopped", sha: null })).toBe(false);
    expect(readFileSync(join(context.dir, "delivery-control.json"), "utf8")).toBe(before);
  });

  it.each(["A".repeat(40)])("rejects inexact SHA %s atomically", (sha) => {
    const context = store();
    enabled(context);
    const before = readDeliveryControl(context);
    expect(() =>
      beginDeliveryActivity(context, TOKEN, { id: "ci", state: "checking", sha }),
    ).toThrow(ControlInvalid);
    expect(readDeliveryControl(context)).toEqual(before);
  });

  it("rejects malformed persisted fields and inconsistent aggregates", () => {
    const context = store();
    enabled(context);
    const valid = readDeliveryControl(context);
    for (const patch of [
      { revision: 0 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { desired: { ...valid.desired, state: "yes" } },
      { desired: { ...valid.desired, reason: "" } },
      { observed: { ...valid.observed, updatedAt: "yesterday" } },
      { observed: { ...valid.observed, runnerToken: "" } },
      { lastFailure: { state: "failed", sha: SHA, updatedAt: TIME, runnerToken: "stale" } },
      { lastFailure: { state: "idle", sha: null, updatedAt: TIME, runnerToken: TOKEN } },
      { lastFailure: { state: "failed", sha: "short", updatedAt: TIME, runnerToken: TOKEN } },
      { activities: { ci: { state: "checking", sha: SHA, updatedAt: TIME } } },
    ]) {
      writeFileSync(
        join(context.dir, "delivery-control.json"),
        JSON.stringify({ ...valid, ...patch }),
      );
      expect(() => readDeliveryControl(context)).toThrow(ControlInvalid);
    }
  });

  it("preserves all desired and observed writes from independent concurrent processes", async () => {
    const context = store();
    enabled(context);
    beginDeliveryActivity(context, TOKEN, { id: "ci", state: "checking", sha: SHA });
    await Promise.all([
      child(
        context,
        `for(let i=0;i<12;i++) control.setDesiredDelivery(store,
        {state:'paused',reason:'hold-'+i,requester:'operator'});`,
      ),
      child(
        context,
        `for(let i=0;i<12;i++) control.updateDeliveryActivity(store,'${TOKEN}',
        {id:'ci',state:'checking',sha:'${OTHER_SHA}'});`,
      ),
    ]);
    const final = readDeliveryControl(context);
    expect(final.revision).toBe(27);
    expect(final.desired).toMatchObject({ state: "paused", reason: "hold-11" });
    expect(final.observed).toMatchObject({ state: "checking", sha: OTHER_SHA });
  });

  it("linearizes competing process admission and pause at the same lock", async () => {
    const context = store();
    enabled(context);
    const [admission] = await Promise.all([
      child(
        context,
        `console.log(control.beginDeliveryActivity(store,'${TOKEN}',
        {id:'batch',state:'checking',sha:'${SHA}'}));`,
      ),
      child(
        context,
        `control.setDesiredDelivery(store,
        {state:'paused',reason:'hold',requester:'operator'});`,
      ),
    ]);
    const final = readDeliveryControl(context);
    expect(final.desired.state).toBe("paused");
    if (admission.trim() === "true") {
      expect(final.activities.batch).toBeDefined();
      expect(final.desired.revision).toBe(4);
    } else {
      expect(admission.trim()).toBe("false");
      expect(final.activities).toEqual({});
      expect(final.desired.revision).toBe(3);
    }
  });
});
