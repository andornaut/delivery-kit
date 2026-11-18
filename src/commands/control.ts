// Persist desired delivery state. The requester names the trusted OS caller's registered role;
// it is an attribution supplied by that caller, not an authentication mechanism.
import { mkdirSync } from "node:fs";

import { readRegistry, resolveRole } from "@andornaut/coordination-kit/build/registry";
import {
  dumpsJson,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
} from "@andornaut/coordination-kit/build/shared";

import { resolveGame } from "../bus/command.ts";
import { setDesiredDelivery } from "../bus/control.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("control");

export const control: Handler = (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS.control.options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { reason, requester, state } = resolved.values;
  if (
    (state !== "enabled" && state !== "paused") ||
    typeof reason !== "string" ||
    reason.trim() === "" ||
    reason.length > 4096 ||
    typeof requester !== "string" ||
    requester.trim() === ""
  ) {
    io.err(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    const role = resolveRole(readRegistry(resolved.layout), requester);
    mkdirSync(resolved.game.busDir, { recursive: true });
    const record = setDesiredDelivery(
      { dir: resolved.game.busDir },
      { reason, requester: role, state },
    );
    io.out(`${dumpsJson(record.desired)}\n`);
    return EXIT_OK;
  } catch (error) {
    io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
};
