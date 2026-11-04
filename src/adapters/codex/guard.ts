// Recipient decision guard: a recipient-bound clearance record, verified against native question
// history by exact turn and item IDs (unblock.py:117-221). Unknown or incomplete history defers.
import { decisionClear, type DecisionRecord, decisionRecord } from "../shared/decisions.ts";
import { isRecord, sameJson } from "../shared/pyjson.ts";
import type { RpcClient } from "./rpc.ts";

export const NATIVE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
  "fileChange",
  "functionCallOutput",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "plan",
  "reasoning",
  "sleep",
  "subAgentActivity",
  "userMessage",
  "webSearch",
]);

const QUESTION_TOOLS = ["requestuserinput", "askuserquestion", "elicitation"];

export type NativeItem = Record<string, unknown> & { readonly id: string; readonly type: string };

interface Resolution {
  readonly question_turn_id: string;
  readonly question_item_id: string;
  readonly answer_turn_id: string;
  readonly answer_item_id: string;
}

/** True while the clearance read before a send still matches the current record. */
export function clearanceUnchanged(
  unblockDir: string,
  recipient: string,
  clearance: DecisionRecord | null,
): boolean {
  return (
    decisionClear(unblockDir, recipient) &&
    sameJson(decisionRecord(unblockDir, recipient), clearance)
  );
}

function pythonStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  return String(value);
}

/** A rendered prompt or a question tool call, as unblock.py:144-151 classifies items. */
export function questionItem(item: Record<string, unknown>): boolean {
  if (item.type === "agentMessage") {
    // Omitted questions default to null in the native schema.
    const questions = item.questions;
    return !(questions == null || (Array.isArray(questions) && questions.length === 0));
  }
  if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") {
    let tool = "";
    if ("tool" in item) {
      tool = pythonStr(item.tool);
    } else if ("name" in item) {
      tool = pythonStr(item.name);
    }
    const normalized = tool.toLowerCase().replaceAll("_", "");
    return QUESTION_TOOLS.some((name) => normalized.includes(name));
  }
  return false;
}

function itemPage(page: unknown, turnId: string, items: Map<string, NativeItem>): unknown {
  if (!isRecord(page) || !Array.isArray(page.data) || page.truncated || page.hasMore) {
    throw new Error("native item history incomplete");
  }
  for (const entry of page.data as unknown[]) {
    if (!isRecord(entry) || entry.turnId !== turnId) {
      throw new Error("native turn identity mismatch");
    }
    const item = entry.item;
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.type !== "string" ||
      !NATIVE_ITEM_TYPES.has(item.type)
    ) {
      throw new Error("unknown native item");
    }
    if (item.type === "mcpToolCall" && item.status !== "completed") {
      throw new Error("native tool incomplete");
    }
    if (items.has(item.id)) {
      throw new Error("duplicate native item");
    }
    items.set(item.id, item as NativeItem);
  }
  return page.nextCursor ?? null;
}

/** Every item of one turn in native order, failing on any incomplete or unknown page. */
export async function nativeItems(
  client: RpcClient,
  recipient: string,
  turnId: string,
): Promise<Map<string, NativeItem>> {
  const items = new Map<string, NativeItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const params: Record<string, unknown> = {
      limit: 100,
      sortDirection: "asc",
      threadId: recipient,
      turnId,
    };
    if (cursor !== null) {
      params.cursor = cursor;
    }
    // Pages follow their cursor in order.
    // eslint-disable-next-line no-await-in-loop
    const next = itemPage(await client.call("thread/items/list", params), turnId, items);
    if (next === null) {
      return items;
    }
    if (typeof next !== "string" || next === "" || cursors.has(next)) {
      throw new Error("native pagination incomplete");
    }
    cursors.add(next);
    cursor = next;
  }
}

async function itemsFor(
  client: RpcClient,
  pages: Map<string, Map<string, NativeItem>>,
  recipient: string,
  turnId: string,
): Promise<Map<string, NativeItem>> {
  const known = pages.get(turnId);
  if (known !== undefined) {
    return known;
  }
  const items = await nativeItems(client, recipient, turnId);
  pages.set(turnId, items);
  return items;
}

async function resolvedQuestions(
  client: RpcClient,
  pages: Map<string, Map<string, NativeItem>>,
  record: DecisionRecord,
  recipient: string,
  turnId: string,
): Promise<Set<string> | string> {
  const resolved = new Set<string>();
  for (const resolution of (record.resolutions ?? []) as Resolution[]) {
    if (resolution.question_turn_id !== turnId) {
      continue;
    }
    // Each resolution reads at most two turns, in order, through the shared page cache.
    // eslint-disable-next-line no-await-in-loop
    const questionPage = await itemsFor(client, pages, recipient, resolution.question_turn_id);
    // eslint-disable-next-line no-await-in-loop
    const answerPage = await itemsFor(client, pages, recipient, resolution.answer_turn_id);
    const question = questionPage.get(resolution.question_item_id);
    const answer = answerPage.get(resolution.answer_item_id);
    if (
      question === undefined ||
      !questionItem(question) ||
      answer === undefined ||
      answer.type !== "userMessage"
    ) {
      return "recipient question resolution cannot be verified by exact native IDs";
    }
    if (resolution.question_turn_id === resolution.answer_turn_id) {
      const order = [...questionPage.keys()];
      if (order.indexOf(answer.id) <= order.indexOf(question.id)) {
        return "recipient answer item must follow its question in the same native turn";
      }
    }
    resolved.add(question.id);
  }
  return resolved;
}

/** [clear, reason]: every question in the latest turn has a verified recorded answer. */
export async function nativeQuestionsClear(
  client: RpcClient,
  unblockDir: string,
  recipient: string,
  turnId: string,
): Promise<[boolean, string | null]> {
  try {
    const record = decisionRecord(unblockDir, recipient);
    if (record === null) {
      return [false, "recipient resolution record missing or invalid"];
    }
    const pages = new Map<string, Map<string, NativeItem>>();
    const latest = await itemsFor(client, pages, recipient, turnId);
    if ([...latest.values()].some((item) => item.type === "contextCompaction")) {
      return [false, "native latest-turn context compaction prevents complete question proof"];
    }
    const resolved = await resolvedQuestions(client, pages, record, recipient, turnId);
    if (typeof resolved === "string") {
      return [false, resolved];
    }
    for (const item of latest.values()) {
      if (questionItem(item) && !resolved.has(item.id)) {
        return [
          false,
          `native question pending: question_turn_id=${turnId} question_item_id=${item.id}`,
        ];
      }
    }
    return [true, null];
  } catch {
    return [false, "native question history incomplete or unknown"];
  }
}
