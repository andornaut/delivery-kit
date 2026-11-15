// Guarded native input: turn/steer into a busy turn or turn/start on an idle thread, never an
// interrupt. The receipt is persisted as `sending` before the request, so an
// interrupted send becomes `ambiguous` and is never resent.
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { readJson, writeDurable } from "../../durable.ts";
import { decisionClear, decisionRecord } from "../shared/decisions.ts";
import { dumpsJson, isRecord, type PyJson, sameJson } from "../shared/pyjson.ts";
import {
  type DeliveryDiagnostic,
  type DeliveryReceipt,
  type DeliveryStatus,
  safeDeliveryDiagnostic,
} from "../types.ts";
import { clearanceUnchanged, nativeQuestionsClear } from "./guard.ts";
import { type RpcClient, RpcError } from "./rpc.ts";

const CLEARANCE_MISSING = "recipient-bound user-decision clearance missing, invalid or pending";
const PREVIOUS_SEND = "previous send outcome unknown or refused; do not resend";

export type TurnMethod = "turn/start" | "turn/steer";

export interface Target {
  readonly method: TurnMethod;
  readonly expectedTurnId?: string;
}

function latestTurn(turn: unknown): { readonly id: string; readonly status: unknown } | undefined {
  if (turn === undefined) {
    return undefined;
  }
  if (!isRecord(turn) || typeof turn.id !== "string") {
    throw new Error("native turn shape unknown");
  }
  return { id: turn.id, status: turn.status };
}

/** The input method the recipient accepts now, or the reason no input is permitted. */
export async function selectTarget(
  client: RpcClient,
  unblockDir: string,
  recipient: string,
): Promise<[Target | null, string | null, DeliveryDiagnostic?]> {
  const read = await client.call("thread/read", { includeTurns: false, threadId: recipient });
  const thread = isRecord(read) && isRecord(read.thread) ? read.thread : undefined;
  if (thread === undefined) {
    throw new Error("native thread shape unknown");
  }
  const status = isRecord(thread.status) ? thread.status : {};
  if (thread.canAcceptDirectInput !== true) {
    return [
      null,
      "recipient input availability unknown",
      { category: "input-unavailable", classification: "guarded", stage: "question-guard" },
    ];
  }
  const flags = status.activeFlags;
  if (status.type === "active" && !(Array.isArray(flags) && flags.length === 0)) {
    return [
      null,
      "recipient waiting on a question or approval",
      { category: "state-unavailable", classification: "guarded", stage: "question-guard" },
    ];
  }
  const listed = await client.call("thread/turns/list", {
    itemsView: "notLoaded",
    limit: 1,
    sortDirection: "desc",
    threadId: recipient,
  });
  if (!isRecord(listed) || !Array.isArray(listed.data)) {
    throw new Error("native turn listing shape unknown");
  }
  const latest = latestTurn(listed.data[0]);
  if (latest !== undefined) {
    const [clear, reason, diagnostic] = await nativeQuestionsClear(
      client,
      unblockDir,
      recipient,
      latest.id,
      { diagnostics: true },
    );
    if (!clear) {
      return diagnostic === undefined ? [null, reason] : [null, reason, diagnostic];
    }
    if (status.type === "active" && latest.status === "inProgress") {
      return [{ expectedTurnId: latest.id, method: "turn/steer" }, null];
    }
    if (status.type === "idle" && latest.status === "completed") {
      return [{ method: "turn/start" }, null];
    }
  }
  return [
    null,
    "recipient state ambiguous or interrupted; no automatic resume",
    { category: "state-unavailable", classification: "guarded", stage: "question-guard" },
  ];
}

// A type alias, not an interface, so it satisfies the receipt's JSON index signature.
type Attempt = {
  diagnostic?: DeliveryDiagnostic;
  method: TurnMethod;
  status: DeliveryStatus;
  expectedTurnId?: string;
  turnId?: string;
};

export interface ReceiptState {
  [key: string]: PyJson | undefined;
  recipient: string;
  clientUserMessageId: string;
  attempts: Attempt[];
  status?: DeliveryStatus;
  diagnostic?: DeliveryDiagnostic;
}

function persistReceipt(path: string, state: ReceiptState): void {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeDurable(path, `${dumpsJson(state as PyJson)}\n`);
}

function receipt(
  requestId: string,
  status: DeliveryStatus,
  reason?: string,
  diagnostic?: unknown,
): DeliveryReceipt {
  const safe = safeDeliveryDiagnostic(diagnostic);
  return {
    requestId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(safe === undefined ? {} : { diagnostic: safe }),
  };
}

