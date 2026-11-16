// Pure original validation is shared by transport storage and immutable publications.
import { createHash } from "node:crypto";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { ID_PATTERN } from "../validate.ts";
import { MessageError } from "./errors.ts";
import type { MessageEnvelope, MessageInput } from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function role(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.split("/").length <= 2 &&
    value.split("/").every((part) => ID_PATTERN.test(part))
  );
}

function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new MessageError(code);
  }
}

export function messageEnvelope(input: MessageInput): MessageEnvelope {
  requireThat(
    isRecord(input) &&
      input.schema === 1 &&
      typeof input.id === "string" &&
      ID.test(input.id) &&
      role(input.fromRole) &&
      role(input.toRole) &&
      (input.intent === "queue" || input.intent === "unblock") &&
      typeof input.body === "string" &&
      typeof input.created === "string" &&
      input.created.endsWith("Z") &&
      Number.isFinite(Date.parse(input.created)),
    "invalid-envelope",
  );
  const { body, created, fromRole, id, intent, parentRole, schema, toRole, workerId } = input;
  let target: Pick<MessageInput, "parentRole" | "workerId"> = {};
  if (parentRole !== undefined || workerId !== undefined) {
    requireThat(
      isCanonicalUuid(workerId) && role(parentRole) && toRole === parentRole,
      "invalid-worker-target",
    );
    target = { parentRole, workerId };
  }
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify([
        schema,
        id,
        fromRole,
        toRole,
        intent,
        body,
        created,
        workerId ?? null,
        parentRole ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
  return { body, created, fromRole, id, intent, ...target, payloadHash, schema, toRole };
}
