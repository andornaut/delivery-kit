// Small file reads and durable writes shared by the state, status and runner modules.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";

import { writeDurable } from "@andornaut/coordination-kit/build/shared";

/** File text, or undefined when it cannot be read. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Trimmed file text, or undefined when unreadable. */
export function readTrimmed(path: string): string | undefined {
  return readText(path)?.trim();
}

/** Durable small state file; `lines` are written newline-terminated. */
export function writeLines(path: string, ...lines: readonly string[]): void {
  writeDurable(path, lines.map((line) => `${line}\n`).join(""), { mode: 0o644 });
}

/** Durably empty a file (`: >file`). */
export function truncate(path: string): void {
  writeDurable(path, "", { mode: 0o644 });
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** The sha256 of a file's bytes, or null when it cannot be read. */
export function fileSha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** The error's `errno` code, such as ENOENT, when it has one. */
export function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