function turnIdOf(response: unknown): string | null {
  if (!isRecord(response)) {
    return null;
  }
  if (typeof response.turnId === "string") {
    return response.turnId;
  }
  if (response.turnId == null && isRecord(response.turn) && typeof response.turn.id === "string") {
    return response.turn.id;
  }
  return null;
}

function receiptExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/** Load the existing receipt, or start one. A receipt bound to another request is refused. */
function loadReceipt(
  path: string,
  requestId: string,
  recipient: string,
  seed: Readonly<Record<string, PyJson>>,
): ReceiptState | null {
  const fresh: ReceiptState = { ...seed, attempts: [], clientUserMessageId: requestId, recipient };
  if (!receiptExists(path)) {
    return fresh;
  }
  const stored = readJson(path);
  if (
    !isRecord(stored) ||
    stored.recipient !== recipient ||
    stored.clientUserMessageId !== requestId ||
    !Array.isArray(stored.attempts) ||
    Object.entries(seed).some(([key, value]) => !sameJson(stored[key], value))
  ) {
    return null;
  }
  return stored as unknown as ReceiptState;
}

async function send(
  admission: { started: boolean },
  client: RpcClient,
  path: string,
  state: ReceiptState,
  params: Record<string, unknown>,
  target: Target,
): Promise<"accepted" | "ambiguous" | "rejected" | "stale"> {
  const record: Attempt = { method: target.method, status: "sending" };
  if (target.expectedTurnId !== undefined) {
    record.expectedTurnId = target.expectedTurnId;
  }
  state.attempts.push(record);
  state.status = "sending";
  delete state.diagnostic;
  persistReceipt(path, state);
  admission.started = true;
  let response: unknown;
  try {
    response = await client.call(target.method, params);
  } catch (error) {
    const status = error instanceof RpcError ? "rejected" : "ambiguous";
    record.status = status;
    const diagnostic: DeliveryDiagnostic =
      error instanceof RpcError
        ? { ...error.diagnostic, method: target.method, stage: "native-send" }
        : {
            category: "transport-unavailable",
            classification: "outcome-unknown",
            method: target.method,
            stage: "native-send",
          };
    record.diagnostic = diagnostic;
    Object.assign(state, { diagnostic });
    // The receipt state belongs to this one delivery; nothing else updates it concurrently.

    state.status = status;
    persistReceipt(path, state);
    return error instanceof RpcError && error.staleTurn && target.method === "turn/steer"
      ? "stale"
      : status;
  }
  const turnId = turnIdOf(response);
  const accepted =
    turnId !== null &&
    turnId !== "" &&
    (target.method !== "turn/steer" || turnId === target.expectedTurnId);
  record.status = accepted ? "accepted" : "ambiguous";
  if (!accepted) {
    const diagnostic: DeliveryDiagnostic = {
      category: "binding-mismatch",
      classification: "outcome-unknown",
      method: target.method,
      stage: "native-send",
    };
    record.diagnostic = diagnostic;
    Object.assign(state, { diagnostic });
  }
  // eslint-disable-next-line require-atomic-updates
  state.status = record.status;
  if (accepted) {
    record.turnId = turnId;
  }
  persistReceipt(path, state);
  return accepted ? "accepted" : "ambiguous";
}

/**
 * The local part of the guard, before any connection: a pending receipt whose recipient has no
 * clear decision record is deferred here, so a deferral opens no handshake-only connection.
 * Null when the native exchange must decide.
 */
export function deferLocally(
  unblockDir: string,
  path: string,
  seed: Readonly<Record<string, PyJson>>,
  requestId: string,
  recipient: string,
): DeliveryReceipt | null {
  let state: ReceiptState | null;
  try {
    state = loadReceipt(path, requestId, recipient, seed);
  } catch {
    return receipt(requestId, "ambiguous", "previous receipt unavailable; do not resend");
  }
  if (state === null || (state.status !== undefined && state.status !== "deferred")) {
    return null;
  }
  if (decisionClear(unblockDir, recipient)) {
    return null;
  }
  state.status = "deferred";
  state.diagnostic = { category: "decision-clearance", classification: "guarded", stage: "local" };
  persistReceipt(path, state);
  return receipt(requestId, "deferred", CLEARANCE_MISSING, state.diagnostic);
}

