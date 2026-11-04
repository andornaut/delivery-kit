// Shared command contract: exit codes, process I/O and handler shape.
export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export interface Io {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export type Handler = (io: Io, root: string, args: string[]) => number | Promise<number>;
