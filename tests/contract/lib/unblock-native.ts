// Scripted Codex native state for monitor and event delivery cases: per-thread status, latest
// turn, item history, queue pages, child inventories and ordered steer/start outcomes.
import type { CodexSocket, Reply, RpcCall } from "./codex-socket.ts";

export const TECH = "00000000-0000-0000-0000-000000000001";
export const ART = "00000000-0000-0000-0000-000000000002";
export const GAMEPLAY = "00000000-0000-0000-0000-000000000003";
export const CHILD = "00000000-0000-0000-0000-000000000004";

export type Params = Record<string, unknown>;
export type Page = unknown;

export interface ThreadModel {
  status: Record<string, unknown>;
  turn: { id: string; status: string; [key: string]: unknown } | null;
  /** Extra thread/read fields (id, updatedAt, parentThreadId, source). */
  read: Record<string, unknown>;
  canAcceptDirectInput: boolean;
  /** thread/queue/list pages, indexed by cursor (undefined cursor is page 0). */
  queue: (params: Params) => Page;
  /** thread/items/list pages. */
  items: (params: Params) => Page;
}

/** A two-page queue holding a private payload. */
function twoPageQueue(params: Params): Page {
  if (params.cursor) {
    return {
      data: [{ id: "queue-two", clientUserMessageId: "user-two", input: ["private user content"] }],
    };
  }
  return {
    data: [{ id: "queue-one", clientUserMessageId: "user-one", input: ["private user content"] }],
    nextCursor: "next",
  };
}

export const emptyQueue = (): Page => ({ data: [] });

export class NativeWorld {
  readonly threads = new Map<string, ThreadModel>();
  /** Ordered turn/steer and turn/start replies; when empty, the latest turn is accepted. */
  readonly outcomes: unknown[] = [];
  /** thread/list inventories keyed by `${parent}:${archived}`. */
  readonly children = new Map<string, unknown[]>();
  /** Called before each reply, for state changes in the middle of a native read. */
  hook: ((call: RpcCall) => void) | undefined;
  socket: CodexSocket | undefined;

  thread(id: string): ThreadModel {
    let model = this.threads.get(id);
    if (!model) {
      const created: ThreadModel = {
        status: { type: "active", activeFlags: [] },
        turn: { id: "turn-one", status: "inProgress" },
        read: {},
        canAcceptDirectInput: true,
        queue: twoPageQueue,
        items: () => ({
          data: created.turn
            ? [
                {
                  turnId: created.turn.id,
                  item: { id: "message", type: "agentMessage", questions: null },
                },
              ]
            : [],
        }),
      };
      model = created;
      this.threads.set(id, model);
    }
    return model;
  }

  install(socket: CodexSocket): this {
    this.socket = socket;
    const threadOf = (params: Params) => this.thread(String(params.threadId));
    const wrap =
      (handler: (params: Params, call: RpcCall) => unknown) => (params: Params, call: RpcCall) => {
        this.hook?.(call);
        return handler(params, call);
      };
    socket.on(
      "thread/queue/list",
      wrap((params) => threadOf(params).queue(params)),
    );
    socket.on(
      "thread/items/list",
      wrap((params) => threadOf(params).items(params)),
    );
    socket.on(
      "thread/read",
      wrap((params) => {
        const model = threadOf(params);
        return {
          thread: {
            status: model.status,
            canAcceptDirectInput: model.canAcceptDirectInput,
            ...model.read,
          },
        };
      }),
    );
    socket.on(
      "thread/turns/list",
      wrap((params) => {
        const turn = threadOf(params).turn;
        return { data: turn ? [turn] : [] };
      }),
    );
    socket.on(
      "thread/list",
      wrap((params) => ({
        data: this.children.get(`${params.parentThreadId}:${params.archived}`) ?? [],
        nextCursor: null,
      })),
    );
    const mutate = (method: string) =>
      wrap((params) => {
        if (this.outcomes.length) return this.outcomes.shift();
        if (method === "turn/steer") return { result: { turnId: params.expectedTurnId } };
        return { result: { turn: { id: "new-turn" } } };
      });
    socket.on("turn/steer", mutate("turn/steer"));
    socket.on("turn/start", mutate("turn/start"));
    return this;
  }

  mutations(): RpcCall[] {
    return (this.socket?.calls ?? []).filter((call) => call.method.startsWith("turn/"));
  }

  /** The text of the latest steer or start. */
  lastText(): string {
    const call = this.mutations().at(-1);
    const input = call?.params.input as Array<{ text: string }> | undefined;
    return input?.[0]?.text ?? "";
  }
}

export function rpcError(message: string, code = -32600): Reply {
  return { error: { code, message } };
}

export const STALE = rpcError("expectedTurnId does not match active turn");
