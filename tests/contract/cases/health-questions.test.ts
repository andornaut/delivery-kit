// Question state through `inbox snapshot`. No route is
// declared, so the recipient is in scope; native history comes from the fake control socket and
// owner attestations from STATE/unblock/decisions/<recipient>.json.
import { expect } from "vitest";

import { contract, suite, workspaces } from "../lib/cases.ts";
import {
  clone,
  decision,
  iso,
  OTHER,
  P,
  Q_PRIVATE,
  question,
  QuestionNative,
  questionCalls,
  reply,
  snapshot,
  sockets,
} from "../lib/health-native.ts";
import type { Workspace } from "../lib/workspace.ts";

type Json = Record<string, unknown>;
type Question = Json & { state: string; title: unknown; options: unknown };
type State = Json & {
  questions: Question[];
  diagnostics: string[];
  budget: Json;
  latest_turn_proof: Json;
};

const now = () => Date.now() / 1000;

function attestation(changes: Json = {}): Json {
  return {
    question_turn_id: "current",
    question_item_id: "question",
    question_index: 0,
    title: "Choose a licence",
    options: ["MIT", "Apache"],
    confirmed_pending: true,
    confirmed_at: iso(now() - 60),
    ...changes,
  };
}

function record({
  state = "pending",
  pending = true,
  ...changes
}: Json & { state?: string; pending?: boolean } = {}): Json {
  const value: Json = { thread_id: P, state, resolutions: [] };
  if (pending) value.pending_questions = [attestation()];
  return { ...value, ...changes };
}

function resolution(changes: Json = {}): Json {
  return {
    question_turn_id: "current",
    question_item_id: "question",
    answer_turn_id: "current",
    answer_item_id: "reply",
    ...changes,
  };
}

