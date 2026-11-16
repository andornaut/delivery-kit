// Work publications retain evidence; request authority remains in the existing ledger.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { LedgerRequest } from "../accounting/types.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import type {
  ArtifactRef,
  ProtocolEvent,
  ProtocolObject,
  ProtocolTransaction,
  ProtocolValue,
} from "./types.ts";

export type WorkPhase =
  | "execution"
  | "check"
  | "integration"
  | "publication"
  | "consumer-adoption"
  | "delivery"
  | "deployment"
  | "acceptance";
export type WorkContext = Omit<ProtocolTransaction, "mutations">;

export interface WorkSource {
  readonly commit: string;
  readonly base: string;
  readonly tree: string;
  readonly dependencies: readonly { readonly role: string; readonly commit: string }[];
}

export interface WorkCriterion {
  readonly id: string;
  readonly targetId: string;
  readonly phases: readonly WorkPhase[];
  /** Empty means one work-wide receipt; otherwise every named consumer needs its own receipt. */
  readonly consumers: readonly string[];
}

export interface WorkDefinition {
  readonly id: string;
  readonly requestIds: readonly string[];
  readonly clauseIds: readonly string[];
  readonly messageIds: readonly string[];
  readonly plan: ArtifactRef;
  readonly artifacts: readonly ArtifactRef[];
  readonly criteria: readonly WorkCriterion[];
  readonly source: WorkSource | null;
  readonly retention: {
    readonly owner: string;
    readonly reason: string;
    readonly nextBoundary: string;
  } | null;
}

export interface WorkReceipt {
  readonly id: string;
  readonly workId: string;
  readonly definitionHash: string;
  readonly criterionId: string;
  readonly phase: WorkPhase;
  readonly consumer: string | null;
  readonly outcome: "passed" | "failed" | "unknown";
  readonly artifact: ArtifactRef;
  readonly source: WorkSource | null;
}

export interface SubmissionReference {
  readonly role: string;
  readonly id: string;
  readonly revision: number;
  readonly artifact: ArtifactRef;
}

export interface WorkPublication {
  readonly schema: 1;
  readonly definition: WorkDefinition;
  readonly definitionHash: string;
  readonly ready: boolean;
  readonly receipts: readonly WorkReceipt[];
  readonly accepted: readonly {
    readonly submission: SubmissionReference;
    readonly evidence: ArtifactRef;
  }[];
  readonly operationHash: string;
  readonly publication: ArtifactRef;
}

export interface WorkerSubmission {
  readonly schema: 1;
  readonly id: string;
  readonly parentRole: string;
  readonly parentEpoch: number;
  readonly workerId: string;
  readonly workId: string;
  readonly definitionHash: string;
  readonly criterionIds: readonly string[];
  readonly source: WorkSource | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly receipts: readonly WorkReceipt[];
  readonly operationHash: string;
  readonly publication: ArtifactRef;
}

export interface WorkStoreOptions {
  readonly protocol: ProtocolStore;
  readonly readRequest?: (id: string) => LedgerRequest | null | undefined;
}

export interface WorkIndex {
  readonly role: string;
  readonly epoch: number;
  readonly status: "available" | "unknown";
  readonly revision: number;
  readonly items: readonly {
    readonly id: string;
    readonly revision: number;
    readonly publication: ArtifactRef;
    readonly ready: boolean;
  }[];
}

export interface WorkReport {
  readonly status: "available" | "partial" | "unknown";
  readonly roles: readonly string[];
  readonly approvedUnstarted: readonly string[];
  readonly readyUnaccepted: readonly string[];
  readonly acceptedUnintegrated: readonly string[];
  readonly integratedUndelivered: readonly string[];
  readonly deployedUnaccepted: readonly string[];
  readonly unknownRetained: readonly string[];
  readonly unavailable: readonly { readonly role: string; readonly reason: string }[];
}

export interface WorkEvaluation {
  readonly authorization: "reviewed" | "unknown";
  readonly guarded: boolean;
  readonly criteriaSatisfied: boolean;
  /** Scoped work evidence only; the ledger independently governs request completion. */
  readonly closureReady: boolean;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly targetId: string;
    readonly consumer: string | null;
    readonly phase: WorkPhase;
    readonly outcome: "passed" | "failed" | "unknown";
  }[];
}

