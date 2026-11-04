// Hold a flock from another process, as a runner or an older runner would.
import { spawn } from "node:child_process";

export interface Holder {
  release(): Promise<void>;
}

/**
 * Hold `path` with flock on fd 5. `opener` is the Bash redirection: `5<>` keeps the file
 * contents (0.9 runner), `5>` truncates it (pre-0.9 runner), `5>>` appends.
 */
export async function hold(path: string, opener: "5<>" | "5>" | "5>>" = "5<>"): Promise<Holder> {
  const child = spawn(
    "bash",
    ["-c", `exec ${opener}"$1"; flock -n 5 || exit 9; echo held; read -r _`, "holder", path],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", (chunk: Buffer) =>
      chunk.toString().trim() === "held" ? resolve() : reject(new Error("lock not held")),
    );
    child.once("exit", (code) => reject(new Error(`holder of ${path} exited ${code}`)));
  });
  return {
    release: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.stdin.end();
      }),
  };
}
