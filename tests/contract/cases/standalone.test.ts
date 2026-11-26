import { expect } from "vitest";

import { cli, execute, impl, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";

function configure(ws: Workspace, name: string, recipient: string, departures: string[]): void {
  ws.config.git = { main: "main", remote: "origin", github: `fixture/${ws.game}` };
  ws.config.schedule = { departures, timezone: "UTC" };
  ws.config.deploy = { mode: "none" };
  ws.config.reports = { project: name, recipient, scheduledTicks: true };
}

async function enable(ws: Workspace, requester: string): Promise<void> {
  const result = await cli(ws, [
    "control",
    "--state",
    "enabled",
    "--reason",
    "fixture delivery",
    "--requester",
    requester,
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ requester, state: "enabled" });
}

function pushes(ws: Workspace) {
  return ws.calls("git").filter((call) => call.args.includes("push"));
}

function expectDelivery(ws: Workspace, head: string): void {
  expect(pushes(ws).map((call) => call.args.at(-1))).toEqual([`${head}:refs/heads/main`]);
  const outcomes = ws
    .events()
    .filter((event) =>
      ["gate_passed", "push", "ci_success", "deploy_disabled"].includes(String(event.type)),
    )
    .map(({ game, sha, type }) => [game, sha, type]);
  expect(outcomes).toEqual(
    ["gate_passed", "push", "deploy_disabled", "ci_success"].map((type) => [ws.game, head, type]),
  );
  expect(ws.calls("wrangler")).toEqual([]);
}

suite("standalone delivery through legacy selectors", () => {
  const workspace = workspaces();

  contract("one arbitrary operator enables delivery at the configured slot", async () => {
    const operator = "catalog/publisher";
    const ws = workspace({
      deliveryState: null,
      game: "catalog",
      name: "Catalog",
      roles: ["publisher"],
      sharedRoles: [],
    });
    configure(ws, "Catalog", operator, ["17"]);
    ws.writeRegistry({
      ...ws.registry(),
      operations: { [ws.game]: { busOwner: operator } },
      roles: { [operator]: { conversations: { claude: "00000000-0000-4000-8000-000000000101" } } },
    });
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
      await runner.until(() => ws.events().some((event) => event.type === "ci_success"));
    } finally {
      await runner.stop();
    }
    expect(ws.events().filter((event) => event.type === "scheduled-status")).toMatchObject([
      { game: ws.game, key: String(at(17)) },
    ]);
    expectDelivery(ws, head);
  });

  contract(
    "app-scoped operators and identical request IDs retain distinct delivery state",
    async () => {
      const catalog = workspace({
        deliveryState: null,
        game: "catalog",
        name: "Catalog",
        roles: ["publisher"],
        sharedRoles: [],
      });
      const ledger = workspace({
        alongside: catalog,
        deliveryState: null,
        game: "ledger",
        name: "Ledger",
        roles: ["releaser", "reviewer"],
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
          [publisher]: { conversations: { claude: "00000000-0000-4000-8000-000000000201" } },
          [releaser]: { conversations: { claude: "00000000-0000-4000-8000-000000000202" } },
          "ledger/reviewer": { conversations: { claude: "00000000-0000-4000-8000-000000000203" } },
        },
      });
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
        { game: catalog.game, key: `request-${id}` },
      ]);
      expect(catalog.events().some((event) => event.type === "scheduled-status")).toBe(false);
      expectDelivery(catalog, pending.head);
      expect(ledger.readJson(...receipt)).toEqual(pending);
      expect(ledger.events()).toEqual([]);
      expect(pushes(ledger)).toEqual([]);
    },
  );
});
