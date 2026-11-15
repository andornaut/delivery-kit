// Recipient decision guard: a recipient-bound clearance record, verified against native question
// history by exact turn and item IDs. Unknown or incomplete history defers.
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
const MAX_ITEM_PAGES = 64;
const MAX_PROOF_TURNS = 8;

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

function pyStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  return String(value);
}

/** A rendered prompt or a question tool call. */
export function questionItem(item: Record<string, unknown>): boolean {
  if (item.type === "agentMessage") {
    // Omitted questions default to null in the native schema.
    const questions = item.questions;
    return !(questions == null || (Array.isArray(questions) && questions.length === 0));
  }
  if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") {
    let tool = "";
    if ("tool" in item) {
      tool = pyStr(item.tool);
    } else if ("name" in item) {
      tool = pyStr(item.name);
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
async function nativeItems(
  client: RpcClient,
  recipient: string,
  turnId: string,
): Promise<Map<string, NativeItem>> {
  const items = new Map<string, NativeItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
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
  throw new Error("native item history page bound reached");
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

interface CompletedTurn {
  readonly id: string;
}

function completedTurn(page: unknown): { readonly turn: CompletedTurn; readonly next: unknown } {
  if (
    !isRecord(page) ||
    !Array.isArray(page.data) ||
    page.data.length !== 1 ||
    page.truncated ||
    page.hasMore
  ) {
    throw new Error("native turn history incomplete");
  }
  const turn: unknown = page.data[0];
  if (
    !isRecord(turn) ||
    typeof turn.id !== "string" ||
    turn.id === "" ||
    turn.status !== "completed" ||
    turn.error != null
  ) {
    throw new Error("native question proof requires a completed turn");
  }
  return { next: page.nextCursor ?? null, turn: { id: turn.id } };
}

/** Only a completed, single-item compaction turn may inherit its preceding question proof. */
async function precedingQuestionTurn(
  client: RpcClient,
  pages: Map<string, Map<string, NativeItem>>,
  recipient: string,
  latestId: string,
): Promise<string> {
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let index = 0; index < MAX_PROOF_TURNS; index += 1) {
    // Pages follow their native cursor; no turn is inferred from timestamps or IDs.
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.call("thread/turns/list", {
      ...(cursor === null ? {} : { cursor }),
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: recipient,
    });
    const { next, turn } = completedTurn(listed);
    if ((index === 0 && turn.id !== latestId) || seen.has(turn.id)) {
      throw new Error("native question proof head changed or turn repeated");
    }
    seen.add(turn.id);
    // eslint-disable-next-line no-await-in-loop
    const items = await itemsFor(client, pages, recipient, turn.id);
    if (items.size === 0) {
      throw new Error("native compaction predecessor is empty");
    }
    if (![...items.values()].some((item) => item.type === "contextCompaction")) {
      return turn.id;
    }
    if (items.size !== 1) {
      throw new Error("mixed native compaction turn cannot inherit question proof");
    }
    if (typeof next !== "string" || next === "" || cursors.has(next)) {
      throw new Error("native compaction predecessor unavailable");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("native compaction question proof bound reached");
}

async function sameCompletedHead(
  client: RpcClient,
  recipient: string,
  turnId: string,
): Promise<boolean> {
  const { turn } = completedTurn(
    await client.call("thread/turns/list", {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: recipient,
    }),
  );
  return turn.id === turnId;
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

/** Exact question proof, inherited only across completed compaction-only turns. */
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
    const compacted = [...latest.values()].some((item) => item.type === "contextCompaction");
    const proofId = compacted
      ? await precedingQuestionTurn(client, pages, recipient, turnId)
      : turnId;
    const proof = await itemsFor(client, pages, recipient, proofId);
    const resolved = await resolvedQuestions(client, pages, record, recipient, proofId);
    if (typeof resolved === "string") {
      return [false, resolved];
    }
    for (const item of proof.values()) {
      if (questionItem(item) && !resolved.has(item.id)) {
        return [
          false,
          `native question pending: question_turn_id=${proofId} question_item_id=${item.id}`,
        ];
      }
    }
    if (compacted && !(await sameCompletedHead(client, recipient, turnId))) {
      return [false, "native question proof head changed"];
    }
    return [true, null];
  } catch {
    return [false, "native question history incomplete or unknown"];
  }
}
