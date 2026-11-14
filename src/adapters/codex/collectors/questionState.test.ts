// Offline exact question proof and bounded private-body exclusion fixtures.
import { describe, expect, it } from "vitest";

import { NativeTimeout, type RpcClient } from "../rpc.ts";
import { collectQuestionState, type QuestionStateOptions } from "./questionState.ts";

const P = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const PRIVATE = "PRIVATE_UNRELATED_BODY";
const NOW = 1793682000;

type Json = Record<string, unknown>;

interface Question {
  readonly options: unknown;
  readonly proof_complete?: boolean;
  readonly proof_refs: Json[];
  readonly proof_scope?: string;
  readonly question_index: number | null;
  readonly state: string;
  readonly title: unknown;
}

interface Outcome {
  readonly budget: { readonly calls_used: number; readonly exhausted: boolean };
  readonly cancelled_status: string;
  readonly complete: boolean;
  readonly diagnostics: string[];
  readonly latest_turn_proof: { readonly complete: boolean };
  readonly omitted_questions: number;
  readonly pending_status: string;
  readonly questions: Question[];
  readonly status: string;
  readonly ui_visibility: string;
}

/** datetime.fromtimestamp(seconds, timezone.utc).isoformat() for whole seconds. */
function iso(seconds: number, zulu = false): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", zulu ? "Z" : "+00:00");
}

function question(item = "question", turn = "current", questions?: unknown[]): Json {
  return {
    item: {
      id: item,
      questions: questions ?? [{ options: ["MIT", "Apache"], title: "Choose a licence" }],
      text: PRIVATE,
      type: "agentMessage",
    },
    turnId: turn,
  };
}

function reply(item = "reply", turn = "current"): Json {
  return { item: { content: [PRIVATE], id: item, type: "userMessage" }, turnId: turn };
}

function attestation(changes: Json = {}): Json {
  return {
    confirmed_at: iso(NOW - 60),
    confirmed_pending: true,
    options: ["MIT", "Apache"],
    question_index: 0,
    question_item_id: "question",
    question_turn_id: "current",
    title: "Choose a licence",
    ...changes,
  };
}

function record(changes: Json = {}, pending = true): Json {
  const value: Json = { resolutions: [], state: "pending", thread_id: P };
  if (pending) {
    value.pending_questions = [attestation()];
  }
  return { ...value, ...changes };
}

function resolution(changes: Json = {}): Json {
  return {
    answer_item_id: "reply",
    answer_turn_id: "current",
    question_item_id: "question",
    question_turn_id: "current",
    ...changes,
  };
}

class Native implements RpcClient {
  pages: Json[];
  calls: [string, Json][] = [];
  deadline = 200;
  failure: string | null = null;
  waiting = true;
  latest = "current";
  contextReads = 0;
  freshLatest: string | null = null;
  latestPages: Json[] | null = null;
  updatedAt: unknown = 1;

  constructor(entries?: unknown[]) {
    this.pages = [{ data: entries ?? [question()] }];
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const request = structuredClone(params) as Json;
    this.calls.push([method, request]);
    if (this.failure === method) {
      throw new Error(PRIVATE);
    }
    if (request.threadId !== P) {
      throw new Error("unscoped recipient");
    }
    if (method === "thread/items/list") {
      expect(request.sortDirection).toBe("desc");
      const index = Number(request.cursor ?? "0");
      const scoped = "turnId" in request;
      const pages = scoped && this.latestPages !== null ? this.latestPages : this.pages;
      const page = structuredClone(pages[index]) as Json;
      if (scoped && this.latestPages === null) {
        page.data = ((page.data ?? []) as Json[]).filter(
          (entry) => !("turnId" in entry) || entry.turnId === request.turnId,
        );
      }
      return page;
    }
    if (method === "thread/read") {
      expect(request.includeTurns).toBe(false);
      this.contextReads += 1;
      return {
        thread: {
          id: P,
          status: { activeFlags: this.waiting ? ["waitingOnUserInput"] : [], type: "active" },
          updatedAt: this.updatedAt,
        },
      };
    }
    if (method === "thread/turns/list") {
      const latest =
        this.contextReads > 1 && this.freshLatest !== null ? this.freshLatest : this.latest;
      return { data: [{ id: latest, status: "inProgress" }] };
    }
    throw new Error("native mutation or unsupported call");
  }