export class WorkError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`protocol work: ${code}`);
    this.code = code;
    this.name = "WorkError";
  }
}

const PHASES: readonly WorkPhase[] = [
  "execution",
  "check",
  "integration",
  "publication",
  "consumer-adoption",
  "delivery",
  "deployment",
  "acceptance",
];
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function demand(value: unknown, code = "invalid-work"): asserts value {
  if (!value) {
    throw new WorkError(code);
  }
}

function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  demand(isRecord(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && ID.test(item)) &&
    new Set(value).size === value.length
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  demand(
    value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)),
  );
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function artifact(value: unknown): asserts value is ArtifactRef {
  fields(value, ["hash", "size"]);
  demand(
    typeof value.hash === "string" &&
      HASH.test(value.hash) &&
      Number.isSafeInteger(value.size) &&
      Number(value.size) >= 0,
    "invalid-artifact",
  );
}

function source(value: unknown): void {
  if (value === null) {
    return;
  }
  fields(value, ["base", "commit", "tree", "dependencies"]);
  demand(
    [value.base, value.commit, value.tree].every((pin) => typeof pin === "string" && SHA.test(pin)),
  );
  demand(Array.isArray(value.dependencies));
  for (const dependency of value.dependencies) {
    fields(dependency, ["role", "commit"]);
    demand(
      text(dependency.role) && typeof dependency.commit === "string" && SHA.test(dependency.commit),
    );
  }
}

function definition(value: WorkDefinition): void {
  fields(value, [
    "id",
    "requestIds",
    "clauseIds",
    "messageIds",
    "plan",
    "artifacts",
    "criteria",
    "source",
    "retention",
  ]);
  demand(
    ID.test(value.id) &&
      ids(value.requestIds) &&
      value.requestIds.length > 0 &&
      ids(value.clauseIds) &&
      ids(value.messageIds) &&
      Array.isArray(value.artifacts) &&
      Array.isArray(value.criteria) &&
      value.criteria.length > 0,
  );
  artifact(value.plan);
  value.artifacts.forEach(artifact);
  source(value.source);
  demand(new Set(value.criteria.map((criterion) => criterion.id)).size === value.criteria.length);
  for (const criterion of value.criteria) {
    fields(criterion, ["id", "targetId", "phases", "consumers"]);
    demand(
      typeof criterion.id === "string" &&
        ID.test(criterion.id) &&
        typeof criterion.targetId === "string" &&
        ID.test(criterion.targetId) &&
        ids(criterion.consumers) &&
        Array.isArray(criterion.phases) &&
        criterion.phases.length > 0 &&
        criterion.phases.every((phase) => PHASES.includes(phase)) &&
        new Set(criterion.phases).size === criterion.phases.length,
    );
  }
  if (value.retention !== null) {
    fields(value.retention, ["owner", "reason", "nextBoundary"]);
    demand(Object.values(value.retention).every(text));
  }
}

function covered(
  work: WorkDefinition,
  receipts: readonly WorkReceipt[],
  phases: readonly WorkPhase[],
): boolean {
  const required = work.criteria.flatMap((criterion) =>
    criterion.phases
      .filter((phase) => phases.includes(phase))
      .flatMap((phase) =>
        (criterion.consumers.length ? criterion.consumers : [null]).map((consumer) => ({
          consumer,
          criterionId: criterion.id,
          phase,
        })),
      ),
  );
  return (
    required.length > 0 &&
    required.every(
      (scope) =>
        receipts
          .filter(
            (receipt) =>
              receipt.criterionId === scope.criterionId &&
              receipt.phase === scope.phase &&
              receipt.consumer === scope.consumer,
          )
          .at(-1)?.outcome === "passed",
    )
  );
}

function bodyOf(work: WorkPublication): Omit<WorkPublication, "publication"> {
  return {
    accepted: work.accepted,
    definition: work.definition,
    definitionHash: work.definitionHash,
    operationHash: work.operationHash,
    ready: work.ready,
    receipts: work.receipts,
    schema: 1,
  };
}

/** Only canonical protocol objects and artifacts are used; no task paths or derived index writes. */
export class WorkStore {
  readonly #options: WorkStoreOptions;