/**
 * Deliver `text` once under the receipt at `path`, keyed by `requestId` (the native
 * clientUserMessageId). An existing accepted receipt is reported as accepted; an existing
 * sending, ambiguous or rejected receipt is never resent. A stale-turn rejection of turn/steer
 * permits one refreshed attempt.
 */
async function deliverPreparedReceipt(
  admission: { started: boolean },
  client: RpcClient,
  unblockDir: string,
  path: string,
  seed: Readonly<Record<string, PyJson>>,
  requestId: string,
  recipient: string,
  text: string,
): Promise<DeliveryReceipt> {
  const existed = receiptExists(path);
  const state = loadReceipt(path, requestId, recipient, seed);
  if (state === null) {
    return receipt(requestId, "blocked", "receipt is bound to another request");
  }
  if (
    existed &&
    !["accepted", "sending", "ambiguous", "rejected", "deferred"].includes(state.status ?? "")
  ) {
    return receipt(requestId, "ambiguous", "unknown previous receipt state; do not resend");
  }
  admission.started = existed && (state.status === "sending" || state.status === "ambiguous");
  if (state.status === "accepted") {
    return receipt(requestId, "accepted");
  }
  if (state.status === "sending" || state.status === "ambiguous" || state.status === "rejected") {
    admission.started = true;
    // Native userMessage items expose no clientUserMessageId linkage, so nothing proves a
    // previous request was not accepted.
    if (state.status === "sending") {
      state.status = "ambiguous";
      persistReceipt(path, state);
    }
    return receipt(requestId, state.status, PREVIOUS_SEND, state.diagnostic);
  }
  for (let attempt = state.attempts.length; attempt < 2; attempt += 1) {
    const clearance = decisionRecord(unblockDir, recipient);
    if (!decisionClear(unblockDir, recipient)) {
      state.status = "deferred";
      state.diagnostic = {
        category: "decision-clearance",
        classification: "guarded",
        stage: "local",
      };
      persistReceipt(path, state);
      return receipt(requestId, "deferred", CLEARANCE_MISSING, state.diagnostic);
    }
    // The guard reads native history in order before each attempt.
    // eslint-disable-next-line no-await-in-loop
    const [target, reason, diagnostic] = await selectTarget(client, unblockDir, recipient);
    if (target === null || !clearanceUnchanged(unblockDir, recipient, clearance)) {
      state.status = "deferred";
      state.diagnostic =
        target === null
          ? (diagnostic ?? {
              category: "unknown",
              classification: "guarded",
              stage: "question-guard",
            })
          : { category: "decision-clearance", classification: "guarded", stage: "local" };
      persistReceipt(path, state);
      return receipt(requestId, "deferred", reason ?? CLEARANCE_MISSING, state.diagnostic);
    }
    const params: Record<string, unknown> = {
      clientUserMessageId: requestId,
      input: [{ text, type: "text" }],
      threadId: recipient,
    };
    if (target.expectedTurnId !== undefined) {
      params.expectedTurnId = target.expectedTurnId;
    }
    // eslint-disable-next-line no-await-in-loop
    const outcome = await send(admission, client, path, state, params, target);
    if (outcome === "stale" && attempt === 0) {
      continue;
    }
    if (outcome === "accepted") {
      return receipt(requestId, "accepted");
    }
    return receipt(
      requestId,
      outcome === "ambiguous" ? "ambiguous" : "rejected",
      outcome === "ambiguous" ? "response unavailable; do not resend" : "native request rejected",
      state.diagnostic,
    );
  }
  return receipt(requestId, "rejected", "bounded attempts exhausted");
}

/** Receipt preparation and read-only probes cannot admit native input. */
export async function deliverReceipt(
  client: RpcClient,
  unblockDir: string,
  path: string,
  seed: Readonly<Record<string, PyJson>>,
  requestId: string,
  recipient: string,
  text: string,
): Promise<DeliveryReceipt> {
  const admission = { started: true };
  try {
    return await deliverPreparedReceipt(
      admission,
      client,
      unblockDir,
      path,
      seed,
      requestId,
      recipient,
      text,
    );
  } catch (error) {
    return receipt(
      requestId,
      admission.started ? "ambiguous" : "unavailable",
      admission.started
        ? "receipt or response unavailable; do not resend"
        : "receipt preparation or native probe unavailable",
      error instanceof RpcError
        ? {
            ...error.diagnostic,
            classification: admission.started ? "outcome-unknown" : "unavailable",
          }
        : {
            category: "unknown",
            classification: admission.started ? "outcome-unknown" : "unavailable",
            stage: "receipt",
          },
    );
  }
}
