// Test fixtures for the coordinator seam: the fake coordination-kit CLI module installed under a
// fixture coordinator root, its call log, and an in-process recording coordinator.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Coordinator, COORDINATOR_CLI, type SeamOutcome } from "./seam.ts";

/** The fake CLI the unit and contract suites share. */
export const FAKE_COORDINATOR_CLI = fileURLToPath(
  new URL("../../tests/contract/lib/fake-coordination-kit.mjs", import.meta.url),
);

export interface FakeCall {
  readonly args: string[];
  readonly cwd: string;
  readonly execPath: string;
  readonly root: string;
}

/** Script the fake CLI; see the fake module's header for the control fields. */
export function scriptCoordinator(root: string, control: Record<string, unknown>): void {
  mkdirSync(join(root, "fake-coordination-kit"), { recursive: true });
  writeFileSync(join(root, "fake-coordination-kit", "control.json"), JSON.stringify(control));
}

/** Install the fake CLI as the coordinator root's coordination-kit. */
export function installCoordinator(root: string, control: Record<string, unknown> = {}): string {
  const cli = join(root, COORDINATOR_CLI);
  mkdirSync(dirname(cli), { recursive: true });
  copyFileSync(FAKE_COORDINATOR_CLI, cli);
  writeFileSync(
    join(dirname(dirname(cli)), "package.json"),
    JSON.stringify({ name: "@andornaut/coordination-kit", type: "module", version: "3.0.0" }),
  );
  scriptCoordinator(root, control);
  return cli;
}

export function coordinatorCalls(root: string): FakeCall[] {
  const path = join(root, "fake-coordination-kit", "calls.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall)
    : [];
}

export interface RecordingCoordinator extends Coordinator {
  readonly reviews: number[];
  ingests: number;
  probes: number;
  /** The outcome of each review; replace it to script one. */
  outcome: (slot: number) => SeamOutcome | Promise<SeamOutcome>;
}

const CLI = { distSha256: "a".repeat(64), version: "3.0.0" };

/** An in-process coordinator that records each call and delivers every review. */
export function recordingCoordinator(): RecordingCoordinator {
  const coordinator: RecordingCoordinator = {
    drain: () => Promise.resolve(),
    ingest() {
      coordinator.ingests += 1;
    },
    ingests: 0,
    outcome: () => ({
      claimed: true,
      cli: CLI,
      detail: "delivered",
      reason: null,
      status: "delivered",
    }),
    probe() {
      coordinator.probes += 1;
      return Promise.resolve(CLI);
    },
    probes: 0,
    review(slot) {
      coordinator.reviews.push(slot);
      return Promise.resolve(coordinator.outcome(slot));
    },
    reviews: [],
    stop: () => undefined,
  };
  return coordinator;
}
