// Immutable reference offers survive journal contention. Journal events alone prove admission.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { fsyncDirectory, writeDurable } from "../durable.ts";
import type { LedgerCommand, LedgerCoverage, LedgerEvent, LedgerSource } from "./types.ts";

export interface IntakeInput {
  readonly actor: string;
  readonly source: LedgerSource;
  readonly command: Extract<LedgerCommand, { type: "capture" }>;
}

export interface IntakeOffer extends IntakeInput {
  readonly schema: 1;
  readonly id: string;
}

export interface PendingIntake {
  readonly status: "available" | "unavailable";
  readonly offers:
    | readonly {
        readonly id: string;
        readonly commandId: string;
        readonly requiredOwner: string;
      }[]
    | null;
  readonly reason: IntakeErrorCode | "ledger-unavailable" | null;
}

export type IntakeErrorCode =
  | "invalid-intake"
  | "invalid-intake-directory"
  | "intake-unavailable"
  | "corrupt-intake"
  | "intake-hash-conflict";

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;

  constructor(code: IntakeErrorCode) {
    super(code);
    this.code = code;
  }
}

const ROLE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  );
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

function nullable(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return value === null || predicate(value);
}

function list(value: unknown, predicate: (value: unknown) => boolean): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    Object.keys(value).length === value.length &&
    Array.from(value).every(predicate)
  );
}

function empty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function native(value: unknown): boolean {
  return (
    object(value, ["harness", "threadId", "turnId", "itemId", "index"]) &&
    [null, "codex", "claude"].includes(value.harness as string | null) &&
    nullable(value.threadId, token) &&
    nullable(value.turnId, token) &&
    nullable(value.itemId, token) &&
    nullable(value.index, (n) => Number.isSafeInteger(n) && Number(n) >= 0)
  );
}

function source(value: unknown): value is LedgerSource {
  return (
    object(value, ["origin", "reference", "native", "wordingHash"]) &&
    typeof value.origin === "string" &&
    ["native-user", "owner-attested", "relay", "unknown"].includes(value.origin) &&
    nullable(value.reference, token) &&
    nullable(value.native, native) &&
    nullable(value.wordingHash, (hash) => typeof hash === "string" && HASH.test(hash))
  );
}

function request(value: unknown): boolean {
  return (
    object(value, [
      "id",
      "summary",
      "kind",
      "reviewed",
      "source",
      "assignment",
      "parentId",
      "dependencies",
      "targets",
      "question",
    ]) &&
    typeof value.id === "string" &&
    ID.test(value.id) &&
    typeof value.summary === "string" &&
    [
      "Observed source awaiting owner review",
      "Observed question reference awaiting owner review",
    ].includes(value.summary) &&
    value.kind === "unknown" &&
    value.reviewed === false &&
    source(value.source) &&
    value.assignment === null &&
    value.parentId === null &&
    empty(value.dependencies) &&
    empty(value.targets) &&
    (value.question === null ||
      (object(value.question, ["native", "text", "options", "status", "resolutionRef"]) &&
        nullable(value.question.native, native) &&
        value.question.text === null &&
        value.question.options === null &&
        value.question.status === "unknown" &&
        value.question.resolutionRef === null))
  );
}

function range(value: unknown): value is LedgerCoverage["range"] {
  return (
    object(value, ["from", "through"]) &&
    nullable(value.from, token) &&
    nullable(value.through, token)
  );
}

function coverage(actor: string, value: unknown): boolean {
  return (
    object(value, ["id", "ownerRole", "source", "range", "state", "gaps", "nextBoundary"]) &&
    typeof value.id === "string" &&
    ID.test(value.id) &&
    value.ownerRole === actor &&
    source(value.source) &&
    range(value.range) &&
    typeof value.state === "string" &&
    ["covered", "partial", "unavailable"].includes(value.state) &&
    list(
      value.gaps,
      (gap) =>
        object(gap, ["from", "through", "reason"]) &&
        nullable(gap.from, token) &&
        nullable(gap.through, token) &&
        token(gap.reason),
    ) &&
    nullable(value.nextBoundary, token) &&
    (value.state !== "covered" ||
      (value.gaps.length === 0 &&
        token(value.range.from) &&
        token(value.range.through) &&
        value.source.origin !== "unknown" &&
        value.source.reference !== null))
  );
}

