import { describe, expect, it } from "vitest";

import { unfinishedCiWatches } from "./ci.ts";

describe("unfinishedCiWatches", () => {
  it("returns the SHAs whose status reads pending or running, in name order", () => {
    const files: Record<string, string> = {
      "aaa.json": "running",
      "bbb.status": "running",
      "ccc.status": "success",
      "ddd.status": "pending",
      "eee.status": "timeout",
    };
    const read = (name: string): string | undefined => files[name];
    expect(
      unfinishedCiWatches(read, [
        "ddd.status",
        "fff.status",
        "bbb.status",
        "aaa.json",
        "ccc.status",
      ]),
    ).toEqual(["bbb", "ddd"]);
  });

  it("reads only status files and treats an unreadable one as finished", () => {
    const read: string[] = [];
    expect(
      unfinishedCiWatches(
        (name) => {
          read.push(name);
          return undefined;
        },
        ["a.log", "b.status", "c.lock"],
      ),
    ).toEqual([]);
    expect(read).toEqual(["b.status"]);
  });
});
