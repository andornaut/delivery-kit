// Doctor reports capabilities without sending, activating or changing registry state.
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { readRegistry } from "../registry/store.ts";
import { diagnoseHarness } from "../review/diagnostics.ts";

export const DOCTOR_OPTIONS = {
  game: { multiple: true, type: "string" },
  role: { multiple: true, type: "string" },
} as const;

const USAGE = "delivery-kit harness doctor [--game ID]... [--role ROLE]...";

export const harnessDoctor: Handler = async (io, root, args) => {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: DOCTOR_OPTIONS,
      strict: true,
    }));
    if (
      (values.game === undefined && values.role === undefined) ||
      [...(values.game ?? []), ...(values.role ?? [])].some((value) => value.trim() === "")
    ) {
      throw new Error("scope required");
    }
  } catch {
    io.err(`delivery-kit: invalid_doctor_scope\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    const layout = loadLayout(root);
    const report = await diagnoseHarness(io.env, layout, readRegistry(layout), {
      ...(values.game === undefined ? {} : { games: values.game }),
      ...(values.role === undefined ? {} : { roles: values.role }),
    });
    io.out(`${JSON.stringify(report)}\n`);
    return report.roles.some((row) => row.failed_layer !== null) ? EXIT_INVALID : EXIT_OK;
  } catch {
    io.err("delivery-kit: doctor_configuration_unavailable\n");
    return EXIT_INVALID;
  }
};
