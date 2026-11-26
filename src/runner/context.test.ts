import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { makeGame, testContext } from "../testing/game.ts";

it("labels runner events with the coordinator game name", () => {
  const test = makeGame((config) => {
    config.reports!.project = "Old display name";
  });
  const context = testContext(test, { events: "log" });
  context.events.open();
  context.events.emit("attempt", "1", "attempt detail");

  const event = JSON.parse(readFileSync(context.paths.eventsLog, "utf8")) as { detail: string };
  expect(event.detail).toBe("Archie bus: attempt detail");
});

it("writes app identity in schema-1 rows through an app-mode context", () => {
  const test = makeGame();
  const context = testContext(
    { ...test, layout: { ...test.layout, mode: "app" } },
    { events: "log" },
  );
  context.events.emit("attempt", "1", "attempt detail");

  const line = readFileSync(context.paths.eventsLog, "utf8");
  expect(JSON.parse(line)).toMatchObject({ appId: test.game.id, schema: 1 });
  expect(line).not.toContain('"game"');
});
