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

import { errorMessage } from "../lib/values.ts";
import { setDesiredDelivery } from "../state/control.ts";
import { resolveGame } from "./game.ts";
import { deliveryOperator } from "./operator.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("control");

/**
 * The requested state, reason and requester role, or undefined when one is missing or invalid:
 * the state is `enabled` or `paused`, the reason is 1 to 4096 characters and not blank, and the
 * requester is not blank.
 */
export function controlInput(values: Readonly<Record<string, string | boolean | undefined>>):
  | {
      readonly reason: string;
      readonly requester: string;
      readonly state: "enabled" | "paused";
    }
  | undefined {
  const { reason, requester, state } = values;
  if (
    (state !== "enabled" && state !== "paused") ||
    typeof reason !== "string" ||
    reason.trim() === "" ||
    reason.length > 4096 ||
    typeof requester !== "string" ||
    requester.trim() === ""
  ) {
    return undefined;
  }
  return { reason, requester, state };
}

export const control: Handler = (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS.control.options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const input = controlInput(resolved.values);
  if (input === undefined) {
    io.err(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const { reason, requester, state } = input;
  try {
    const operator = deliveryOperator(resolved.layout, io.env, resolved.game.appId);
    if (operator !== undefined && requester !== operator) {
      throw new Error("--requester must match the active delivery operator");
    }
    const role = operator ?? resolveRole(readRegistry(resolved.layout), requester);
    mkdirSync(resolved.game.busDir, { recursive: true });
    const record = setDesiredDelivery(
      { dir: resolved.game.busDir },
      { reason, requester: role, state },
    );
    io.out(`${dumpsJson(record.desired)}\n`);
    return EXIT_OK;
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
};
