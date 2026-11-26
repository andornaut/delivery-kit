import { expect } from "vitest";

import { cli, execute, impl, startRunner } from "../lib/adapter.ts";
import { contract, EXIT_INVALID, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";

const CLAUDE_OPERATOR = "00000000-0000-4000-8000-000000000101";
const CODEX_OPERATOR = "00000000-0000-4000-8000-000000000202";
const REVIEWER = "00000000-0000-4000-8000-000000000203";
const OPERATE = "delivery:operate";
const REVIEW = "review:deliver";
const INGEST = "events:ingest";
const RUNNER_GRANTS = [OPERATE, REVIEW, INGEST];

function grant(ws: Workspace, role: string, permissions: string[]) {
  return { [role]: { apps: { [ws.game]: permissions }, workspace: [] } };
}

function configure(ws: Workspace, name: string, recipient: string, departures: string[]): void {
  ws.config.git = { main: "main", remote: "origin", github: `fixture/${ws.game}` };
  ws.config.schedule = { departures, timezone: "UTC" };
  ws.config.deploy = { mode: "none" };
  ws.config.reports = { project: name, recipient, scheduledTicks: true };
}

function control(requester: string): string[] {
  return [
    "control",
    "--state",
    "enabled",
    "--reason",
    "fixture delivery",
    "--requester",
    requester,
  ];
}

async function enable(ws: Workspace, requester: string): Promise<void> {
  const result = await cli(ws, control(requester));
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ requester, state: "enabled" });
}

function pushes(ws: Workspace) {
  return ws.calls("git").filter((call) => call.args.includes("push"));
}

function expectDelivery(ws: Workspace, head: string, deployed: boolean): void {
  expect(pushes(ws).map((call) => call.args.at(-1))).toEqual([`${head}:refs/heads/main`]);
  const deployEvent = deployed ? "deploy_success" : "deploy_disabled";
  const outcomes = ws
    .events()
    .filter((event) =>
      ["gate_passed", "push", "ci_success", deployEvent].includes(String(event.type)),
    )
    .map((event) => [event[ws.layout === "legacy" ? "game" : "appId"], event.sha, event.type]);
  const types = deployed
    ? ["gate_passed", "push", "ci_success", deployEvent]
    : ["gate_passed", "push", deployEvent, "ci_success"];
  expect(outcomes).toEqual(types.map((type) => [ws.game, head, type]));
  expect(ws.calls("wrangler")).toHaveLength(deployed ? 1 : 0);
}

