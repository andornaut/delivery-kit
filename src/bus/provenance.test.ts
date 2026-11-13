import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { gameLayout, loadLayout } from "../layout.ts";
import { holdLock } from "../lock.ts";
import { makeFixture } from "../testFixtures.ts";
import {
  beginDeliveryActivity,
  claimDeliveryRunner,
  setDesiredDelivery,
  setObservedDelivery,
} from "./control.ts";
import { loadedIdentity, PACKAGE } from "./pin.ts";
import { busPaths } from "./state.ts";
import { recordIdentity, statusReport } from "./status.ts";

const SOURCE = "a".repeat(40);
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const unknownComparison = { cli_sha256: "unknown", source_commit: "unknown", version: "unknown" };
const unknownEvidence = { cli_sha256: null, source_commit: null, version: null };

function install(repo: string, version = "3.0.1", cli = "build A", source = SOURCE): string {
  const root = join(repo, "node_modules", PACKAGE);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE, version }));
  writeFileSync(join(root, "SOURCE_COMMIT"), source);
  writeFileSync(join(root, "dist", "cli.js"), cli);
  return join(root, "dist", "cli.js");
}

function fixture() {
  const { root } = makeFixture();
  const game = gameLayout(loadLayout(root), "archies-dog-walks");
  const bus = busPaths(game.busDir);
  mkdirSync(bus.dir, { recursive: true });
  const cli = install(game.repo);
  const loaded = loadedIdentity("3.0.1", cli, game.repo);
  const runner = holdLock(bus.runnerLock);
  const loop = holdLock(bus.loopLock);
  const identity = recordIdentity(bus, {
    cliSha256: loaded.cliSha256,
    config: game.configFile,
    pid: 42,
    sourceCommit: loaded.sourceCommit,
    toolRoot: join(game.repo, "node_modules", PACKAGE),
    version: loaded.version ?? "",
  });
  return {
    bus,
    game,
    identity,
    loop,
    root,
    report: () => statusReport(bus, game.repo),
    release: () => {
      loop.release();
      runner.release();
    },
  };
}

