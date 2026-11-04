// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// migrated.json: written once a tree or file is copied and verified; its digest makes a rerun a
// no-op while the source is unchanged.
export interface MovedLog {
  readonly from: string;
  readonly to: string;
  readonly sha256: string;
}

export interface MigrationMarker {
  readonly schema: 1;
  readonly unit: string;
  readonly source: string;
  readonly target: string;
  readonly migratedAt: string;
  /** treeDigest of the copied source entries, without the moved log. */
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly entries: number;
  readonly bytes: number;
  readonly excluded: readonly string[];
  readonly log: MovedLog | null;
}

export function isMarker(value: unknown): value is MigrationMarker {
  const marker = value as Partial<MigrationMarker> | undefined;
  return (
    typeof marker === "object" &&
    marker !== null &&
    marker.schema === 1 &&
    typeof marker.source === "string" &&
    typeof marker.sourceDigest === "string"
  );
}