suite("standalone delivery with configured roles", () => {
  const workspace = workspaces();

  contract.each(["legacy", "apps"] as const)(
    "one arbitrary operator enables delivery at the configured slot with %s layout",
    async (layout) => {
      const appMode = layout === "apps";
      const operator = appMode ? "publisher" : "catalog/publisher";
      const ws = workspace({
        deliveryState: null,
        game: "catalog",
        layout: appMode ? layout : undefined,
        name: "Catalog",
        roles: ["publisher"],
        selector: appMode ? "--app" : "--game",
        sharedRoles: [],
      });
      configure(ws, "Catalog", operator, ["17"]);
      ws.config.deploy = { mode: "wrangler" };
      ws.writeRegistry({
        ...ws.registry(),
        operations: { [ws.game]: { busOwner: operator } },
        roles: { [operator]: { conversations: { claude: CLAUDE_OPERATOR } } },
      });
      if (appMode) {
        ws.env.CLAUDE_CODE_SESSION_ID = CLAUDE_OPERATOR;
        ws.updateCoordinatorConfig({
          permissions: grant(ws, operator, RUNNER_GRANTS),
          wakeMinutes: [17],
        });
        ws.installReleasedCoordinatorCli();
      }
      const check = await execute(impl.checkConfig(ws));
      expect(check.code, check.stderr).toBe(0);
      await enable(ws, operator);

      const head = ws.git("rev-parse", "main");
      ws.holdClock(at(16, 59));
      const runner = startRunner(ws);
      try {
        await runner.armed();
        expect(pushes(ws)).toEqual([]);
        ws.advanceClock(2);
        await runner.until(() => ws.events().some((event) => event.type === "deploy_success"));
        if (appMode) {
          const review = `bus: scheduled review ${at(17)}`;
          await runner.until(() => runner.output().stdout.includes(review));
          expect(runner.output().stdout).toContain(`${review}: skipped nothing-due`);
          await runner.until(() => ws.events().some((event) => event.type === "scheduled-status"));
          await runner.until(
            () =>
              runner.output().stderr.includes("event ingest failed") ||
              (ws.exists("events.cursor") &&
                ws.readJson("events.cursor").offset === Buffer.byteLength(ws.read("events.jsonl"))),
          );
          expect(runner.output().stderr).not.toContain("event ingest failed");
          expect(ws.exists("events.quarantine.jsonl")).toBe(false);
        }
      } finally {
        await runner.stop();
      }
      expect(ws.events().filter((event) => event.type === "scheduled-status")).toMatchObject([
        { [appMode ? "appId" : "game"]: ws.game, key: String(at(17)) },
      ]);
      expectDelivery(ws, head, true);
    },
  );

  contract(
    "app-scoped operators and identical request IDs retain distinct delivery state",
    async () => {
      const catalog = workspace({
        deliveryState: null,
        game: "catalog",
        layout: "migrated-apps",
        name: "Catalog",
        roles: ["catalog/publisher"],
        selector: "--app",
        sharedRoles: [],
      });
      const ledger = workspace({
        alongside: catalog,
        deliveryState: null,
        game: "ledger",
        name: "Ledger",
        roles: ["ledger/releaser", "ledger/reviewer"],
        selector: "--game",
      });
      const publisher = "catalog/publisher";
      const releaser = "ledger/releaser";
      configure(catalog, "Catalog", publisher, ["42"]);
      configure(ledger, "Ledger", "ledger/reviewer", ["53"]);
      catalog.writeRegistry({
        ...catalog.registry(),
        operations: {
          catalog: { busOwner: publisher },
          ledger: { busOwner: releaser },
        },
        roles: {
          [publisher]: { conversations: { claude: CLAUDE_OPERATOR } },
          [releaser]: { conversations: { codex: CODEX_OPERATOR }, harness: "codex" },
          "ledger/reviewer": { conversations: { claude: REVIEWER } },
        },
      });
      catalog.updateCoordinatorConfig({
        permissions: {
          ...grant(catalog, publisher, RUNNER_GRANTS),
          ...grant(ledger, releaser, [OPERATE]),
        },
      });
      catalog.env.CLAUDE_CODE_SESSION_ID = CLAUDE_OPERATOR;
      ledger.env.CODEX_THREAD_ID = CODEX_OPERATOR;
      catalog.installReleasedCoordinatorCli();
      await enable(catalog, publisher);
      await enable(ledger, releaser);
      const check = await execute(impl.bare(catalog, ["check-config"]));
      expect(check.code, check.stderr).toBe(0);
      expect(check.stdout).toContain("catalog, ledger");

      const id = "manual-release";
      const pending = { head: catalog.git("rev-parse", "main"), id, state: "pending" };
      const receipt = ["requests", `${id}.json`];
      for (const ws of [catalog, ledger]) {
        const capture = await execute(impl.request(ws, id));
        expect(capture.code, capture.stderr).toBe(0);
        expect(JSON.parse(capture.stdout)).toEqual(pending);
        expect(ws.readJson(...receipt)).toEqual(pending);
        expect(pushes(ws)).toEqual([]);
      }
      catalog.holdClock(at(17));
      const runner = startRunner(catalog);
      try {
        await runner.until(
          () =>
            catalog.readJson(...receipt).state === "finished" &&
            catalog.events().some((event) => event.type === "ci_success"),
        );
      } finally {
        await runner.stop();
      }
      expect(catalog.readJson(...receipt)).toMatchObject({
        departure_exit: 0,
        head: pending.head,
        id,
        state: "finished",
      });
      expect(catalog.events().filter((event) => event.type === "attempt")).toMatchObject([
        { appId: catalog.game, key: `request-${id}` },
      ]);
      expect(catalog.events().some((event) => event.type === "scheduled-status")).toBe(false);
      expectDelivery(catalog, pending.head, false);
      expect(ledger.readJson(...receipt)).toEqual(pending);
      expect(ledger.events()).toEqual([]);
      expect(pushes(ledger)).toEqual([]);
    },
  );
});

