// bus-queue: one branch name per line. Blank lines are ignored; the first occurrence wins.
import { readText } from "./state.ts";

export function readQueue(path: string): string[] {
  const lines = (readText(path) ?? "").split("\n");
  // A trailing newline yields one empty element, which the blank filter drops.
  return [...new Set(lines.filter((line) => line.trim() !== ""))];
}
