// Snapshot collectors over one native connection. History
// is read first; the question and worker collectors then share a 256-call budget and a
// deadline reserved five seconds before the connection's own. Every failure is a diagnostic,
// never clearance.
import { performance } from "node:perf_hooks";

import { decisionRecord } from "../shared/decisions.ts";
import { isRecord, unicodeDumps } from "../shared/pyjson.ts";
import type { Collected, CollectRequest } from "../types.ts";
import { workerHealth } from "./collectors/childHealth.ts";
import { collectQuestionState } from "./collectors/questionState.ts";
import { historyRefs } from "./inventory.ts";
import { NativeTimeout, type RpcClient } from "./rpc.ts";

type Json = Record<string, unknown>;

export const MAX_COLLECTION_CALLS = 256;
const RESERVE_MS = 5000;
const QUESTION_BOUND = 32768;

/** CollectionClient: one shared deadline and call budget across the collectors. */
export class BudgetClient implements RpcClient {
  private readonly client: RpcClient;
  /** Read by collectors that stop early. */
  readonly deadline: number;
  callsUsed = 0;
  reasonCode: string | null = null;

  constructor(client: RpcClient, deadline: number) {
    this.client = client;
    this.deadline = deadline;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (performance.now() >= this.deadline) {
      this.reasonCode = "collection_deadline_exhausted";
    }
    if (this.callsUsed >= MAX_COLLECTION_CALLS) {
      this.reasonCode = "collection_call_budget_exhausted";
    }
    if (this.reasonCode !== null) {
      throw new NativeTimeout("shared collection budget");
    }
    this.callsUsed += 1;
    try {
      return await this.client.call(method, params);
    } catch (error) {
      if (error instanceof NativeTimeout) {
        this.reasonCode = "collection_timeout";
      }
      throw error;
    }
  }

  close(): void {
    // The underlying connection belongs to the caller.
  }
}

function questionUnavailable(code: string): Json {
  return {
    cancelled_status: "unavailable",
    complete: false,
    diagnostics: [code],
    pending_status: "unavailable",
    questions: [],
    status: "unavailable",
    ui_visibility: "unknown",
  };
}

const COLLECTED: ReadonlySet<unknown> = new Set(["complete", "partial", "unavailable"]);
const QUESTION_FIELDS = ["turn_id", "item_id", "question_index", "kind", "title", "options"];

/** Keep exact snapshot choices; a question too large for a reminder is marked unknown. */
function boundQuestions(owner: string, value: Json): void {
  for (const question of value.questions as unknown[]) {
    if (!isRecord(question)) {
      continue;
    }
    // Key order: owner, level, then the fields.
    const content = Object.fromEntries([
      ["owner", owner],
      ["level", "escalation"],
      ...QUESTION_FIELDS.map((key) => [key, question[key] ?? null]),
    ]) as Json;
    if (Buffer.byteLength(unicodeDumps(content), "utf8") > QUESTION_BOUND) {
      question.state = "unknown";
      value.status = "partial";
      value.complete = false;
      const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
      diagnostics.push("question_text_exceeds_reminder_bounds");
      value.diagnostics = diagnostics;
    }
  }
}

async function questionState(
  client: RpcClient,
  unblockDir: string,
  members: ReadonlySet<string> | null,
  requested: readonly string[],
): Promise<Json> {
  const outside: Json = {};
  for (const recipient of requested) {
    if (members !== null && !members.has(recipient)) {
      outside[recipient] = questionUnavailable("question_recipient_outside_active_route");
    }
  }
  const recipients = requested.filter((recipient) => !Object.hasOwn(outside, recipient));
  if (recipients.length === 0) {
    return outside;
  }
  const decisions = Object.fromEntries(
    recipients.map((recipient) => [recipient, decisionRecord(unblockDir, recipient)]),
  );
  let collected: Json;
  try {
    collected = await collectQuestionState(client, decisions, recipients);
  } catch (error) {
    const code =
      error instanceof NativeTimeout
        ? "question_collection_budget_exhausted"
        : "question_collector_unavailable";
    collected = Object.fromEntries(
      recipients.map((recipient) => [recipient, questionUnavailable(code)]),
    );
  }
  const result: Json = {};
  for (const recipient of recipients) {
    const value = collected[recipient];
    const valid = isRecord(value) && COLLECTED.has(value.status) && Array.isArray(value.questions);
    const chosen = valid ? value : questionUnavailable("question_collector_unavailable");
    boundQuestions(recipient, chosen);
    result[recipient] = chosen;
  }
  return Object.fromEntries(
    requested.map((recipient) => [recipient, outside[recipient] ?? result[recipient]]),
  );
}

/** Collect every snapshot capability over `client`, whose own deadline is `deadline`. */
export async function collectAll(
  client: RpcClient,
  deadline: number,
  request: CollectRequest,
): Promise<Collected> {
  const recipients = [...new Set(request.recipients)];
  const history: Json = {};
  for (const recipient of recipients) {
    // History pages are read one recipient at a time on the one connection.
    // eslint-disable-next-line no-await-in-loop
    history[recipient] = await historyRefs(client, recipient, request.historyCursor);
  }
  const shared = new BudgetClient(client, deadline - RESERVE_MS);
  // An undeclared scope (undefined) is unrestricted; a declared invalid route (null) allows none.
  const members = request.routeMembers === undefined ? null : new Set(request.routeMembers ?? []);
  const questions = await questionState(shared, request.unblockDir, members, recipients);
  const workers = request.parents.length === 0 ? {} : await workerHealth(shared, request.parents);
  return {
    collection_budget: {
      calls_used: shared.callsUsed,
      max_calls: MAX_COLLECTION_CALLS,
      reason_code: shared.reasonCode,
    },
    history,
    question_state: questions,
    worker_health: workers,
  };
}

/** Every collector unavailable with one reason code, for a missing socket or connection. */
export function unavailableCollected(reasonCode: string, request: CollectRequest): Collected {
  const unavailable = { reason_code: reasonCode, status: "unavailable" };
  return {
    collection_budget: { calls_used: 0, max_calls: MAX_COLLECTION_CALLS, reason_code: reasonCode },
    history: Object.fromEntries(request.recipients.map((id) => [id, { ...unavailable }])),
    question_state: Object.fromEntries(
      request.recipients.map((id) => [id, questionUnavailable(reasonCode)]),
    ),
    worker_health: Object.fromEntries(request.parents.map((id) => [id, { ...unavailable }])),
  };
}
