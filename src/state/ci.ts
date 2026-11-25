// The CI watch records in the bus ci/ directory.

const STATUS_SUFFIX = ".status";

/** The ci/<sha>.status values of a watch that has not finished. */
const UNFINISHED: ReadonlySet<string> = new Set(["pending", "running"]);

/**
 * The SHAs whose ci/<sha>.status reads pending or running, in name order. `names` is a ci/
 * listing; `read` returns a status file's trimmed text, or undefined when it cannot be read.
 */
export function unfinishedCiWatches(
  read: (name: string) => string | undefined,
  names: readonly string[],
): string[] {
  return names
    .filter((name) => name.endsWith(STATUS_SUFFIX))
    .sort()
    .filter((name) => UNFINISHED.has(read(name) ?? ""))
    .map((name) => name.slice(0, -STATUS_SUFFIX.length));
}
