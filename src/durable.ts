// Every state write goes through writeDurable: an exclusive temp file in the target directory,
// fsync, rename over the target, then fsync the directory so the rename itself survives a crash.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type DurableStage = "synced" | "renamed";

export interface DurableOptions {
  /** File mode of the result, applied with fchmod so the umask does not narrow it. */
  readonly mode?: number;
  /** Test hook: called after the temp file is synced and after the rename. */
  readonly onStage?: (stage: DurableStage, tempPath: string) => void;
}

const DEFAULT_MODE = 0o600;

/** The temp-file name prefix writeDurable uses for `path`, for cleanup by a lock holder. */
export function tempPrefix(path: string): string {
  return `.${basename(path)}.`;
}

export function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeDurable(
  path: string,
  data: string | Uint8Array,
  options: DurableOptions = {},
): void {
  const { mode = DEFAULT_MODE, onStage } = options;
  const directory = dirname(path);
  const temp = join(
    directory,
    `${tempPrefix(path)}${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  let renamed = false;
  try {
    try {
      fchmodSync(fd, mode);
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    onStage?.("synced", temp);
    renameSync(temp, path);
    renamed = true;
    fsyncDirectory(directory);
    onStage?.("renamed", temp);
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // The temp file is already gone; the target is untouched either way.
      }
    }
  }
}

export function writeJsonDurable(path: string, value: unknown, options: DurableOptions = {}): void {
  writeDurable(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export class JsonFileError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "JsonFileError";
    this.path = path;
  }
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonFileError(path, "invalid JSON");
  }
}

function readText(path: string, missingOk: boolean): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (missingOk && code === "ENOENT") {
      return undefined;
    }
    throw new JsonFileError(path, `cannot read (${code ?? "error"})`);
  }
}

export function readJson(path: string): unknown {
  return parseJson(path, readText(path, false) ?? "");
}

/** Like readJson, but a missing file returns undefined. Other read errors still throw. */
export function readJsonIfExists(path: string): unknown {
  const text = readText(path, true);
  return text === undefined ? undefined : parseJson(path, text);
}
