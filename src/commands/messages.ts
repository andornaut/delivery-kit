// Parsing delegates ownership, admission and evidence checks to the durable message service.
import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { type MessageSendInput, MessageService } from "../messages/service.ts";
import { MessageError } from "../messages/store.ts";

export const MESSAGE_SEND_OPTIONS = {
  "body-file": { type: "string" },
  from: { type: "string" },
  id: { type: "string" },
  intent: { type: "string" },
  parent: { type: "string" },
  recipient: { type: "string" },
} as const;

export const MESSAGE_DISPATCH_OPTIONS = { id: { type: "string" } } as const;

export const MESSAGE_STATUS_OPTIONS = {
  id: { type: "string" },
  "include-body": { type: "boolean" },
  "include-retention": { type: "boolean" },
  recipient: { type: "string" },
} as const;

export const MESSAGE_RECONCILE_OPTIONS = {
  disposition: { type: "string" },
  evidence: { type: "string" },
  "expected-revision": { type: "string" },
  id: { type: "string" },
  "next-boundary": { type: "string" },
  "owner-role": { type: "string" },
  reason: { type: "string" },
  receipt: { type: "boolean" },
} as const;

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

function options(spec: Options, args: string[]): Values {
  const parsed = parseArgs({ args, options: spec, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      if (seen.has(token.name)) {
        throw new Error("repeated option");
      }
      seen.add(token.name);
    }
  }
  const values = parsed.values as Values;
  if (Object.values(values).some((value) => typeof value === "string" && value.trim() === "")) {
    throw new Error("empty option");
  }
  return values;
}

function required(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== "string") {
    throw new Error("missing option");
  }
  return value;
}

function usage(io: Io, command: string): number {
  io.err(`delivery-kit: invalid_message_options (${command})\n`);
  return EXIT_USAGE;
}

async function operate(
  io: Io,
  root: string,
  action: (service: MessageService) => unknown | Promise<unknown>,
): Promise<number> {
  try {
    const service = new MessageService({ env: io.env, layout: loadLayout(root) });
    const result = await action(service);
    io.out(`${JSON.stringify(result)}\n`);
    return EXIT_OK;
  } catch (error) {
    const code =
      error instanceof MessageError && /^[a-z][a-z-]{0,63}$/.test(error.code)
        ? error.code
        : "message_operation_failed";
    io.err(`delivery-kit: ${code}\n`);
    return EXIT_INVALID;
  }
}

export const messageSend: Handler = (io, root, args) => {
  let input: Omit<MessageSendInput, "body">;
  let file: string;
  try {
    const values = options(MESSAGE_SEND_OPTIONS, args);
    const intent = values.intent;
    if (intent !== undefined && intent !== "queue" && intent !== "unblock") {
      throw new Error("invalid intent");
    }
    file = required(values, "body-file");
    input = {
      fromRole: required(values, "from"),
      id: required(values, "id"),
      ...(intent === undefined ? {} : { intent }),
      ...(values.parent === undefined ? {} : { parent: required(values, "parent") }),
      recipient: required(values, "recipient"),
    };
  } catch {
    return usage(io, "message send");
  }
  return operate(io, root, async (service) => {
    const bytes = readFileSync(resolve(io.cwd, file));
    if (!isUtf8(bytes)) {
      throw new MessageError("invalid-body-encoding");
    }
    const body = bytes.toString("utf8");
    return service.view(await service.send({ ...input, body }));
  });
};

export const messageDispatch: Handler = (io, root, args) => {
  let id: string;
  try {
    id = required(options(MESSAGE_DISPATCH_OPTIONS, args), "id");
  } catch {
    return usage(io, "message dispatch");
  }
  return operate(io, root, async (service) => service.view(await service.dispatch(id)));
};

export const messageStatus: Handler = (io, root, args) => {
  let selection;
  try {
    const values = options(MESSAGE_STATUS_OPTIONS, args);
    if ((values.id === undefined) === (values.recipient === undefined)) {
      throw new Error("exclusive selection");
    }
    selection = {
      ...(values.id === undefined ? {} : { id: required(values, "id") }),
      includeBody: values["include-body"] === true,
      includeRetention: values["include-retention"] === true,
      ...(values.recipient === undefined ? {} : { recipient: required(values, "recipient") }),
    };
  } catch {
    return usage(io, "message status");
  }
  return operate(io, root, (service) => service.status(selection));
};

export const messageReconcile: Handler = (io, root, args) => {
  let id: string;
  let input: Parameters<MessageService["reconcile"]>[0] | undefined;
  try {
    const values = options(MESSAGE_RECONCILE_OPTIONS, args);
    id = required(values, "id");
    if (values.receipt === true) {
      if (Object.keys(values).some((key) => key !== "id" && key !== "receipt")) {
        throw new Error("exclusive receipt");
      }
    } else {
      const disposition = values.disposition;
      if (
        disposition !== "accepted" &&
        disposition !== "handled" &&
        disposition !== "superseded" &&
        disposition !== "retained"
      ) {
        throw new Error("invalid disposition");
      }
      const revision = required(values, "expected-revision");
      if (!/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
        throw new Error("invalid revision");
      }
      if (
        disposition !== "retained" &&
        ["reason", "owner-role", "next-boundary"].some((key) => values[key] !== undefined)
      ) {
        throw new Error("retention options require retained");
      }
      input = {
        disposition,
        evidence: required(values, "evidence"),
        expectedRevision: Number(revision),
        id,
        ...(disposition === "retained"
          ? {
              nextBoundary: required(values, "next-boundary"),
              ...(values["owner-role"] === undefined
                ? {}
                : { ownerRole: required(values, "owner-role") }),
              reason: required(values, "reason"),
            }
          : {}),
      };
    }
  } catch {
    return usage(io, "message reconcile");
  }
  return operate(io, root, async (service) =>
    service.view(
      input === undefined ? await service.reconcileReceipt(id) : await service.reconcile(input),
    ),
  );
};
