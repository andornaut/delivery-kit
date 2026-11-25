// The abstract CLI operations an implementation adapter maps to command lines.
import type { Workspace } from "./workspace.ts";

export interface Command {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * A log file the command writes instead of stdout (the 1.0 runner's runner.log). A resident
   * started from it replays the file's new content as stdout and stderr data.
   */
  logFile?: string;
}

export interface Implementation {
  readonly name: "node";
  /** True when runnable; otherwise the reason its cases are skipped. */
  readonly available: true | string;
  /** `--help` or `help` without any configuration or state. */
  help(ws: Workspace, word: string): Command;
  /** A command with the game's configuration and state context. */
  command(ws: Workspace, words: string[]): Command;
  /** A command line without configuration or state context. */
  bare(ws: Workspace, words: string[]): Command;
  /**
   * Make new work available to the next departure: local main moves to the scripted commit (an
   * empty list leaves nothing new).
   */
  offer(ws: Workspace, branches: string[]): void;
  checkConfig(ws: Workspace): Command;
  status(ws: Workspace): Command;
  resourceReport(ws: Workspace): Command;
  request(ws: Workspace, id: string): Command;
  run(ws: Workspace): Command;
}