suite("app delivery authorization", () => {
  const workspace = workspaces();
  const releaser = "ledger/releaser";
  const denials: { caller: string; selector?: "--app" | "--game"; words: string[] }[] = [
    { caller: "unbound", words: ["request", "--id", "unauthorized"] },
    { caller: "unknown", words: ["request", "--id", "unauthorized"] },
    { caller: "other app's owner", words: ["request", "--id", "unauthorized"] },
    { caller: "other app's owner", selector: "--game", words: ["request", "--id", "unauthorized"] },
    { caller: "held", words: ["request", "--id", "unauthorized"] },
    { caller: "missing operate", words: ["request", "--id", "unauthorized"] },
    { caller: "unbound", words: control("publisher") },
    { caller: "spoofed requester", words: control(releaser) },
    { caller: "missing review", words: ["run"] },
    { caller: "missing ingest", words: ["run"] },
    { caller: "missing review", words: ["runner", "start"] },
    { caller: "missing ingest", words: ["runner", "start"] },
    { caller: "other app's owner", words: ["runner", "stop"] },
  ];
  contract.each(denials)(
    "$caller cannot invoke $words ($selector)",
    async ({ caller, selector, words }) => {
      const catalog = workspace({
        deliveryState: null,
        game: "catalog",
        layout: "apps",
        roles: ["publisher"],
        selector: selector ?? "--app",
        sharedRoles: [],
      });
      const ledger = workspace({
        alongside: catalog,
        deliveryState: null,
        game: "ledger",
        roles: ["ledger/releaser"],
      });
      configure(catalog, "Catalog", "publisher", ["17"]);
      catalog.writeRegistry({
        ...catalog.registry(),
        operations: { catalog: { busOwner: "publisher" }, ledger: { busOwner: releaser } },
        roles: {
          publisher: {
            conversations: { claude: CLAUDE_OPERATOR },
            ...(caller === "held" ? { phase: "source-held" } : {}),
          },
          [releaser]: { conversations: { codex: CODEX_OPERATOR }, harness: "codex" },
        },
      });
      const missing: Partial<Record<string, string>> = {
        "missing ingest": INGEST,
        "missing operate": OPERATE,
        "missing review": REVIEW,
      };
      const publisherGrants = RUNNER_GRANTS.filter((permission) => permission !== missing[caller]);
      catalog.updateCoordinatorConfig({
        permissions: {
          publisher: {
            apps: { [catalog.game]: publisherGrants, [ledger.game]: RUNNER_GRANTS },
            workspace: [],
          },
          [releaser]: {
            apps: { [catalog.game]: RUNNER_GRANTS, [ledger.game]: RUNNER_GRANTS },
            workspace: [],
          },
        },
      });
      if (caller === "other app's owner") {
        catalog.env.CODEX_THREAD_ID = CODEX_OPERATOR;
      } else if (caller !== "unbound") {
        catalog.env.CLAUDE_CODE_SESSION_ID = caller === "unknown" ? REVIEWER : CLAUDE_OPERATOR;
      }
      // A broken lock prevents an unexpected resident from starting if the permission check regresses.
      if (words[0] === "run" || words[1] === "start") catalog.write("runner.lock/sentinel", "");
      const before = catalog.list();
      const result = await cli(catalog, words);
      expect(result, result.stderr).toMatchObject({ code: EXIT_INVALID, stdout: "" });
      expect(result.stderr).toMatch(/permission|authoriz|caller|operator|requester|bus.?owner/i);
      expect(catalog.list()).toEqual(before);
      expect(catalog.events()).toEqual([]);
      expect(pushes(catalog)).toEqual([]);
    },
  );
});
