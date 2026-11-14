import { describe, expect, it } from "vitest";

import { loadLayout } from "../layout.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { makeFixture, registryInput } from "../testFixtures.ts";
import { harnessDoctor } from "./doctor.ts";
import { synopsis } from "./spec.ts";

async function run(root: string, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await harnessDoctor(
    {
      cwd: root,
      env: { CODEX_CONTROL_SOCKET: "DO_NOT_PRINT" },
      err: (s) => {
        err += s;
      },
      out: (s) => {
        out += s;
      },
    },
    root,
    args,
  );
  return { code, err, out };
}

describe("harness doctor handler", () => {
  it("requires nonempty explicit scope and does not echo invalid arguments", async () => {
    const forms = synopsis("harness doctor").map((form) => `delivery-kit ${form}`);
    const usage = forms.join("\n");
    for (const args of [[], ["--role", " "], ["--unknown", "DO_NOT_PRINT"], ["--role"]]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run("/not/read", ...args);
      expect(result).toMatchObject({ code: 2, out: "" });
      expect(result.err).not.toContain("DO_NOT_PRINT");
      expect(result.err).toBe(`delivery-kit: invalid_doctor_scope\n${usage}\n`);
    }
  });

  it("emits one schema 1 JSON line and exits nonzero for an observed failure", async () => {
    const { root } = makeFixture();
    const layout = loadLayout(root);
    const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
    createRegistry(layout, { ...input, harness: "codex" });
    const result = await run(root, "--role", "archies-dog-walks/tech");
    expect(result).toMatchObject({ code: 1, err: "" });
    expect(result.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.out)).toMatchObject({
      schema: 1,
      roles: [{ failed_layer: "adapter" }],
    });
    expect(result.out).not.toContain("DO_NOT_PRINT");
    const invalid = await run(root, "--role", "DO_NOT_PRINT");
    expect(invalid).toEqual({
      code: 1,
      out: "",
      err: "delivery-kit: doctor_configuration_unavailable\n",
    });
  });
});