  close(): void {}
}

const CLOCK: QuestionStateOptions = { monotonic: () => 100, time: () => NOW };

async function collect(
  native = new Native(),
  owner: Json = record(),
  maxPages = 10,
  options: QuestionStateOptions = {},
): Promise<Outcome> {
  const output = await collectQuestionState(native, { [P]: owner }, [P], maxPages, {
    ...CLOCK,
    ...options,
  });
  const result = output[P] as unknown as Outcome;
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  expect(native.deadline).toBe(200);
  return result;
}

function first(result: Outcome): Question {
  const [row] = result.questions;
  if (row === undefined) {
    throw new Error("no question row");
  }
  return row;
}

describe("collectQuestionState", () => {
  it("proves pending from an exact fresh owner confirmation and current native proof", async () => {
    const native = new Native();
    const result = await collect(native);
    expect(result.status).toBe("complete");
    expect(result.complete).toBe(true);
    const q = first(result);
    expect(q.state).toBe("pending");
    expect(q.title).toBe("Choose a licence");
    expect(q.options).toEqual(["MIT", "Apache"]);
    expect(q.question_index).toBe(0);
    expect(q.proof_refs[0]?.recipient).toBe(P);
    expect(result.pending_status).toBe("owner_attested");
    expect(result.ui_visibility).toBe("unknown");
    expect(result.cancelled_status).toBe("unavailable");
    expect(native.calls).toHaveLength(6);
    expect(result.diagnostics).toContain("exact_unresolved_request_unavailable");
  });

  it("never proves pending from a generic pending state, wait flag or absent reply", async () => {
    const owners: (Json | null)[] = [record({}, false), record({ state: "clear" }), {}, null];
    for (const owner of owners) {
      const native = new Native();
      let result: Outcome;
      if (owner === null) {
        // Cases run in order, one fake each.
        // eslint-disable-next-line no-await-in-loop
        const output = await collectQuestionState(native, {}, [P], 10, { monotonic: () => 100 });
        result = output[P] as unknown as Outcome;
      } else {
        // Cases run in order, one fake each.
        // eslint-disable-next-line no-await-in-loop
        result = await collect(native, owner);
      }
      expect(first(result).state).toBe("unknown");
      expect(result.pending_status).toBe("unavailable");
      expect(native.calls.map(([method]) => method)).toEqual(["thread/items/list"]);
    }
  });

  it("treats stale, future, non-UTC and missing attestation times as unknown", async () => {
    const stamps = [
      iso(NOW - 1801),
      iso(NOW + 1),
      "2026-11-03T00:00:00",
      "2026-11-03T00:00:00-04:00",
      "",
      PRIVATE,
    ];
    for (const stamp of stamps) {
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      const result = await collect(
        undefined,
        record({ pending_questions: [attestation({ confirmed_at: stamp })] }),
      );
      expect(first(result).state).toBe("unknown");
      expect(result.diagnostics).toContain("owner_pending_attestation_stale_or_invalid");
    }
    for (const age of [0, 1800]) {
      const stamp = iso(NOW - age, true);
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      const result = await collect(
        undefined,
        record({ pending_questions: [attestation({ confirmed_at: stamp })] }),
      );
      expect(first(result).state).toBe("pending");
    }
  });

  it("rejects a wrong recipient, mismatched index, options or title and duplicates", async () => {
    const variants = [
      record({ thread_id: OTHER }),
      record({ pending_questions: "invalid" }),
      record({ pending_questions: [attestation({ question_index: true })] }),
      record({ pending_questions: [attestation({ question_index: 1 })] }),
      record({ pending_questions: [attestation({ title: "Other" })] }),
      record({ pending_questions: [attestation({ options: ["Apache", "MIT"] })] }),
      record({ pending_questions: [attestation({ question_item_id: "other" })] }),
      record({ pending_questions: [attestation(), attestation()] }),
    ];
    for (const owner of variants) {
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      expect(first(await collect(undefined, owner)).state).toBe("unknown");
    }
  });

  it("leaves a newer turn, changed turn, missing wait flag and later reply unknown", async () => {
    const newer = new Native();
    newer.latest = "newer";
    const changed = new Native();
    changed.freshLatest = "newer";
    const idle = new Native();
    idle.waiting = false;
    for (const native of [newer, changed, idle]) {
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      expect(first(await collect(native)).state).toBe("unknown");
    }
    const result = await collect(new Native([reply(), question()]));
    expect(first(result).state).toBe("unknown");
    expect(result.diagnostics).toContain("owner_pending_later_reply");
  });

  it("proves pending from complete paginated history without body capture", async () => {
    const native = new Native();
    native.pages = [{ data: [question()], nextCursor: "1" }, { data: [reply("reply", "older")] }];
    const result = await collect(native);
    expect(first(result).state).toBe("pending");
    expect(result.complete).toBe(true);
    expect(result.budget.calls_used).toBe(8);
  });

  it("never proves state from compacted, unknown, malformed or partial pages", async () => {
    const cases: Json[] = [
      {
        data: [
          question(),
          { item: { id: "compact", type: "contextCompaction" }, turnId: "current" },
        ],
      },
      { data: [question(), { item: { id: "unknown", type: "futureKind" }, turnId: "current" }] },
      { data: [question(), { item: {} }] },
      { data: [question()], truncated: true },
      { data: [question()], nextCursor: "1" },
    ];
    for (const page of cases) {
      for (const owner of [record(), record({ resolutions: [resolution()] })]) {
        const native = new Native();
        native.pages = [page];
        // Cases run in order, one fake each.
        // eslint-disable-next-line no-await-in-loop
        const result = await collect(native, owner, 1);
        expect(result.complete).toBe(false);
        expect(first(result).state).toBe("unknown");
      }
    }
  });

  it("requires an exact attestation, reply type and native order for answered", async () => {
    const owner = record({ resolutions: [resolution()], state: "clear" }, false);
    const result = await collect(new Native([reply(), question()]), owner);
    expect(first(result).state).toBe("answered");
    expect(first(result).proof_refs[0]?.answer_item_id).toBe("reply");
    const variants: [unknown[], Json][] = [
      [[question(), reply()], {}],
      [[reply(), question()], { answer_item_id: "missing" }],
      [[reply(), question()], { answer_turn_id: "other" }],
    ];
    for (const [entries, changed] of variants) {
      const native = new Native(entries);
      const resolved = record({ resolutions: [resolution(changed)], state: "clear" }, false);
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      expect(first(await collect(native, resolved)).state).toBe("unknown");
    }
    const prose = new Native([
      { item: { id: "reply", text: PRIVATE, type: "agentMessage" }, turnId: "current" },
      question(),
    ]);
    expect(first(await collect(prose, owner)).state).toBe("unknown");
  });

  it("binds cross-turn resolution order across pages to the recipient", async () => {
    const native = new Native();
    native.pages = [
      { data: [reply("reply", "later")], nextCursor: "1" },
      { data: [question("question", "older")] },
    ];
    const owner = record(
      {
        resolutions: [resolution({ answer_turn_id: "later", question_turn_id: "older" })],
        state: "clear",
      },
      false,
    );
    expect(first(await collect(native, owner)).state).toBe("answered");
    expect(first(await collect(native, { ...owner, thread_id: OTHER })).state).toBe("unknown");
  });

  it("lets a verified resolution conflict with pending and never answers from prose", async () => {
    const owner = record({ resolutions: [resolution()] });
    let result = await collect(new Native([reply(), question()]), owner);
    expect(first(result).state).toBe("answered");
    expect(result.diagnostics).toContain("owner_pending_resolution_conflict");
    result = await collect(new Native([reply(), question()]), record({ state: "clear" }, false));
    expect(first(result).state).toBe("unknown");
  });

  it("renders only titles and options and keeps sensitive tool payloads opaque", async () => {
    const native = new Native([
      question("question", "current", [
        { options: null, title: "Free text" },
        { title: "Bare title" },
      ]),
    ]);
    const owner = record({ state: "clear" }, false);
    const rendered = await collect(native, owner);
    expect(rendered.questions.map((q) => q.options)).toEqual([null, null]);
    const sensitive = { isSecret: true, options: [PRIVATE], title: PRIVATE };
    const items: Json[] = [
      question("question", "current", [sensitive]),
      {
        item: {
          arguments: { questions: [{ isSecret: true, question: PRIVATE }] },
          contentItems: [{ text: PRIVATE, type: "inputText" }],
          id: "tool",
          status: "completed",
          success: true,
          tool: "request_user_input",
          type: "dynamicToolCall",
        },
        turnId: "current",
      },
      {
        item: {
          id: "tool",
          name: "request_user_input",
          output: PRIVATE,
          type: "functionCallOutput",
        },
        turnId: "current",
      },
    ];
    for (const item of items) {
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      const row = first(await collect(new Native([item]), owner));
      expect(row.state).toBe("unknown");
      expect(row.title).toBeNull();
      expect(row.options).toBeNull();
    }
  });

  it("never proves lifecycle from cancellation, a request ID or tool acceptance", async () => {
    const owner = record({ cancelled: true, request_id: "unverified" }, false);
    const result = await collect(undefined, owner);
    expect(first(result).state).toBe("unknown");
    expect(result.cancelled_status).toBe("unavailable");
  });

  it("stays safe and read-only on failure, timeout, deadline and budget", async () => {
    let native = new Native();
    native.failure = "thread/items/list";
    let result = await collect(native, record({ state: "clear" }, false));
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics).toContain("native_history_unavailable");

    native = new Native();
    native.deadline = 99;
    const output = await collectQuestionState(native, {}, [P], 10, { monotonic: () => 100 });
    result = output[P] as unknown as Outcome;
    expect(native.calls).toEqual([]);
    expect(native.deadline).toBe(99);
    expect(result.diagnostics).toContain("native_deadline_exhausted");

    native = new Native();
    result = await collect(native, record(), 10, { maxCalls: 1 });
    expect(native.calls).toHaveLength(1);
    expect(result.budget.exhausted).toBe(true);
    expect(result.pending_status).not.toBe("owner_attested");

    native = new Native();
    native.call = async () => {
      throw new NativeTimeout(PRIVATE);
    };
    result = await collect(native, record({ state: "clear" }, false));
    expect(result.diagnostics).toContain("native_timeout");
  });

  it("fails closed on input bounds and malformed resolution records", async () => {
    const scopes = [[P, P], [P.toUpperCase().replace("00000000", "ABCDEFAB")], ["invalid"]];
    for (const recipients of scopes) {
      const native = new Native();
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      await expect(collectQuestionState(native, {}, recipients)).rejects.toThrow();
      expect(native.calls).toEqual([]);
    }
    for (const maxPages of [0, true as unknown as number, 101]) {
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      await expect(collectQuestionState(new Native(), {}, [P], maxPages)).rejects.toThrow();
    }
    for (const resolutions of [[resolution(), resolution()], [{}], "invalid"]) {
      // Cases run in order, one fake each.
      // eslint-disable-next-line no-await-in-loop
      const result = await collect(undefined, record({ resolutions }));
      expect(first(result).state).toBe("unknown");
    }
  });
});
