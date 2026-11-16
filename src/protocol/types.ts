/** Canonical bytes use a lowercase SHA-256 digest without a prefix. */
export interface ArtifactRef {
  readonly hash: string;
  readonly size: number;
}

export interface Binding {
  readonly harness: "codex" | "claude";
  readonly nativeId: string;
}

export type ProtocolValue =
  | null
  | boolean
  | number
  | string
  | readonly ProtocolValue[]
  | {
      readonly [key: string]: ProtocolValue;
    };

export type ProtocolCollection = "work" | "submissions" | "messages" | "receipts" | "intake";

export interface ProtocolParent {
  readonly role: string;
  readonly epoch: number;
  readonly workerId: string;
}

export interface ProtocolWriter {
  readonly role: string;
  readonly epoch: number;
  readonly binding: Binding;
}

export interface ProtocolClaim {
  readonly role: string;
  readonly expectedEpoch: number;
  readonly binding: Binding;
  readonly evidence: string;
  readonly at: string;
  readonly parent?: ProtocolParent;
}

export interface ProtocolMutation {
  readonly collection: ProtocolCollection;
  readonly id: string;
  readonly expectedRevision: number;
  readonly value: ProtocolValue;
}

export interface ProtocolObject {
  readonly collection: ProtocolCollection;
  readonly id: string;
  readonly revision: number;
  readonly value: ProtocolValue;
}

export interface ProtocolTransaction extends ProtocolWriter {
  readonly id: string;
  readonly expectedRevision: number;
  readonly at: string;
  readonly mutations: readonly ProtocolMutation[];
}

export interface ProtocolState {
  readonly role: string;
  readonly epoch: number;
  readonly binding: Binding | null;
  readonly revision: number;
  readonly objects: readonly ProtocolObject[];
  readonly parent: ProtocolParent | null;
  readonly hash: string | null;
}

export type ProtocolEvent = {
  readonly schema: 1;
  readonly revision: number;
  readonly previousHash: string | null;
  readonly hash: string;
} & (
  | { readonly type: "claim"; readonly claim: ProtocolClaim; readonly epoch: number }
  | { readonly type: "transaction"; readonly transaction: ProtocolTransaction }
);

export interface ProtocolStoreOptions {
  /** Explicit, canonical external state root selected and validated by the integration owner. */
  readonly directory: string;
  readonly resolveBinding?: (role: string, binding: Binding) => boolean | Promise<boolean>;
  readonly nonBlocking?: boolean;
}

export interface ProtocolRoleListOptions {
  /** Include worker namespaces in addition to committed parent role namespaces. */
  readonly includeWorkers?: boolean;
}
