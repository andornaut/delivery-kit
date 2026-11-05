// The scheduled slot receipt `<unblock>/<coordinator>-<slot>.json` and its bounded send loop.
// The receipt is durable as `sending` before each native request, so an interrupted send
// becomes `ambiguous` and is never resent; only an explicit stale-turn rejection of turn/steer
// permits one refreshed attempt with the same request ID.
import { existsSync } from "node:fs";

import { readJson, writeDurable } from "../../durable.ts";
import { decisionRecord } from "../shared/decisions.ts";
import { dumpsJson, isRecord, type PyJson } from "../shared/pyjson.ts";
import { clearanceUnchanged } from "./guard.ts";
import { type RpcClient, RpcError } from "./rpc.ts";
import { selectTarget } from "./steer.ts";

export const CLEARANCE_MISSING =
  "recipient-bound user-decision clearance missing, invalid or pending";
const INTERRUPTED = "previous send interrupted; do not resend";

export type SlotState = Record<string, unknown>;

/** Runner state observed around each send attempt. */
export interface SlotHooks {
  /** True once the runner is stopping: an unresolved send then keeps its sending receipt. */
  readonly stopping?: () => boolean;
}

/**
 * The runner stopped while a send was unresolved. Nothing more is recorded, so the receipt stays
 * `sending`, as a runner killed mid-send leaves it.
 */
export class SlotInterrupted extends Error {
  constructor() {
    super("runner stopped during a native send");
    this.name = "SlotInterrupted";
  }
}

/** json.dumps(state, sort_keys=True) plus a newline, written durably. */
export function persistSlot(path: string, state: SlotState): void {
  writeDurable(path, `${dumpsJson(state as PyJson)}\n`);
}

/** The existing receipt, with an interrupted `sending` marked ambiguous; undefined when absent. */
export function previousSlot(path: string): SlotState | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const previous = readJson(path);
  if (!isRecord(previous)) {
    throw new Error("slot receipt shape unknown");
  }
  if (previous.status === "sending") {
    previous.status = "ambiguous";
    previous.reason = INTERRUPTED;
    persistSlot(path, previous);
  }
  return previous;
}

/** The accepted turn ID, as `response.get("turnId") or response.get("turn", {}).get("id")`. */
function acceptedTurn(response: unknown): unknown {
  if (!isRecord(response)) {
    throw new Error("native acceptance shape unknown");
  }
  const direct = response.turnId;
  if (
    direct !== undefined &&
    direct !== null &&
    direct !== "" &&
    direct !== 0 &&
    direct !== false
  ) {
    return direct;
  }
  const turn = Object.hasOwn(response, "turn") ? response.turn : {};
  if (!isRecord(turn)) {
    throw new Error("native acceptance shape unknown");
  }
  return turn.id;
}

export interface SlotSend {
  readonly path: string;
  readonly recipient: string;
  readonly text: string;
  /** Whether the recipient's own proven pending question explains a deferral. */
  readonly ownWait: boolean;
}

/**
 * Send the reminder under `state` (already carrying `requestId`), persisting every transition.
 * Mutates and returns `state`.
 */
export async function sendSlot(
  client: RpcClient,
  unblockDir: string,
  hooks: SlotHooks,
  send: SlotSend,
  state: SlotState,
): Promise<SlotState> {
  const { ownWait, path, recipient, text } = send;
  const requestId = String(state.requestId);
  const finish = (updates: SlotState): SlotState => {
    Object.assign(state, updates);
    persistSlot(path, state);
    return state;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clearance = decisionRecord(unblockDir, recipient);
    // The guard reads native state in order before each attempt.
    // eslint-disable-next-line no-await-in-loop
    const [selected, reason] = await selectTarget(client, unblockDir, recipient);
    if (selected === null) {
      return finish({ reason, status: "deferred", waiting_on_user: ownWait });
    }
    if (!clearanceUnchanged(unblockDir, recipient, clearance)) {
      return finish({ reason: CLEARANCE_MISSING, status: "deferred" });
    }
    const params: Record<string, unknown> = {
      clientUserMessageId: requestId,
      input: [{ text, type: "text" }],
      threadId: recipient,
    };
    if (selected.method === "turn/steer") {
      params.expectedTurnId = selected.expectedTurnId;
    }
    finish({ attempt: attempt + 1, method: selected.method, status: "sending" });
    let response: unknown;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await client.call(selected.method, params);
    } catch (error) {
      if (hooks.stopping?.() === true) {
        throw new SlotInterrupted();
      }
      if (error instanceof RpcError) {
        finish({ errorCode: error.code ?? null, status: "rejected" });
        if (selected.method === "turn/steer" && error.staleTurn && attempt === 0) {
          continue;
        }
        return state;
      }
      return finish({ reason: "response unavailable; do not resend", status: "ambiguous" });
    }
    const turnId = acceptedTurn(response);
    if (
      typeof turnId !== "string" ||
      turnId === "" ||
      (selected.method === "turn/steer" && turnId !== params.expectedTurnId)
    ) {
      return finish({
        reason: "unexpected acceptance response; do not resend",
        status: "ambiguous",
      });
    }
    return finish({ status: "accepted", turnId });
  }
  throw new Error("bounded attempt exhausted");
}
