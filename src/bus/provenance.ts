// Compare token-attested startup evidence with the game's current installation.
import { installedIdentity } from "./pin.ts";

interface Evidence {
  readonly cli_sha256: string | null;
  readonly source_commit: string | null;
  readonly version: string | null;
}

interface Attestation {
  readonly identity: Record<string, unknown> | null;
  readonly identityStatus: string;
  readonly loopHeld: boolean;
}

type Comparison = "different" | "match" | "unknown";

export interface ProvenanceReport {
  readonly archive: { readonly reason: string; readonly status: "unknown" };
  readonly comparison: Readonly<Record<keyof Evidence, Comparison>>;
  readonly installed: Evidence;
  readonly resident: Evidence;
  readonly resident_status: "attested" | "unknown";
}

function evidence(value: Record<string, unknown> | null): Evidence {
  const digest = value?.cli_sha256;
  const source = value?.source_commit;
  const version = value?.version;
  return {
    cli_sha256: typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? digest : null,
    source_commit: typeof source === "string" && /^[a-f0-9]{40}$/.test(source) ? source : null,
    version: typeof version === "string" && version.trim() !== "" ? version : null,
  };
}

function compare(resident: string | null, installed: string | null): Comparison {
  if (resident === null || installed === null) {
    return "unknown";
  }
  return resident === installed ? "match" : "different";
}

export function provenanceReport(attestation: Attestation, repo?: string): ProvenanceReport {
  const { identity, identityStatus, loopHeld } = attestation;
  const startup = evidence(identity);
  const attested = identityStatus === "current" && loopHeld && startup.cli_sha256 !== null;
  const resident = attested ? startup : evidence(null);
  const current = repo === undefined ? null : installedIdentity(repo);
  const installed = evidence(
    current === null
      ? null
      : {
          cli_sha256: current.cliSha256,
          source_commit: current.sourceCommit,
          version: current.version,
        },
  );
  return {
    archive: { reason: "no_independent_verification", status: "unknown" },
    comparison: {
      cli_sha256: compare(resident.cli_sha256, installed.cli_sha256),
      source_commit: compare(resident.source_commit, installed.source_commit),
      version: compare(resident.version, installed.version),
    },
    installed,
    resident,
    resident_status: attested ? "attested" : "unknown",
  };
}