function input(value: unknown): value is IntakeInput {
  if (
    !object(value, ["actor", "source", "command"]) ||
    typeof value.actor !== "string" ||
    !ROLE.test(value.actor) ||
    !source(value.source) ||
    !object(value.command, ["type", "requests", "coverage"]) ||
    value.command.type !== "capture"
  ) {
    return false;
  }
  const { actor, command } = value;
  return (
    list(command.requests, request) &&
    list(command.coverage, (entry) => coverage(actor, entry)) &&
    command.requests.length + command.coverage.length > 0 &&
    new Set(command.requests.map((r) => (r as { id: string }).id)).size ===
      command.requests.length &&
    new Set(command.coverage.map((c) => (c as { id: string }).id)).size === command.coverage.length
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: IntakeInput): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function directoryExists(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(directory) !== resolve(directory)
    ) {
      throw new IntakeError("invalid-intake-directory");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function ensureDirectory(directory: string): void {
  const parent = dirname(directory);
  if (directoryExists(directory)) {
    // An identical offer may observe an entry another publisher has just created.
    fsyncDirectory(parent);
    return;
  }
  ensureDirectory(parent);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !directoryExists(directory)) {
      throw error;
    }
  }
  fsyncDirectory(parent);
}

function safeError(error: unknown): IntakeError {
  return error instanceof IntakeError ? error : new IntakeError("intake-unavailable");
}

export class IntakeStore {
  readonly #directory: string;

  constructor(options: { readonly directory: string }) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.directory !== "string" ||
      !isAbsolute(options.directory) ||
      options.directory.includes("\0")
    ) {
      throw new IntakeError("invalid-intake-directory");
    }
    this.#directory = resolve(options.directory);
  }

  #read(id: string): IntakeOffer {
    const path = join(this.#directory, `${id}.json`);
    if (!lstatSync(path).isFile()) {
      throw new IntakeError("corrupt-intake");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!fstatSync(fd).isFile()) {
        throw new IntakeError("corrupt-intake");
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    let value: unknown;
    try {
      if (!isUtf8(bytes)) {
        throw new IntakeError("corrupt-intake");
      }
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new IntakeError("corrupt-intake");
    }
    if (!object(value, ["schema", "id", "actor", "source", "command"]) || value.schema !== 1) {
      throw new IntakeError("corrupt-intake");
    }
    const payload = { actor: value.actor, command: value.command, source: value.source };
    if (!input(payload)) {
      throw new IntakeError("corrupt-intake");
    }
    if (value.id !== id || digest(payload) !== id) {
      throw new IntakeError("intake-hash-conflict");
    }
    if (bytes.toString("utf8") !== `${canonical(value)}\n`) {
      throw new IntakeError("corrupt-intake");
    }
    return value as unknown as IntakeOffer;
  }

  offer(value: IntakeInput): IntakeOffer {
    if (!input(value)) {
      throw new IntakeError("invalid-intake");
    }
    const payload = structuredClone(value);
    const id = digest(payload);
    const offer: IntakeOffer = { ...payload, id, schema: 1 };
    try {
      ensureDirectory(this.#directory);
      const path = join(this.#directory, `${id}.json`);
      try {
        const existing = this.#read(id);
        if (!isDeepStrictEqual(existing, offer)) {
          throw new IntakeError("intake-hash-conflict");
        }
        fsyncDirectory(this.#directory);
        return existing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      // Concurrent offers with the same address publish identical canonical bytes.
      writeDurable(path, `${canonical(offer)}\n`);
      return this.#read(id);
    } catch (error) {
      throw safeError(error);
    }
  }

  pending(events: readonly LedgerEvent[], ownerRoles?: readonly string[]): readonly IntakeOffer[] {
    if (
      !Array.isArray(events) ||
      (ownerRoles !== undefined &&
        !list(ownerRoles, (role) => typeof role === "string" && ROLE.test(role)))
    ) {
      throw new IntakeError("invalid-intake");
    }
    try {
      if (!directoryExists(this.#directory)) {
        return [];
      }
      const offers: IntakeOffer[] = [];
      for (const name of readdirSync(this.#directory).sort()) {
        if (/^\.[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{12}\.tmp$/u.test(name)) {
          continue;
        }
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
          throw new IntakeError("corrupt-intake");
        }
        const offer = this.#read(name.slice(0, -5));
        if (ownerRoles !== undefined && !ownerRoles.includes(offer.actor)) {
          continue;
        }
        const matching = events.filter((event) => event?.commandId === `intake-${offer.id}`);
        if (
          matching.length === 0 ||
          matching.some(
            (event) =>
              event.actor !== offer.actor ||
              !isDeepStrictEqual(event.source, offer.source) ||
              !isDeepStrictEqual(event.command, offer.command),
          )
        ) {
          offers.push(offer);
        }
      }
      return offers;
    } catch (error) {
      throw safeError(error);
    }
  }
}
