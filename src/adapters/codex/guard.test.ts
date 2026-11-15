import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nativeQuestionsClear } from "./guard.ts";
import type { RpcClient } from "./rpc.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000003";
const directories: string[] = [];
type Json = Record<string, unknown>;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function clearance(resolutions: Json[] = []): string {
  const directory = mkdtempSync(join(tmpdir(), "question-guard-"));
  directories.push(directory);
  mkdirSync(join(directory, "decisions"));
  writeFileSync(
    join(directory, "decisions", `${RECIPIENT}.json`),
    JSON.stringify({ resolutions, state: "clear", thread_id: RECIPIENT }),
  );
  return directory;
}

const question = {
  id: "question",
  questions: [{ title: "Choose", options: ["A", "B"] }],
  type: "agentMessage",
};
const answer = { id: "answer", type: "userMessage" };
const resolution = {
  answer_item_id: "answer",
  answer_turn_id: "previous",
  question_item_id: "question",
  question_turn_id: "previous",
};

class Native implements RpcClient {
  readonly calls: { method: string; params: Json }[] = [];
  turns: Json[] = [
    { id: "compact", status: "completed" },
    { id: "previous", status: "completed" },
  ];
  readonly items: Record<string, Json[]> = {
    compact: [{ id: "compaction", type: "contextCompaction" }],
    previous: [{ id: "done", questions: null, type: "agentMessage" }],
  };
  override?: (method: string, params: Json) => unknown;

  async call(method: string, value: unknown): Promise<unknown> {
    const params = value as Json;
    this.calls.push({ method, params });
    const overridden = this.override?.(method, params);
    if (overridden !== undefined) {
      return overridden;
    }
    if (method === "thread/turns/list") {
      const index = params.cursor === undefined ? 0 : Number(params.cursor);
      return {
        data: this.turns.slice(index, index + 1),
        nextCursor: index + 1 < this.turns.length ? String(index + 1) : null,
      };
    }
    if (method === "thread/items/list") {
      return {
        data: (this.items[String(params.turnId)] ?? []).map((item) => ({
          item,
          turnId: params.turnId,
        })),
        nextCursor: null,
      };
    }
    throw new Error(`unexpected method: ${method}`);
  }

  close(): void {}
}

const asyncQuestion = { ...question, delivery: "async" };

function uiReply(payload: Json = {}): Json {
  return {
    clientId: null,
    content: [
      {
        type: "text",
        text: `<send_user_message_question_reply>\n${JSON.stringify([
          {
            questionItemId: JSON.stringify(["request_user_input_async", "question", 0]),
            question: "Choose",
            answer: "A",
            ...payload,
          },
        ])}\n</send_user_message_question_reply>`,
        text_elements: [],
      },
    ],
    id: "ui-reply",
    type: "userMessage",
  };
}

function currentNative(items: Json[]): Native {
  const native = new Native();
  native.turns = [{ id: "current", status: "completed" }];
  native.items.current = items;
  return native;
}

