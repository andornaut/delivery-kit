// The resident identity recorded by the bus owner's observer adoption, compared with the running
// runner's identity token. Every read here is read-only; adoption is refreshed only through
// `protocol observer-adoption`.
import {
  ProtocolStore,
  resolveProtocolLayout,
  resolveProtocolManagement,
} from "@andornaut/coordination-kit/build/protocol";
import { readRegistry } from "@andornaut/coordination-kit/build/registry";
import { isRecord, type Layout } from "@andornaut/coordination-kit/build/shared";

import type { BusContext } from "./context.ts";

export type AdoptionUnknown =
  | "protocol_inactive"
  | "protocol_unavailable"
  | "registry_unavailable"
  | "adoption_absent"
  | "adoption_unreadable";

export type AdoptedResident =
  | {
      readonly status: "recorded";
      readonly at: string;
      readonly busOwner: string;
      readonly residentId: string;
    }
  | { readonly status: "unknown"; readonly reason: AdoptionUnknown };

export type ObserverAdoption = "current" | "stale" | "unknown";
export type ObserverAdoptionReason = AdoptionUnknown | "runner_not_current";

const EVIDENCE_REF = /^protocol-artifact:([a-f0-9]{64})$/u;

/**
 * The resident identity in the game's last observer adoption: registry
 * `operations.<game>.lastAdoption.evidenceRef` names the content-addressed audit, whose
 * owner-attested `resident.residentId` is the adopted runner token. The audit must name this
 * operation and agree with the registry's adopted version and CLI digest.
 */
export function adoptedResident(layout: Layout, game: string): AdoptedResident {
  let stateRoot: string;
  try {
    const management = resolveProtocolManagement(layout);
    const protocol = management.status === "active" ? resolveProtocolLayout(layout) : null;
    if (protocol === null) {
      return { reason: "protocol_inactive", status: "unknown" };
    }
    ({ stateRoot } = protocol);
  } catch {
    return { reason: "protocol_unavailable", status: "unknown" };
  }
  let operation;
  try {
    operation = readRegistry(layout).operations[game];
  } catch {
    return { reason: "registry_unavailable", status: "unknown" };
  }
  const adoption = operation?.lastAdoption;
  if (operation === undefined || adoption === undefined) {
    return { reason: "adoption_absent", status: "unknown" };
  }
  const digest = EVIDENCE_REF.exec(adoption.evidenceRef ?? "")?.[1];
  let audit: unknown;
  try {
    if (digest === undefined) {
      throw new Error("no audit reference");
    }
    const bytes = new ProtocolStore({ directory: stateRoot }).readArtifact(digest);
    audit = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return { reason: "adoption_unreadable", status: "unknown" };
  }
  const resident = isRecord(audit) ? audit.resident : undefined;
  if (
    !isRecord(audit) ||
    audit.kind !== "observer-adoption" ||
    audit.operation !== game ||
    !isRecord(resident) ||
    resident.operation !== game ||
    resident.ownerRole !== operation.busOwner ||
    resident.version !== adoption.version ||
    resident.cliSha256 !== adoption.cliSha256 ||
    typeof resident.residentId !== "string" ||
    resident.residentId === ""
  ) {
    return { reason: "adoption_unreadable", status: "unknown" };
  }
  return {
    at: adoption.at,
    busOwner: operation.busOwner,
    residentId: resident.residentId,
    status: "recorded",
  };
}

/** `current` or `stale` only for an attested running token and a recorded adoption. */
export function observerAdoption(
  adopted: AdoptedResident,
  runnerToken: string | null,
): { readonly status: ObserverAdoption; readonly reason: ObserverAdoptionReason | null } {
  if (runnerToken === null || runnerToken === "") {
    return { reason: "runner_not_current", status: "unknown" };
  }
  if (adopted.status === "unknown") {
    return { reason: adopted.reason, status: "unknown" };
  }
  return { reason: null, status: adopted.residentId === runnerToken ? "current" : "stale" };
}

/**
 * At startup under an active protocol, report a resident token that differs from the adopted
 * one: one reporter event per runner token. An unknown adoption is logged, never reported.
 */
export function reportResidentIdentity(context: BusContext, runnerToken: string | undefined): void {
  if (runnerToken === undefined) {
    return;
  }
  const adopted = adoptedResident(context.layout, context.game.id);
  const result = observerAdoption(adopted, runnerToken);
  if (result.status === "unknown") {
    if (result.reason !== "protocol_inactive") {
      context.log(`bus: observer adoption unknown (${result.reason}); no identity report`);
    }
    return;
  }
  if (result.status === "current" || adopted.status !== "recorded") {
    return;
  }
  context.log(
    `bus: resident identity ${runnerToken} differs from adopted ${adopted.residentId}; ` +
      "observer adoption must be refreshed",
  );
  context.events.emit(
    "resident-identity-changed",
    runnerToken,
    [
      `Resident identity changed: runner ${runnerToken} differs from the observer adoption`,
      `of ${adopted.residentId} recorded ${adopted.at}.`,
      `Bus owner ${adopted.busOwner} must refresh observer adoption.`,
    ].join(" "),
  );
}