suite("question state", () => {
  const workspace = workspaces();
  const socketFor = sockets();

  /** Collect for P with the owner record (null writes none); asserts no private body leaks. */
  async function collect(native = new QuestionNative(), owner: Json | null = record()) {
    const ws: Workspace = workspace();
    const socket = await socketFor(ws);
    native.install(socket);
    if (owner !== null) decision(ws, P, owner);
    const shot = await snapshot(ws, P);
    expect(shot.result.code, shot.result.stderr).toBe(0);
    expect(shot.text).not.toContain(Q_PRIVATE);
    const state = (shot.record.question_state as Record<string, State>)[P]!;
    return { state, calls: questionCalls(socket), socket };
  }

  contract("exact fresh owner confirmation and current native proof is pending", async () => {
    const { state, calls } = await collect();
    expect(state.status).toBe("complete");
    expect(state.complete).toBe(true);
    const q = state.questions[0]!;
    expect(q.state).toBe("pending");
    expect(q.title).toBe("Choose a licence");
    expect(q.options).toEqual(["MIT", "Apache"]);
    expect(q.question_index).toBe(0);
    expect((q.proof_refs as Json[])[0]!.recipient).toBe(P);
    expect(state.pending_status).toBe("owner_attested");
    expect(state.ui_visibility).toBe("unknown");
    expect(state.cancelled_status).toBe("unavailable");
    expect(calls).toHaveLength(6);
    expect(state.budget.calls_used).toBe(6);
    expect(state.diagnostics).toContain("exact_unresolved_request_unavailable");
  });

  contract("generic pending, wait flag and absent reply never prove pending", async () => {
    for (const owner of [record({ pending: false }), record({ state: "clear" }), {}, null]) {
      const { state, calls } = await collect(new QuestionNative(), owner);
      expect(state.questions[0]!.state).toBe("unknown");
      expect(state.pending_status).toBe("unavailable");
      expect(calls.map((c) => c.method)).toEqual(["thread/items/list"]);
    }
  });

  contract(
    "wrong recipient, mismatched index, options, title and duplicate attestation stay unknown",
    async () => {
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
        const { state } = await collect(new QuestionNative(), owner);
        expect(state.questions[0]!.state, JSON.stringify(owner)).toBe("unknown");
      }
    },
  );

  contract("newer turn, changed turn, missing wait flag and later reply stay unknown", async () => {
    for (const change of [
      (n: QuestionNative) => (n.latest = "newer"),
      (n: QuestionNative) => (n.freshLatest = "newer"),
      (n: QuestionNative) => (n.waiting = false),
    ]) {
      const native = new QuestionNative();
      change(native);
      expect((await collect(native)).state.questions[0]!.state).toBe("unknown");
    }
    const { state } = await collect(new QuestionNative([reply(), question()]));
    expect(state.questions[0]!.state).toBe("unknown");
    expect(state.diagnostics).toContain("owner_pending_later_reply");
  });

  contract("visible newer turn and partial exact answer proof remain unknown", async () => {
    let { state } = await collect(
      new QuestionNative([question("new-question", "newer"), question()]),
    );
    expect(state.questions.every((q) => q.state === "unknown")).toBe(true);
    expect(state.diagnostics).toContain("owner_pending_newer_turn_ambiguity");
    const native = new QuestionNative([reply(), question()]);
    native.pages[0]!.truncated = true;
    ({ state } = await collect(
      native,
      record({ state: "clear", pending: false, resolutions: [resolution()] }),
    ));
    expect(state.questions[0]!.state).toBe("unknown");
  });

  contract(
    "compaction, unknown, malformed and partial pages never establish pending or answered",
    async () => {
      // The CLI collector reads up to ten pages; a dangling cursor fails the next page read.
      const pages = [
        {
          data: [
            question(),
            { turnId: "current", item: { id: "compact", type: "contextCompaction" } },
          ],
        },
        { data: [question(), { turnId: "current", item: { id: "unknown", type: "futureKind" } }] },
        { data: [question(), { item: {} }] },
        { data: [question()], truncated: true },
        { data: [question()], nextCursor: "1" },
      ];
      for (const page of pages) {
        for (const owner of [record(), record({ resolutions: [resolution()] })]) {
          const native = new QuestionNative();
          native.pages = [clone(page)];
          const { state } = await collect(native, owner);
          expect(state.complete).toBe(false);
          expect(state.questions[0]!.state).toBe("unknown");
        }
      }
    },
  );

  contract("answered requires exact attestation, reply type and native order", async () => {
    const owner = record({ state: "clear", pending: false, resolutions: [resolution()] });
    let { state } = await collect(new QuestionNative([reply(), question()]), owner);
    expect(state.questions[0]!.state).toBe("answered");
    expect((state.questions[0]!.proof_refs as Json[])[0]!.answer_item_id).toBe("reply");
    for (const [entries, changed] of [
      [[question(), reply()], {}],
      [[reply(), question()], { answer_item_id: "missing" }],
      [[reply(), question()], { answer_turn_id: "other" }],
    ] as Array<[Json[], Json]>) {
      ({ state } = await collect(
        new QuestionNative(entries),
        record({ state: "clear", pending: false, resolutions: [resolution(changed)] }),
      ));
      expect(state.questions[0]!.state).toBe("unknown");
    }
    const agent = {
      turnId: "current",
      item: { id: "reply", type: "agentMessage", text: Q_PRIVATE },
    };
    ({ state } = await collect(new QuestionNative([agent, question()]), owner));
    expect(state.questions[0]!.state).toBe("unknown");
  });

  contract("cross-turn resolution pagination proves order and recipient binding", async () => {
    const make = () => {
      const native = new QuestionNative();
      native.pages = [
        { data: [reply("reply", "later")], nextCursor: "1" },
        { data: [question("question", "older")] },
      ];
      return native;
    };
    const owner = record({
      state: "clear",
      pending: false,
      resolutions: [resolution({ question_turn_id: "older", answer_turn_id: "later" })],
    });
    expect((await collect(make(), owner)).state.questions[0]!.state).toBe("answered");
    expect((await collect(make(), { ...owner, thread_id: OTHER })).state.questions[0]!.state).toBe(
      "unknown",
    );
  });

  contract("verified resolution conflicts with pending and user prose never answers", async () => {
    let { state } = await collect(
      new QuestionNative([reply(), question()]),
      record({ resolutions: [resolution()] }),
    );
    expect(state.questions[0]!.state).toBe("answered");
    expect(state.diagnostics).toContain("owner_pending_resolution_conflict");
    ({ state } = await collect(
      new QuestionNative([reply(), question()]),
      record({ state: "clear", pending: false }),
    ));
    expect(state.questions[0]!.state).toBe("unknown");
  });

  contract(
    "only rendered titles and options are kept; sensitive tool payloads stay opaque",
    async () => {
      const owner = record({ state: "clear", pending: false });
      let { state } = await collect(
        new QuestionNative([
          question("question", "current", [
            { title: "Free text", options: null },
            { title: "Bare title" },
          ]),
        ]),
        owner,
      );
      expect(state.questions.map((q) => q.options)).toEqual([null, null]);
      const sensitive = { title: Q_PRIVATE, options: [Q_PRIVATE], isSecret: true };
      for (const item of [
        question("question", "current", [sensitive]),
        {
          turnId: "current",
          item: {
            id: "tool",
            type: "dynamicToolCall",
            tool: "request_user_input",
            status: "completed",
            arguments: { questions: [{ isSecret: true, question: Q_PRIVATE }] },
            contentItems: [{ type: "inputText", text: Q_PRIVATE }],
            success: true,
          },
        },
        {
          turnId: "current",
          item: {
            id: "tool",
            type: "functionCallOutput",
            name: "request_user_input",
            output: Q_PRIVATE,
          },
        },
      ]) {
        ({ state } = await collect(new QuestionNative([item]), owner));
        expect(state.questions[0]!.state).toBe("unknown");
        expect(state.questions[0]!.title).toBeNull();
        expect(state.questions[0]!.options).toBeNull();
      }
    },
  );

  contract("cancellation, request ID or tool acceptance never prove lifecycle", async () => {
    const { state } = await collect(
      new QuestionNative(),
      record({ pending: false, cancelled: true, request_id: "unverified" }),
    );
    expect(state.questions[0]!.state).toBe("unknown");
    expect(state.cancelled_status).toBe("unavailable");
  });

  contract("unknown capability and timeout are safe and read only", async () => {
    let native = new QuestionNative();
    native.failure = "thread/items/list";
    const { state } = await collect(native, record({ state: "clear", pending: false }));
    expect(state.status).toBe("unavailable");
    expect(state.diagnostics).toContain("native_history_unavailable");
    // The snapshot's own history read is call 1; the collector's first read never answers.
    native = new QuestionNative();
    native.hangItemsCall = 2;
    const result = await collect(native, record({ state: "clear", pending: false }));
    expect(result.state.diagnostics).toContain("native_timeout");
    expect(result.calls.map((c) => c.method)).toEqual(["thread/items/list"]);
  });

  contract("old compaction or partial history does not taint complete current proof", async () => {
    for (const history of [
      {
        data: [
          question(),
          { turnId: "older", item: { id: "old-compact", type: "contextCompaction" } },
        ],
      },
      { data: [question()], nextCursor: "1" },
    ]) {
      const native = new QuestionNative();
      native.pages = [history];
      native.latestPages = [{ data: [question()] }];
      const { state } = await collect(native);
      expect(state.complete).toBe(false);
      expect(state.status).toBe("partial");
      expect(state.latest_turn_proof.complete).toBe(true);
      expect(state.questions[0]!.state).toBe("pending");
      expect(state.questions[0]!.proof_complete).toBe(true);
      expect(state.questions[0]!.proof_scope).toBe("latest_turn");
    }
    for (const current of [
      {
        data: [
          question(),
          { turnId: "current", item: { id: "compact", type: "contextCompaction" } },
        ],
      },
      { data: [question()], truncated: true },
      { data: [question()], nextCursor: "1" },
    ]) {
      const native = new QuestionNative();
      native.latestPages = [current];
      const { state } = await collect(native);
      expect(state.latest_turn_proof.complete).toBe(false);
      expect(state.questions[0]!.state).toBe("unknown");
    }
  });
});