describe("observed native UI reply admission", () => {
  it("accepts answer-first object fields while refusing additional response fields", async () => {
    const reply = uiReply();
    const content = (reply.content as Json[])[0]!;
    content.text = [
      "<send_user_message_question_reply>",
      JSON.stringify([
        {
          answer: "A",
          question: "Choose",
          questionItemId: JSON.stringify(["request_user_input_async", "question", 0]),
        },
      ]),
      "</send_user_message_question_reply>",
    ].join("\n");
    const directory = clearance();
    const path = join(directory, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(path);
    expect(
      await nativeQuestionsClear(
        currentNative([asyncQuestion, reply]),
        directory,
        RECIPIENT,
        "current",
      ),
    ).toEqual([true, null]);
    expect(readFileSync(path)).toEqual(before);
    expect(
      (
        await nativeQuestionsClear(
          currentNative([asyncQuestion, uiReply({ unknown: true })]),
          directory,
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  });

  it("derives the exact same-turn binding without writing the recipient's clear record", async () => {
    const native = currentNative([asyncQuestion, uiReply()]);
    const directory = clearance();
    const path = join(directory, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(path);
    expect(await nativeQuestionsClear(native, directory, RECIPIENT, "current")).toEqual([
      true,
      null,
    ]);
    expect(readFileSync(path)).toEqual(before);
    expect(native.calls.map(({ method }) => method)).toEqual([
      "thread/items/list",
      "thread/turns/list",
      "thread/items/list",
      "thread/turns/list",
    ]);
  });

  it("requires the complete current head while retaining the existing busy owner-resolution path", async () => {
    const native = currentNative([asyncQuestion, uiReply()]);
    native.turns[0] = { id: "current", status: "inProgress" };
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[0]).toBe(false);
    expect(
      await nativeQuestionsClear(
        native,
        clearance([
          {
            ...resolution,
            question_turn_id: "current",
            answer_turn_id: "current",
            answer_item_id: "ui-reply",
          },
        ]),
        RECIPIENT,
        "current",
      ),
    ).toEqual([true, null]);
  });

  it.each([
    "wrong-tool",
    "wrong-id",
    "wrong-index",
    "wrong-title",
    "blank-answer",
    "duplicate-keys",
  ])("does not derive a binding from %s", async (failure) => {
    let reply = uiReply();
    if (failure === "wrong-tool") {
      reply = uiReply({ questionItemId: JSON.stringify(["request_user_input", "question", 0]) });
    }
    if (failure === "wrong-id") {
      reply = uiReply({ questionItemId: JSON.stringify(["request_user_input_async", "other", 0]) });
    }
    if (failure === "wrong-index") {
      reply = uiReply({
        questionItemId: JSON.stringify(["request_user_input_async", "question", 1]),
      });
    }
    if (failure === "wrong-title") {
      reply = uiReply({ question: "Other question" });
    }
    if (failure === "blank-answer") {
      reply = uiReply({ answer: " \n" });
    }
    if (failure === "duplicate-keys") {
      const content = (reply.content as Json[])[0]!;
      content.text = String(content.text).replace('"answer":"A"', '"answer":"other","answer":"A"');
    }
    expect(
      (
        await nativeQuestionsClear(
          currentNative([asyncQuestion, reply]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
  });

  it("rejects partial wrappers and unknown reply metadata instead of searching for a substring", async () => {
    const wrapped = uiReply();
    const content = (wrapped.content as Json[])[0]!;
    content.text = `ordinary prefix${String(content.text)}`;
    expect(
      (
        await nativeQuestionsClear(
          currentNative([asyncQuestion, wrapped]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
    expect(
      (
        await nativeQuestionsClear(
          currentNative([asyncQuestion, { ...uiReply(), clientId: "external-request" }]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
  });

  it("rejects multiple rendered questions, multiple responses and duplicate replies", async () => {
    const multiple = {
      ...asyncQuestion,
      questions: [...question.questions, { title: "Unanswered" }],
    };
    expect(
      (
        await nativeQuestionsClear(
          currentNative([multiple, uiReply()]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
    const reply = uiReply();
    const content = (reply.content as Json[])[0]!;
    const text = String(content.text);
    const data = JSON.parse(
      text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n")),
    ) as unknown[];
    const multipleReplies = JSON.stringify([...data, ...data]);
    content.text = `<send_user_message_question_reply>\n${multipleReplies}\n</send_user_message_question_reply>`;
    expect(
      (
        await nativeQuestionsClear(
          currentNative([asyncQuestion, reply]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
    expect(
      (
        await nativeQuestionsClear(
          currentNative([asyncQuestion, uiReply(), { ...uiReply(), id: "duplicate" }]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
  });

  it("does not reorder a reply or clear a different newer question", async () => {
    expect(
      (
        await nativeQuestionsClear(
          currentNative([uiReply(), asyncQuestion]),
          clearance(),
          RECIPIENT,
          "current",
        )
      )[0],
    ).toBe(false);
    const native = currentNative([
      asyncQuestion,
      uiReply(),
      { ...asyncQuestion, id: "new-question" },
    ]);
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[1]).toContain(
      "question_item_id=new-question",
    );
    native.items.current = [
      asyncQuestion,
      uiReply(),
      { id: "unanswered-tool", type: "dynamicToolCall", tool: "request_user_input" },
    ];
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[1]).toContain(
      "question_item_id=unanswered-tool",
    );
  });

  it("does not derive cross-turn bindings from an earlier or later turn's reply", async () => {
    const native = currentNative([asyncQuestion]);
    native.turns.push({ id: "earlier", status: "completed" });
    native.items.earlier = [uiReply()];
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[0]).toBe(false);
    expect(native.calls.every(({ params }) => params.turnId === "current")).toBe(true);
  });

  it("reads all native item pages again and refuses changed proof after a valid answer", async () => {
    const native = currentNative([]);
    let starts = 0;
    native.override = (method, params) => {
      if (method !== "thread/items/list") {
        return undefined;
      }
      if (params.cursor === undefined) {
        starts++;
        return { data: [{ turnId: "current", item: asyncQuestion }], nextCursor: "reply-page" };
      }
      return {
        data: [
          {
            turnId: "current",
            item: starts === 1 ? uiReply() : { ...uiReply(), clientId: "changed" },
          },
        ],
        nextCursor: null,
      };
    };
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[1]).toBe(
      "native answer proof items changed",
    );
    expect(starts).toBe(2);
  });

  it("refuses a changed completed head after the full native item reread", async () => {
    const native = currentNative([asyncQuestion, uiReply()]);
    let heads = 0;
    native.override = (method) => {
      if (method === "thread/turns/list" && ++heads === 2) {
        return { data: [{ id: "new-head", status: "completed" }], nextCursor: null };
      }
      return undefined;
    };
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[1]).toBe(
      "native question proof head changed",
    );
  });

  it("preserves a newer independent recipient record during the derived-proof reread", async () => {
    const native = currentNative([asyncQuestion, uiReply()]);
    const directory = clearance();
    const path = join(directory, "decisions", `${RECIPIENT}.json`);
    const changed = JSON.stringify({ state: "pending", thread_id: RECIPIENT, resolutions: [] });
    let reads = 0;
    native.override = (method) => {
      if (method === "thread/items/list" && ++reads === 2) {
        writeFileSync(path, changed);
      }
      return undefined;
    };
    expect((await nativeQuestionsClear(native, directory, RECIPIENT, "current"))[1]).toBe(
      "recipient decision clearance changed",
    );
    expect(readFileSync(path, "utf8")).toBe(changed);
  });

  it("does not choose a valid answer over another ambiguous tagged input", async () => {
    const malformed = uiReply();
    malformed.id = "malformed-reply";
    (malformed.content as Json[])[0]!.text = "<send_user_message_question_reply>invalid";
    const native = currentNative([asyncQuestion, uiReply(), malformed]);
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[0]).toBe(false);
  });

  it("refuses a native item that claims a different recipient", async () => {
    const native = currentNative([]);
    native.override = (method) =>
      method === "thread/items/list"
        ? {
            data: [
              { threadId: "other", turnId: "current", item: asyncQuestion },
              { threadId: RECIPIENT, turnId: "current", item: uiReply() },
            ],
            nextCursor: null,
          }
        : undefined;
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "current"))[0]).toBe(false);
  });
});

describe("question proof after completed compaction", () => {
  it("requires the recipient's current clear record before any native history read", async () => {
    const native = new Native();
    const directory = clearance();
    const path = join(directory, "decisions", `${RECIPIENT}.json`);
    writeFileSync(
      path,
      JSON.stringify({ resolutions: [], state: "pending", thread_id: RECIPIENT }),
    );
    const before = readFileSync(path);
    expect(
      await nativeQuestionsClear(native, directory, RECIPIENT, "compact", { diagnostics: true }),
    ).toEqual([
      false,
      "recipient resolution record missing or invalid",
      { category: "decision-clearance", classification: "guarded", stage: "question-guard" },
    ]);
    expect(native.calls).toEqual([]);
    expect(readFileSync(path)).toEqual(before);
  });

  it("keeps an unbound native reply guarded and exposes only an opt-in diagnostic category", async () => {
    const native = new Native();
    native.items.compact = [
      question,
      { ...answer, content: [{ text: "PRIVATE_REPLY", type: "text" }] },
    ];
    const directory = clearance();
    const path = join(directory, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(path);
    const result = await nativeQuestionsClear(native, directory, RECIPIENT, "compact", {
      diagnostics: true,
    });
    expect(result).toEqual([
      false,
      "native question pending: question_turn_id=compact question_item_id=question",
      { category: "pending-question", classification: "guarded", stage: "question-guard" },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REPLY");
    expect(readFileSync(path)).toEqual(before);
    expect(await nativeQuestionsClear(native, directory, RECIPIENT, "compact")).toHaveLength(2);
  });

  it("refuses clearance if its recipient record changes during native proof reads", async () => {
    const native = new Native();
    const directory = clearance();
    const path = join(directory, "decisions", `${RECIPIENT}.json`);
    native.items.compact = [{ id: "done", type: "agentMessage", questions: null }];
    const changed = JSON.stringify({ resolutions: [], state: "pending", thread_id: RECIPIENT });
    native.override = (method) => {
      if (method === "thread/items/list") {
        writeFileSync(path, changed);
      }
      return undefined;
    };
    expect(
      await nativeQuestionsClear(native, directory, RECIPIENT, "compact", { diagnostics: true }),
    ).toEqual([
      false,
      "recipient decision clearance changed",
      { category: "decision-clearance", classification: "guarded", stage: "question-guard" },
    ]);
    expect(readFileSync(path, "utf8")).toBe(changed);
  });

  it("does not treat a deferred saved output as fully read native proof", async () => {
    const native = new Native();
    native.override = (method) =>
      method === "thread/items/list"
        ? {
            data: [
              {
                item: { id: "deferred", type: "agentMessage" },
                outputDeferred: true,
                turnId: "compact",
              },
            ],
            nextCursor: null,
          }
        : undefined;
    expect(
      await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact", { diagnostics: true }),
    ).toEqual([
      false,
      "native question history incomplete or unknown",
      { category: "history-unavailable", classification: "unavailable", stage: "question-guard" },
    ]);
    expect(native.calls.map(({ method }) => method)).toEqual(["thread/items/list"]);
  });

  it("uses the complete preceding turn and rechecks the current head", async () => {
    const native = new Native();
    expect(await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact")).toEqual([
      true,
      null,
    ]);
    expect(native.calls.map(({ method }) => method)).toEqual([
      "thread/items/list",
      "thread/turns/list",
      "thread/turns/list",
      "thread/items/list",
      "thread/turns/list",
    ]);
    expect(native.calls.at(-1)?.params.cursor).toBeUndefined();
  });

  it("preserves an unanswered prompt in the preceding completed turn", async () => {
    const native = new Native();
    native.items.previous = [question];
    expect(await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact")).toEqual([
      false,
      "native question pending: question_turn_id=previous question_item_id=question",
    ]);
  });

  it("accepts only the exact recorded answer after its question", async () => {
    const native = new Native();
    native.items.previous = [question, answer];
    expect(
      await nativeQuestionsClear(native, clearance([resolution]), RECIPIENT, "compact"),
    ).toEqual([true, null]);
    expect(
      await nativeQuestionsClear(
        native,
        clearance([{ ...resolution, answer_item_id: "absent" }]),
        RECIPIENT,
        "compact",
      ),
    ).toEqual([false, "recipient question resolution cannot be verified by exact native IDs"]);
    native.items.previous = [answer, question];
    expect(
      (await nativeQuestionsClear(native, clearance([resolution]), RECIPIENT, "compact"))[0],
    ).toBe(false);
  });

  it("walks consecutive completed compaction-only turns", async () => {
    const native = new Native();
    native.turns.splice(1, 0, { id: "second-compact", status: "completed" });
    native.items["second-compact"] = [{ id: "second", type: "contextCompaction" }];
    expect(await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact")).toEqual([
      true,
      null,
    ]);
  });

  it.each(["inProgress", "interrupted", "failed"])(
    "rejects a %s compaction turn",
    async (status) => {
      const native = new Native();
      native.turns[0] = { id: "compact", status };
      expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact"))[0]).toBe(
        false,
      );
    },
  );

  it("rejects mixed compaction, even with a recorded answer", async () => {
    const native = new Native();
    native.items.compact = [{ id: "compaction", type: "contextCompaction" }, question, answer];
    const currentResolution = {
      ...resolution,
      answer_turn_id: "compact",
      question_turn_id: "compact",
    };
    expect(
      (await nativeQuestionsClear(native, clearance([currentResolution]), RECIPIENT, "compact"))[0],
    ).toBe(false);
  });

  it("retains an active current question without looking past it", async () => {
    const native = new Native();
    native.items.compact = [question];
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact"))[0]).toBe(false);
    expect(native.calls.map(({ method }) => method)).toEqual(["thread/items/list"]);
  });

  it.each([
    "partial-items",
    "unknown-items",
    "missing-predecessor",
    "repeated-cursor",
    "head-change",
    "turn-error",
    "active-predecessor",
    "empty-predecessor",
  ])("fails closed on %s", async (failure) => {
    const native = new Native();
    if (failure === "empty-predecessor") {
      native.items.previous = [];
    }
    if (failure === "missing-predecessor") {
      native.turns.splice(1);
    }
    if (failure === "unknown-items") {
      native.items.previous = [{ id: "new", type: "unknownFutureItem" }];
    }
    if (failure === "turn-error") {
      native.turns[0] = { id: "compact", status: "completed", error: { message: "failure" } };
    }
    if (failure === "active-predecessor") {
      native.turns[1] = { id: "previous", status: "inProgress" };
    }
    let headReads = 0;
    native.override = (method, params) => {
      if (
        failure === "partial-items" &&
        method === "thread/items/list" &&
        params.turnId === "previous"
      ) {
        return { data: [], truncated: true };
      }
      if (failure === "repeated-cursor" && method === "thread/turns/list") {
        return { data: [{ id: "compact", status: "completed" }], nextCursor: "repeat" };
      }
      if (
        failure === "head-change" &&
        method === "thread/turns/list" &&
        params.cursor === undefined &&
        ++headReads === 2
      ) {
        return { data: [{ id: "new-question-turn", status: "completed" }] };
      }
      return undefined;
    };
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact"))[0]).toBe(false);
  });

  it("finds a question on a later native item page", async () => {
    const native = new Native();
    native.override = (method, params) => {
      if (method !== "thread/items/list" || params.turnId !== "previous") {
        return undefined;
      }
      return params.cursor === undefined
        ? {
            data: [{ item: { id: "first", type: "reasoning" }, turnId: "previous" }],
            nextCursor: "question-page",
          }
        : { data: [{ item: question, turnId: "previous" }], nextCursor: null };
    };
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact"))[1]).toContain(
      "question_item_id=question",
    );
  });

  it("bounds a compaction chain instead of granting empty-history clearance", async () => {
    const native = new Native();
    native.turns = Array.from({ length: 20 }, (_, index) => ({
      id: index === 0 ? "compact" : `compact-${index}`,
      status: "completed",
    }));
    for (const turn of native.turns) {
      native.items[String(turn.id)] = [
        { id: `item-${String(turn.id)}`, type: "contextCompaction" },
      ];
    }
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact"))[0]).toBe(false);
    expect(native.calls.filter(({ method }) => method === "thread/turns/list")).toHaveLength(8);
  });

  it("bounds unfinished item pagination before granting question clearance", async () => {
    const native = new Native();
    native.override = (method, params) => {
      if (method !== "thread/items/list" || params.turnId !== "previous") {
        return undefined;
      }
      const index = Number(params.cursor ?? 0);
      return {
        data: [{ item: { id: `item-${index}`, type: "reasoning" }, turnId: "previous" }],
        nextCursor: String(index + 1),
      };
    };
    expect((await nativeQuestionsClear(native, clearance(), RECIPIENT, "compact"))[0]).toBe(false);
    const reads = native.calls.filter(
      ({ method, params }) => method === "thread/items/list" && params.turnId === "previous",
    );
    expect(reads).toHaveLength(64);
  });
});
