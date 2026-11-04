// Bus events: durable enqueue with sha256(kind:key) dedupe and bounded delivery.
// Interface placeholder until the events port lands; signatures are the contract.
import type { GameLayout } from "./layout.ts";

export interface EmitOptions {
  readonly project: string;
}

export function emitEvent(
  game: GameLayout,
  options: EmitOptions,
  kind: string,
  key: string,
  message: string,
): void {
  void game;
  void options;
  void kind;
  void key;
  void message;
  throw new Error("events port pending");
}

export function flushEvents(game: GameLayout): Promise<void> {
  void game;
  return Promise.reject(new Error("events port pending"));
}
