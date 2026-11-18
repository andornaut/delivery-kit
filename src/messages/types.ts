import type { DeliveryDiagnostic } from "../adapters/types.ts";
import type { Layout } from "../layout.ts";
import type { Harness } from "../registry/schema.ts";

export type MessageIntent = "queue" | "unblock";

export type MessageState =
  | "queued"
  | "held"
  | "blocked"
  | "sending"
  | "accepted"
  | "ambiguous"
  | "parent-required"
  | "handled"
  | "superseded"
  | "retained";

export interface MessageInput {
  readonly schema: 1;
  readonly id: string;
  readonly fromRole: string;
  readonly toRole: string;
  readonly intent: MessageIntent;
  readonly body: string;
  readonly created: string;
  /** Explicit worker targets remain bound to this child and its registered parent role. */
  readonly workerId?: string;
  readonly parentRole?: string;
}

export interface MessageEnvelope extends MessageInput {
  readonly payloadHash: string;
}

export interface MessageOwner {
  readonly harness: Harness;
  readonly nativeId: string;
  readonly parentBinding: {
    readonly role: string;
    readonly nativeId: string;
  } | null;
}

export interface MessageAttemptSource {
  readonly owner: MessageOwner;
  readonly hop: "recipient" | "parent";
  readonly requestId: string;
}

export type MessageReason =
  | "owner-unavailable"
  | "guarded"
  | "transport-unavailable"
  | "transport-busy"
  | "transport-pending"
  | "worker-parent-required"
  | "refused"
  | "lost-response"
  | "interrupted"
  | "retained"
  | "explicit-hold";

export interface MessageAttempt {
  readonly diagnostic?: DeliveryDiagnostic;
  readonly source: MessageAttemptSource;
  readonly state: "sending" | "accepted" | "blocked" | "ambiguous" | "parent-required";
  readonly started: string;
  readonly completed: string | null;
  readonly reason: MessageReason | null;
}

/** One record holding an attempt request ID, as observed by a single store scan. */
export interface MessageAttemptIndexEntry {
  readonly id: string;
  readonly revision: number;
  readonly state: MessageState;
  /** True when the request ID is the record's latest attempt. */
  readonly latest: boolean;
}

export interface MessageRetention {
  readonly ownerRole: string;
  readonly reason: string;
  readonly nextBoundary: string;
}

/** Exact immutable message and last attempted source observed by the caller. */
export interface MessageExpectation {
  readonly envelope: MessageEnvelope;
  readonly revision: number;
  readonly source: MessageAttemptSource | null;
}

export interface MessageEvidence {
  readonly kind: "accepted" | "not-delivered" | "handled" | "superseded" | "retained";
  readonly ref: string;
  readonly source: MessageAttemptSource | null;
  readonly retention: MessageRetention | null;
}

export interface MessageRecord {
  readonly diagnostic?: DeliveryDiagnostic;
  readonly schema: 1;
  readonly revision: number;
  readonly envelope: MessageEnvelope;
  readonly state: MessageState;
  readonly attempts: readonly MessageAttempt[];
  readonly evidence: readonly MessageEvidence[];
  readonly retention: MessageRetention | null;
  readonly reason: MessageReason | null;
}

/** Public diagnostics contain no payload, payload digest, evidence text or native binding. */
export interface MessageStatus {
  readonly protocol?: {
    readonly handlingAttestation: "attested" | "unattested";
    readonly disposition: "handled" | "superseded" | "retained" | null;
  };
  readonly diagnostic?: DeliveryDiagnostic;
  readonly id: string;
  readonly revision: number;
  readonly workerId?: string;
  readonly parentRole?: string;
  readonly fromRole: string;
  readonly toRole: string;
  readonly intent: MessageIntent;
  readonly created: string;
  readonly state: MessageState;
  readonly attempts: number;
  readonly outbox: readonly {
    readonly diagnostic?: DeliveryDiagnostic;
    readonly requestId: string;
    readonly hop: MessageAttemptSource["hop"];
    readonly state: MessageAttempt["state"];
  }[];
  readonly reason: MessageReason | null;
  readonly ownerRole: string | null;
  readonly nextBoundary: string | null;
}

export type MessageSummary =
  | {
      readonly schema: 1;
      readonly status: "available";
      readonly counts: Readonly<Record<MessageState, number>>;
      readonly messages: readonly MessageStatus[];
    }
  | {
      readonly schema: 1;
      readonly status: "unavailable";
      readonly reason: "unreadable-inbox";
      readonly counts: null;
      readonly messages: null;
    };

export interface MessageContext {
  readonly layout: Pick<Layout, "reviewDir"> & Partial<Layout>;
  /** Must read current ownership on each call; unavailable ownership returns null. */
  readonly resolveOwner: (
    role: string,
    envelope: MessageEnvelope,
  ) => MessageOwner | null | Promise<MessageOwner | null>;
  readonly now?: () => string;
}

export interface MessageCompletion {
  readonly diagnostic?: DeliveryDiagnostic;
  readonly source: MessageAttemptSource;
  readonly state: Exclude<MessageAttempt["state"], "sending">;
  readonly reason: MessageReason | null;
}

/** Holds the message's OS lock until completion or close. It performs no external action. */
export interface MessageAttemptLease {
  readonly source: MessageAttemptSource;
  readonly envelope: MessageEnvelope;
  complete(receipt: MessageCompletion): MessageRecord;
  /** A lost response or abandoned attempt is ambiguous, never eligible for blind retry. */
  close(): void;
}
