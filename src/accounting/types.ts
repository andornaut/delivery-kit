export type LedgerKind =
  "unknown" | "request" | "question" | "suggestion" | "approval" | "cancellation";
export type LedgerState =
  | "open"
  | "started"
  | "blocked"
  | "waiting"
  | "ready"
  | "checked"
  | "integrated"
  | "delivered"
  | "completed"
  | "cancelled"
  | "superseded";
export type EvidenceKind =
  | "implementation"
  | "check"
  | "integration"
  | "publication"
  | "consumer-adoption"
  | "delivery"
  | "deployment"
  | "acceptance"
  | "answer"
  | "artifact"
  | "review";

export interface NativeReference {
  readonly harness: "codex" | "claude" | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly index: number | null;
}

/** Asserted provenance, never authentication of human approval from native item type alone. */
export interface LedgerSource {
  readonly origin: "native-user" | "owner-attested" | "relay" | "unknown";
  readonly reference: string | null;
  readonly native: NativeReference | null;
  readonly wordingHash: string | null;
}

export interface LedgerSourceLink {
  readonly id: string;
  readonly relation: "original" | "relay" | "attestation";
  readonly source: LedgerSource;
  readonly candidateId: string | null;
}

export interface LedgerAssignment {
  readonly ownerRole: string;
  readonly harness: "codex" | "claude" | null;
  readonly nativeId: string | null;
  readonly worker: {
    readonly id: string;
    readonly parentRole: string;
    readonly parentNativeId: string;
    readonly verificationRef: string;
  } | null;
}

export interface LedgerCriterion {
  readonly id: string;
  readonly description: string;
  readonly requiredEvidence: readonly EvidenceKind[];
}

export interface LedgerTarget {
  readonly id: string;
  readonly description: string;
  readonly consumers: readonly string[];
  readonly criteria: readonly LedgerCriterion[];
}

/** Accounting metadata only; no operation answers, clears or cancels a native question. */
export interface LedgerQuestion {
  readonly native: NativeReference | null;
  readonly text: string | null;
  readonly options: readonly string[] | null;
  readonly status: "unknown" | "pending" | "answered" | "cancelled";
  readonly resolutionRef: string | null;
}

export interface LedgerRequestInput {
  readonly id: string;
  readonly summary: string;
  readonly kind: LedgerKind;
  readonly reviewed: boolean;
  readonly source: LedgerSource;
  readonly assignment: LedgerAssignment | null;
  readonly parentId: string | null;
  readonly dependencies: readonly string[];
  readonly targets: readonly LedgerTarget[];
  readonly question: LedgerQuestion | null;
}

export interface LedgerEvidence {
  readonly id: string;
  readonly targetId: string;
  readonly criterionId: string;
  readonly kind: EvidenceKind;
  readonly consumer: string | null;
  readonly outcome: "passed" | "failed" | "unknown";
  readonly reference: string;
}

export interface LedgerCoverage {
  readonly id: string;
  readonly ownerRole: string;
  readonly source: LedgerSource;
  readonly range: { readonly from: string | null; readonly through: string | null };
  readonly state: "covered" | "partial" | "unavailable";
  readonly gaps: readonly {
    readonly from: string | null;
    readonly through: string | null;
    readonly reason: string;
  }[];
  readonly nextBoundary: string | null;
}

export type LedgerCommand =
  | {
      readonly type: "capture";
      readonly requests: readonly LedgerRequestInput[];
      readonly coverage: readonly LedgerCoverage[];
    }
  | { readonly type: "register"; readonly request: LedgerRequestInput }
  | {
      readonly type: "classify";
      readonly id: string;
      readonly kind: LedgerKind;
      readonly reviewed: boolean;
      readonly reason: string;
    }
  | { readonly type: "link"; readonly id: string; readonly link: LedgerSourceLink }
  | { readonly type: "assign"; readonly id: string; readonly assignment: LedgerAssignment | null }
  | {
      readonly type: "amend";
      readonly id: string;
      readonly summary: string;
      readonly targets: readonly LedgerTarget[];
      readonly dependencies: readonly string[];
      readonly reason: string;
    }
  | {
      readonly type: "progress";
      readonly id: string;
      readonly state:
        | "open"
        | "started"
        | "blocked"
        | "waiting"
        | "ready"
        | "checked"
        | "integrated"
        | "delivered";
      readonly reason: string;
      readonly requiredOwner: string | null;
      readonly nextBoundary: string | null;
    }
  | { readonly type: "evidence"; readonly id: string; readonly evidence: LedgerEvidence }
  | {
      readonly type: "close";
      readonly id: string;
      readonly evidenceIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly type: "cancel";
      readonly id: string;
      readonly descendants: readonly string[];
      readonly reason: string;
      readonly authorityRef: string;
    }
  | {
      readonly type: "supersede";
      readonly id: string;
      readonly replacementId: string;
      readonly reason: string;
      readonly authorityRef: string;
    }
  | {
      readonly type: "reopen";
      readonly id: string;
      readonly reason: string;
      readonly evidenceRef: string;
    }
  | {
      readonly type: "question";
      readonly id: string;
      readonly question: LedgerQuestion;
      readonly evidenceRef: string;
    }
  | { readonly type: "coverage"; readonly coverage: LedgerCoverage };

export interface LedgerTransaction {
  readonly schema: 1;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly actor: string;
  readonly at: string;
  readonly source: LedgerSource;
  readonly command: LedgerCommand;
}

export interface LedgerEvent extends LedgerTransaction {
  readonly revision: number;
  readonly previousHash: string | null;
  readonly hash: string;
}

export interface LedgerRequest extends LedgerRequestInput {
  readonly createdBy: string;
  readonly sources: readonly LedgerSourceLink[];
  readonly state: LedgerState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly children: readonly string[];
  readonly evidence: readonly LedgerEvidence[];
  readonly closureEvidenceIds: readonly string[];
  readonly reason: string | null;
  readonly requiredOwner: string | null;
  readonly nextBoundary: string | null;
  readonly replacementId: string | null;
}

export interface LedgerProjection {
  readonly initialized: boolean;
  readonly revision: number;
  readonly hash: string | null;
  readonly requests: readonly LedgerRequest[];
  readonly coverage: readonly LedgerCoverage[];
}

export interface LedgerReportOptions {
  readonly at: string;
  readonly stalledAfterMs?: number;
  readonly owner?: string;
}

export interface LedgerReport extends LedgerProjection {
  readonly at: string;
  readonly coverageState: "unknown" | "incomplete" | "declared-complete";
  readonly open: readonly string[];
  readonly stalled: readonly string[];
  readonly unassigned: readonly string[];
  readonly unknownSource: readonly string[];
  readonly untriaged: readonly string[];
  readonly protectedQuestions: readonly string[];
}

export interface LedgerStoreOptions {
  /** Canonical caller supplies join(layout.varDir, 'accounting'). */
  readonly directory: string;
  /** Automatic capture refuses contention without waiting; explicit transactions default to waiting. */
  readonly nonBlocking?: boolean;
  /** Required for any assignment. Return a fresh exact role/worker binding, null if unavailable. */
  readonly resolveOwner?: (
    assignment: LedgerAssignment,
  ) => LedgerAssignment | null | Promise<LedgerAssignment | null>;
}