describe("status provenance", () => {
  it("uses the game's installation and preserves the startup digest across package replacement", async () => {
    const test = fixture();
    try {
      install(test.root, "9.9.9", "caller build", "c".repeat(40));
      let out = "";
      let err = "";
      const code = await main(
        { cwd: test.root, env: {}, err: (text) => (err += text), out: (text) => (out += text) },
        ["status", "--game", "archies-dog-walks"],
      );
      expect({ code, err }).toEqual({ code: 0, err: "" });
      const original = { cli_sha256: digest("build A"), source_commit: SOURCE, version: "3.0.1" };
      expect(JSON.parse(out).provenance).toEqual({
        archive: { reason: "no_independent_verification", status: "unknown" },
        comparison: { cli_sha256: "match", source_commit: "match", version: "match" },
        installed: original,
        resident: original,
        resident_status: "attested",
      });
      const before = readFileSync(test.bus.identity, "utf8");
      install(test.game.repo, "3.0.1", "build B");
      expect(test.report().provenance).toMatchObject({
        comparison: { cli_sha256: "different", source_commit: "match", version: "match" },
        resident: original,
        installed: { cli_sha256: digest("build B") },
      });
      install(test.game.repo, "3.1.0", "build B", "b".repeat(40));
      expect(test.report().provenance).toMatchObject({
        comparison: { cli_sha256: "different", source_commit: "different", version: "different" },
        resident: original,
      });
      expect(readFileSync(test.bus.identity, "utf8")).toBe(before);
    } finally {
      test.release();
    }
  });

  it.each([undefined, "not-a-digest"])(
    "does not reconstruct missing or invalid startup evidence (%s) from runner.json or installed bytes",
    (startupDigest) => {
      const test = fixture();
      try {
        const identity = JSON.parse(readFileSync(test.bus.identity, "utf8"));
        identity.cli_sha256 = startupDigest;
        writeFileSync(test.bus.identity, JSON.stringify(identity));
        writeFileSync(
          test.bus.runnerJson,
          JSON.stringify({ cliSha256: digest("build A"), version: "3.0.1" }),
        );
        expect(test.report()).toMatchObject({
          identity_status: "current",
          idle: true,
          drained: true,
          provenance: {
            comparison: unknownComparison,
            resident: unknownEvidence,
            resident_status: "unknown",
            installed: { cli_sha256: digest("build A") },
          },
        });
      } finally {
        test.release();
      }
    },
  );

  it("keeps busy, reporter, stopped and unattested states separate from provenance matches", () => {
    const test = fixture();
    const store = { dir: test.bus.dir };
    try {
      setDesiredDelivery(store, {
        state: "enabled",
        reason: "fixture",
        requester: "game-coordinator",
      });
      const token = test.identity.token as string;
      claimDeliveryRunner(store, token);
      beginDeliveryActivity(store, token, { id: "batch", state: "checking", sha: SOURCE });
      writeFileSync(test.bus.activeDeparture, "1\n");
      mkdirSync(test.bus.eventsDir);
      writeFileSync(join(test.bus.eventsDir, "one.json"), JSON.stringify({ sent: false }));
      expect(test.report()).toMatchObject({
        idle: false,
        drained: false,
        idle_blockers: ["active_departure"],
        reporter_blockers: ["unsent_events:1"],
        control: { observed: { state: "checking" }, observed_status: "current" },
        provenance: { resident_status: "attested", comparison: { cli_sha256: "match" } },
      });
      test.loop.release();
      expect(test.report()).toMatchObject({
        runner_lock_held: true,
        loop_lock_held: false,
        provenance: { resident_status: "unknown", comparison: unknownComparison },
      });
      writeFileSync(test.bus.runnerLock, "other-token\n");
      expect(test.report()).toMatchObject({
        identity_status: "unattested",
        provenance: { resident_status: "unknown" },
      });
      test.release();
      expect(test.report()).toMatchObject({
        status: "not running",
        identity_status: "stale",
        provenance: { resident_status: "unknown", comparison: unknownComparison },
      });
    } finally {
      test.release();
    }
  });

  it("reports an idle stopped singleton as unknown even with an attested stopped observation", () => {
    const test = fixture();
    try {
      const store = { dir: test.bus.dir };
      setDesiredDelivery(store, {
        state: "enabled",
        reason: "fixture",
        requester: "game-coordinator",
      });
      const token = test.identity.token as string;
      claimDeliveryRunner(store, token);
      setObservedDelivery(store, token, { state: "stopped", sha: null });
      test.release();
      expect(test.report()).toMatchObject({
        status: "not running",
        idle: true,
        drained: true,
        control: { observed_status: "current", observed: { state: "stopped" } },
        provenance: {
          resident_status: "unknown",
          resident: unknownEvidence,
          comparison: unknownComparison,
        },
      });
    } finally {
      test.release();
    }
  });

  it("does not treat package metadata or lock integrity as verified archive evidence", () => {
    const test = fixture();
    try {
      writeFileSync(
        join(test.game.repo, "package-lock.json"),
        JSON.stringify({
          archiveVerified: true,
          packages: { [`node_modules/${PACKAGE}`]: { integrity: "sha512-claimed" } },
        }),
      );
      const installed = join(test.game.repo, "node_modules", PACKAGE);
      writeFileSync(join(installed, "SOURCE_COMMIT"), "not-a-commit");
      writeFileSync(
        join(installed, "package.json"),
        JSON.stringify({ name: "wrong-package", version: "3.0.1" }),
      );
      expect(test.report().provenance).toMatchObject({
        archive: { status: "unknown", reason: "no_independent_verification" },
        installed: { source_commit: null, version: null },
        comparison: { cli_sha256: "match", source_commit: "unknown", version: "unknown" },
      });
      const absent = join(test.root, "no-installation");
      expect(statusReport(test.bus, absent).provenance).toMatchObject({
        installed: unknownEvidence,
        comparison: unknownComparison,
      });
      const report = test.report().provenance;
      expect(report.resident.source_commit).toBe(SOURCE);
    } finally {
      test.release();
    }
  });
});