  constructor(options: WorkStoreOptions) {
    this.#options = options;
  }

  #verify(ref: ArtifactRef): void {
    artifact(ref);
    demand(
      this.#options.protocol.readArtifact(ref.hash).byteLength === ref.size,
      "artifact-size-mismatch",
    );
  }

  async #artifact(value: unknown): Promise<ArtifactRef> {
    return this.#options.protocol.putArtifact(Buffer.from(canonical(value)));
  }

  async #replay(context: WorkContext, operationHash: string): Promise<ProtocolEvent | undefined> {
    const event = this.#options.protocol
      .history(context.role)
      .find((entry) => entry.type === "transaction" && entry.transaction.id === context.id);
    if (event?.type !== "transaction") {
      return undefined;
    }
    const { mutations, ...prior } = event.transaction;
    demand(
      isDeepStrictEqual(prior, context) &&
        mutations.some(
          (mutation) => isRecord(mutation.value) && mutation.value.operationHash === operationHash,
        ),
      "work-operation-conflict",
    );
    return this.#options.protocol.transact(event.transaction);
  }

  #object(
    role: string,
    collection: "work" | "submissions",
    id: string,
  ): ProtocolObject | undefined {
    return this.#options.protocol
      .read(role)
      .objects.find((object) => object.collection === collection && object.id === id);
  }

  read(role: string, id: string): WorkPublication | undefined {
    const object = this.#object(role, "work", id);
    if (object === undefined) {
      return undefined;
    }
    const value = object.value as unknown as WorkPublication;
    demand(
      isRecord(value) &&
        value.schema === 1 &&
        value.definition?.id === id &&
        Array.isArray(value.receipts) &&
        Array.isArray(value.accepted),
      "invalid-publication",
    );
    definition(value.definition);
    demand(
      typeof value.ready === "boolean" &&
        value.definitionHash === digest(value.definition) &&
        HASH.test(value.operationHash),
      "invalid-publication",
    );
    demand(
      Buffer.from(this.#options.protocol.readArtifact(value.definitionHash)).toString() ===
        canonical(value.definition),
      "definition-mismatch",
    );
    this.#verify(value.publication);
    const { publication, ...body } = value;
    demand(
      Buffer.from(this.#options.protocol.readArtifact(publication.hash)).toString() ===
        canonical(body),
      "publication-mismatch",
    );
    demand(
      new Set(value.receipts.map((receipt) => receipt.id)).size === value.receipts.length,
      "receipt-exists",
    );
    value.receipts.forEach((receipt) =>
      this.#receipt(value.definition, value.definitionHash, receipt),
    );
    if (value.ready) {
      this.#ready(value.definition, value.receipts);
    }
    return structuredClone(value);
  }

  #current(context: WorkContext, id: string, expected: number): WorkPublication {
    demand(!context.role.includes("/workers/"), "parent-publication-required");
    demand(this.#object(context.role, "work", id)?.revision === expected, "stale-work");
    const value = this.read(context.role, id);
    demand(value !== undefined, "work-missing");
    return value;
  }

  #receipt(work: WorkDefinition, hash: string, receipt: WorkReceipt): void {
    fields(receipt, [
      "id",
      "workId",
      "definitionHash",
      "criterionId",
      "phase",
      "consumer",
      "outcome",
      "artifact",
      "source",
    ]);
    demand(
      ID.test(receipt.id) &&
        receipt.workId === work.id &&
        receipt.definitionHash === hash &&
        ["passed", "failed", "unknown"].includes(receipt.outcome),
      "invalid-receipt",
    );
    const criterion = work.criteria.find((entry) => entry.id === receipt.criterionId);
    demand(
      criterion !== undefined &&
        criterion.phases.includes(receipt.phase) &&
        (criterion.consumers.length
          ? criterion.consumers.includes(receipt.consumer ?? "")
          : receipt.consumer === null),
      "receipt-scope-mismatch",
    );
    source(receipt.source);
    if (work.source !== null && ["execution", "check"].includes(receipt.phase)) {
      demand(isDeepStrictEqual(receipt.source, work.source), "receipt-source-mismatch");
    }
    this.#verify(receipt.artifact);
  }

  #ready(work: WorkDefinition, receipts: readonly WorkReceipt[]): void {
    this.#verify(work.plan);
    work.artifacts.forEach((ref) => this.#verify(ref));
    demand(covered(work, receipts, ["execution", "check"]), "ready-evidence-missing");
  }

  async #commit(
    context: WorkContext,
    value: Omit<WorkPublication, "publication">,
    expected: number,
    receipts: readonly WorkReceipt[] = [],
  ): Promise<ProtocolEvent> {
    const publication = await this.#artifact(value);
    const record: WorkPublication = { ...value, publication };
    return this.#options.protocol.transact({
      ...context,
      mutations: [
        ...receipts.map((receipt) => ({
          collection: "receipts" as const,
          expectedRevision: 0,
          id: receipt.id,
          value: JSON.parse(canonical(receipt)) as ProtocolValue,
        })),
        {
          collection: "work",
          expectedRevision: expected,
          id: value.definition.id,
          value: JSON.parse(canonical(record)) as ProtocolValue,
        },
      ],
    });
  }

  async publish(
    context: WorkContext,
    input: {
      readonly definition: WorkDefinition;
      readonly expectedWorkRevision: number;
      readonly ready: boolean;
      readonly replaces: string | null;
    },
  ): Promise<ProtocolEvent> {
    const operationHash = digest(["publish", input]);
    const replay = await this.#replay(context, operationHash);
    if (replay) {
      return replay;
    }
    demand(!context.role.includes("/workers/"), "parent-publication-required");
    definition(input.definition);
    demand(typeof input.ready === "boolean");
    const object = this.#object(context.role, "work", input.definition.id);
    demand((object?.revision ?? 0) === input.expectedWorkRevision, "stale-work");
    const prior = this.read(context.role, input.definition.id);
    const definitionHash = (await this.#artifact(input.definition)).hash;
    if (prior !== undefined && prior.definitionHash !== definitionHash) {
      demand(input.replaces === prior.publication.hash, "explicit-replacement-required");
    }
    this.#verify(input.definition.plan);
    const receipts = prior?.definitionHash === definitionHash ? prior.receipts : [];
    if (input.ready) {
      this.#ready(input.definition, receipts);
    }
    return this.#commit(
      context,
      {
        accepted: prior?.definitionHash === definitionHash ? prior.accepted : [],
        definition: structuredClone(input.definition),
        definitionHash,
        operationHash,
        ready: input.ready,
        receipts,
        schema: 1,
      },
      input.expectedWorkRevision,
    );
  }

  async receipt(
    context: WorkContext,
    input: {
      readonly workId: string;
      readonly expectedWorkRevision: number;
      readonly receipt: WorkReceipt;
    },
  ): Promise<ProtocolEvent> {
    const operationHash = digest(["receipt", input]);
    const replay = await this.#replay(context, operationHash);
    if (replay) {
      return replay;
    }
    const work = this.#current(context, input.workId, input.expectedWorkRevision);
    this.#receipt(work.definition, work.definitionHash, input.receipt);
    demand(!work.receipts.some((receipt) => receipt.id === input.receipt.id), "receipt-exists");
    const body = bodyOf(work);
    const receipts = [...work.receipts, structuredClone(input.receipt)];
    return this.#commit(
      context,
      {
        ...body,
        operationHash,
        ready: work.ready && covered(work.definition, receipts, ["execution", "check"]),
        receipts,
      },
      input.expectedWorkRevision,
      [input.receipt],
    );
  }

  async submit(
    context: WorkContext,
    input: Omit<WorkerSubmission, "schema" | "operationHash" | "publication">,
  ): Promise<ProtocolEvent> {
    const operationHash = digest(["submit", input]);
    const replay = await this.#replay(context, operationHash);
    if (replay) {
      return replay;
    }
    fields(input, [
      "id",
      "parentRole",
      "parentEpoch",
      "workerId",
      "workId",
      "definitionHash",
      "criterionIds",
      "source",
      "artifacts",
      "receipts",
    ]);
    demand(ID.test(input.id) && Array.isArray(input.artifacts) && Array.isArray(input.receipts));
    demand(
      new Set(input.receipts.map((receipt) => receipt.id)).size === input.receipts.length,
      "receipt-exists",
    );
    demand(
      context.role === protocolWorkerRole(input.parentRole, input.workerId, input.parentEpoch),
      "worker-scope-mismatch",
    );
    const work = this.read(input.parentRole, input.workId);
    demand(
      work !== undefined &&
        work.definitionHash === input.definitionHash &&
        ids(input.criterionIds) &&
        input.criterionIds.length > 0 &&
        input.criterionIds.every((id) => work.definition.criteria.some((c) => c.id === id)),
      "submission-scope-mismatch",
    );
    source(input.source);
    input.artifacts.forEach((ref) => this.#verify(ref));
    input.receipts.forEach((receipt) => {
      demand(
        input.criterionIds.includes(receipt.criterionId) &&
          ["execution", "check"].includes(receipt.phase),
        "submission-scope-mismatch",
      );
      demand(isDeepStrictEqual(receipt.source, input.source), "receipt-source-mismatch");
      this.#receipt(work.definition, work.definitionHash, receipt);
    });
    this.#ready(
      {
        ...work.definition,
        criteria: work.definition.criteria.filter((criterion) =>
          input.criterionIds.includes(criterion.id),
        ),
      },
      input.receipts,
    );
    const body = { ...structuredClone(input), operationHash, schema: 1 };
    const publication = await this.#artifact(body);
    return this.#options.protocol.transact({
      ...context,
      mutations: [
        {
          collection: "submissions",
          expectedRevision: 0,
          id: input.id,
          value: JSON.parse(canonical({ ...body, publication })) as ProtocolValue,
        },
      ],
    });
  }

  async accept(
    context: WorkContext,
    input: {
      readonly workId: string;
      readonly expectedWorkRevision: number;
      readonly submission: SubmissionReference;
      readonly evidence: ArtifactRef;
    },
  ): Promise<ProtocolEvent> {
    const operationHash = digest(["accept", input]);
    const replay = await this.#replay(context, operationHash);
    if (replay) {
      return replay;
    }
    const work = this.#current(context, input.workId, input.expectedWorkRevision);
    this.#verify(input.evidence);
    const object = this.#object(input.submission.role, "submissions", input.submission.id);
    demand(object?.revision === input.submission.revision, "submission-changed");
    const value = object.value as unknown as WorkerSubmission;
    demand(
      value.schema === 1 &&
        value.parentRole === context.role &&
        value.workId === input.workId &&
        value.definitionHash === work.definitionHash &&
        ids(value.criterionIds) &&
        value.criterionIds.length > 0 &&
        value.criterionIds.every((id) =>
          work.definition.criteria.some((criterion) => criterion.id === id),
        ) &&
        Array.isArray(value.artifacts) &&
        Array.isArray(value.receipts) &&
        input.submission.role ===
          protocolWorkerRole(value.parentRole, value.workerId, value.parentEpoch) &&
        isDeepStrictEqual(value.publication, input.submission.artifact),
      "submission-scope-mismatch",
    );
    this.#verify(value.publication);
    const { publication, ...submitted } = value;
    demand(
      Buffer.from(this.#options.protocol.readArtifact(publication.hash)).toString() ===
        canonical(submitted),
      "submission-publication-mismatch",
    );
    value.receipts.forEach((receipt) =>
      this.#receipt(work.definition, work.definitionHash, receipt),
    );
    demand(
      new Set(value.receipts.map((receipt) => receipt.id)).size === value.receipts.length,
      "receipt-exists",
    );
    demand(
      value.receipts.every(
        (receipt) =>
          ["execution", "check"].includes(receipt.phase) &&
          value.criterionIds.includes(receipt.criterionId) &&
          isDeepStrictEqual(receipt.source, value.source),
      ),
      "submission-scope-mismatch",
    );
    source(value.source);
    value.artifacts.forEach((ref) => this.#verify(ref));
    this.#ready(
      {
        ...work.definition,
        criteria: work.definition.criteria.filter((criterion) =>
          value.criterionIds.includes(criterion.id),
        ),
      },
      value.receipts,
    );
    const body = bodyOf(work);
    const receiptIds = new Set(work.receipts.map((receipt) => receipt.id));
    demand(
      value.receipts.every((receipt) => !receiptIds.has(receipt.id)),
      "receipt-exists",
    );
    return this.#commit(
      context,
      {
        ...body,
        accepted: [...work.accepted, { evidence: input.evidence, submission: input.submission }],
        operationHash,
        receipts: [...work.receipts, ...value.receipts],
      },
      input.expectedWorkRevision,
    );
  }

  index(role: string): WorkIndex {
    const state = this.#options.protocol.read(role);
    const items = state.objects
      .filter((object) => object.collection === "work")
      .map((object) => {
        // Discovery carries committed pointers; reading work validates the referenced artifacts.
        const work = object.value as unknown as WorkPublication;
        demand(
          isRecord(work) &&
            work.schema === 1 &&
            work.definition?.id === object.id &&
            typeof work.ready === "boolean",
          "invalid-publication",
        );
        artifact(work.publication);
        return {
          id: object.id,
          publication: { ...work.publication },
          ready: work.ready,
          revision: object.revision,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      epoch: state.epoch,
      items,
      revision: state.revision,
      role,
      status: state.epoch > 0 && items.length > 0 ? "available" : "unknown",
    };
  }

  evaluate(role: string, id: string): WorkEvaluation {
    const work = this.read(role, id);
    demand(work !== undefined, "work-missing");
    return this.#evaluate(work);
  }

  #evaluate(work: WorkPublication): WorkEvaluation {
    let requests: readonly (LedgerRequest | null | undefined)[] = [];
    try {
      requests = work.definition.requestIds.map((request) => this.#options.readRequest?.(request));
    } catch {
      // Missing authority remains unknown; it never turns a publication into approval.
    }
    const provenance =
      requests.length === work.definition.requestIds.length &&
      requests.every(
        (request) =>
          request != null &&
          request.reviewed &&
          ["request", "approval"].includes(request.kind) &&
          !["completed", "cancelled", "superseded"].includes(request.state) &&
          [request.source, ...request.sources.map((link) => link.source)].some(
            (s) => s.origin === "owner-attested" && s.reference !== null,
          ),
      );
    const scope = work.definition.criteria.every((criterion) => {
      const matches = requests.flatMap(
        (request) =>
          request?.targets
            .filter((target) => target.id === criterion.targetId)
            .flatMap((target) =>
              target.criteria
                .filter((entry) => entry.id === criterion.id)
                .map((entry) => ({ entry, target })),
            ) ?? [],
      );
      return (
        matches.length === 1 &&
        matches.every(
          ({ entry, target }) =>
            criterion.phases.every((phase) =>
              entry.requiredEvidence.includes(phase === "execution" ? "implementation" : phase),
            ) && criterion.consumers.every((consumer) => target.consumers.includes(consumer)),
        )
      );
    });
    const authorization = provenance && scope ? "reviewed" : "unknown";
    const guarded = requests.some(
      (request) =>
        request?.question != null && ["pending", "unknown"].includes(request.question.status),
    );
    const criteria = work.definition.criteria.flatMap((criterion) =>
      criterion.phases.flatMap((phase) =>
        (criterion.consumers.length ? criterion.consumers : [null]).map((consumer) => ({
          consumer,
          criterionId: criterion.id,
          outcome:
            work.receipts
              .filter(
                (receipt) =>
                  receipt.criterionId === criterion.id &&
                  receipt.phase === phase &&
                  receipt.consumer === consumer,
              )
              .at(-1)?.outcome ?? "unknown",
          phase,
          targetId: criterion.targetId,
        })),
      ),
    );
    const criteriaSatisfied = criteria.every((criterion) => criterion.outcome === "passed");
    return {
      authorization,
      closureReady:
        authorization === "reviewed" &&
        !guarded &&
        work.definition.retention === null &&
        criteriaSatisfied,
      criteria,
      criteriaSatisfied,
      guarded,
    };
  }

  report(options: { readonly roles?: readonly string[] } = {}): WorkReport {
    const result = {
      acceptedUnintegrated: [] as string[],
      approvedUnstarted: [] as string[],
      deployedUnaccepted: [] as string[],
      integratedUndelivered: [] as string[],
      readyUnaccepted: [] as string[],
      unavailable: [] as { reason: string; role: string }[],
      unknownRetained: [] as string[],
    };
    const discovered = this.#options.protocol.listRoles({ includeWorkers: true });
    const roles = [
      ...new Set(
        options.roles === undefined
          ? discovered
          : [
              ...options.roles,
              ...discovered.filter((role) =>
                options.roles!.some((parent) => role.startsWith(`${parent}/workers/`)),
              ),
            ],
      ),
    ].sort();
    let observed = 0;
    for (const role of roles) {
      try {
        if (role.includes("/workers/")) {
          const submissions = this.#options.protocol
            .read(role)
            .objects.filter((object) => object.collection === "submissions");
          if (submissions.length === 0) {
            result.unavailable.push({ reason: "no-worker-submission", role });
          }
          for (const object of submissions) {
            const submission = object.value as unknown as WorkerSubmission;
            demand(
              submission.schema === 1 &&
                submission.id === object.id &&
                role ===
                  protocolWorkerRole(
                    submission.parentRole,
                    submission.workerId,
                    submission.parentEpoch,
                  ),
              "submission-scope-mismatch",
            );
            this.#verify(submission.publication);
            const { publication, ...body } = submission;
            demand(
              Buffer.from(this.#options.protocol.readArtifact(publication.hash)).toString() ===
                canonical(body),
              "submission-publication-mismatch",
            );
            observed += 1;
            const parent = this.read(submission.parentRole, submission.workId);
            const id = `${role}:${object.id}`;
            if (parent?.definitionHash !== submission.definitionHash) {
              result.unknownRetained.push(id);
              continue;
            }
            submission.artifacts.forEach((ref) => this.#verify(ref));
            submission.receipts.forEach((receipt) =>
              this.#receipt(parent.definition, parent.definitionHash, receipt),
            );
            this.#ready(
              {
                ...parent.definition,
                criteria: parent.definition.criteria.filter((criterion) =>
                  submission.criterionIds.includes(criterion.id),
                ),
              },
              submission.receipts,
            );
            if (
              !parent.accepted.some(
                ({ submission: reference }) =>
                  reference.role === role &&
                  reference.id === object.id &&
                  reference.revision === object.revision &&
                  reference.artifact.hash === publication.hash,
              )
            ) {
              result.readyUnaccepted.push(id);
            }
          }
          continue;
        }
        const index = this.index(role);
        if (index.status === "unknown") {
          result.unavailable.push({
            reason: index.epoch === 0 ? "role-unclaimed" : "no-work-publication",
            role,
          });
        }
        for (const entry of index.items) {
          const work = this.read(role, entry.id)!;
          observed += 1;
          const id = `${role}:${entry.id}`;
          const evaluation = this.#evaluate(work);
          const authorized = evaluation.authorization === "reviewed";
          const phase = (value: WorkPhase) => covered(work.definition, work.receipts, [value]);
          const required = (value: WorkPhase) =>
            work.definition.criteria.some((criterion) => criterion.phases.includes(value));
          if (!authorized || evaluation.guarded || work.definition.retention !== null) {
            result.unknownRetained.push(id);
          }
          if (
            authorized &&
            !work.receipts.some((receipt) => ["execution", "check"].includes(receipt.phase))
          ) {
            result.approvedUnstarted.push(id);
          }
          if (work.ready && !work.accepted.length) {
            result.readyUnaccepted.push(id);
          }
          if (work.accepted.length && required("integration") && !phase("integration")) {
            result.acceptedUnintegrated.push(id);
          }
          if (
            required("integration") &&
            phase("integration") &&
            ((required("delivery") && !phase("delivery")) ||
              (required("publication") && !phase("publication")))
          ) {
            result.integratedUndelivered.push(id);
          }
          if (
            required("deployment") &&
            phase("deployment") &&
            required("acceptance") &&
            !phase("acceptance")
          ) {
            result.deployedUnaccepted.push(id);
          }
        }
      } catch (error) {
        result.unavailable.push({
          reason: error instanceof WorkError ? error.code : "protocol-unavailable",
          role,
        });
      }
    }
    return {
      ...result,
      roles: [...roles],
      status:
        observed === 0
          ? "unknown"
          : result.unavailable.length || result.unknownRetained.length
            ? "partial"
            : "available",
    };
  }
}
