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
