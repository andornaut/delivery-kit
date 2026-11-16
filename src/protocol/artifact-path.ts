import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export type ArtifactPathErrorCode =
  | "invalid-artifact-path"
  | "unsafe-artifact-path"
  | "artifact-path-unavailable"
  | "artifact-not-file";

export class ArtifactPathError extends Error {
  readonly code: ArtifactPathErrorCode;

  constructor(code: ArtifactPathErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Known credential components only. This predicate does not inspect artifact bytes. */
export function unsafeArtifactPathComponent(name: string): boolean {
  return (
    name === ".git" ||
    name === ".private" ||
    name === ".ssh" ||
    name === ".vitest-secret-token" ||
    /^\.env(?:\.|$)/u.test(name) ||
    /^(?:\.?credentials|\.?auth\.json|id_rsa|id_ed25519)(?:\.|$)/u.test(name) ||
    /\.(?:pem|key|p12)$/u.test(name)
  );
}

function checkComponents(path: string): void {
  if (path.split(sep).some(unsafeArtifactPathComponent)) {
    throw new ArtifactPathError("unsafe-artifact-path");
  }
}

function guarded<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw error instanceof ArtifactPathError
      ? error
      : new ArtifactPathError("artifact-path-unavailable");
  }
}

/** Resolve aliases component by component so an intermediate protected target cannot disappear. */
function destination(
  path: string,
  allowMissingLeaf: boolean,
): { path: string; stat: Stats | null } {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new ArtifactPathError("invalid-artifact-path");
  }
  checkComponents(path);
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  checkComponents(resolve(absolute));
  let current = parse(absolute).root;
  let pending = absolute.slice(current.length).split(sep);
  let aliases = 0;
  while (pending.length > 0) {
    const component = pending.shift()!;
    if (component === "" || component === ".") {
      continue;
    }
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, component);
    let stat: Stats;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (
        allowMissingLeaf &&
        pending.length === 0 &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { path: candidate, stat: null };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(candidate);
      checkComponents(target);
      if (++aliases > 40) {
        throw new ArtifactPathError("artifact-path-unavailable");
      }
      if (isAbsolute(target)) {
        current = parse(target).root;
      }
      pending = [...target.split(sep), ...pending];
      continue;
    }
    if (pending.length > 0 && !stat.isDirectory()) {
      throw new ArtifactPathError("artifact-path-unavailable");
    }
    current = candidate;
  }
  checkComponents(current);
  return { path: current, stat: lstatSync(current) };
}

/** Read exact public artifact bytes after supplied names and all alias targets pass the policy. */
export function readPromotableArtifact(path: string): Uint8Array {
  return guarded(() => {
    const selected = destination(path, false);
    if (selected.stat === null || !selected.stat.isFile()) {
      throw new ArtifactPathError("artifact-not-file");
    }
    const fd = openSync(
      selected.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = fstatSync(fd);
      const checked = destination(path, false);
      if (
        !opened.isFile() ||
        opened.dev !== selected.stat.dev ||
        opened.ino !== selected.stat.ino ||
        checked.path !== selected.path ||
        checked.stat?.dev !== opened.dev ||
        checked.stat.ino !== opened.ino
      ) {
        throw new ArtifactPathError("artifact-path-unavailable");
      }
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

/** Validate an output destination without reading it or creating directories. Writers still use wx. */
export function assertArtifactOutputPath(path: string): string {
  return guarded(() => {
    const selected = destination(path, true);
    if (selected.stat !== null && !selected.stat.isFile()) {
      throw new ArtifactPathError("artifact-not-file");
    }
    return selected.path;
  });
}
