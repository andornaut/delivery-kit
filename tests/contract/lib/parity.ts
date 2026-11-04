// CLEANUP (added 2026-11-04): remove once both games run delivery-kit 1.x and have completed one clean departure cycle.
// The released 0.9.1 Bash implementation the bash adapter runs for parity. It is installed
// inside the networked container step by parity-install.ts and verified by digest; nothing of it
// is committed here. DK_PARITY_DIR names where it lives (a named-volume path in the container).
import { existsSync } from "node:fs";
import { join } from "node:path";

const RELEASE = "https://github.com/andornaut/delivery-kit/releases/download/v0.9.1";

export const PARITY = {
  archive: {
    name: "delivery-kit-0.9.1.tar.gz",
    sha256: "b8a423d5292ea54fd23b10c504dc5cff15d2ad01afc78790e7fda8c6bdf2783c",
    sums: `${RELEASE}/SHA256SUMS`,
    url: `${RELEASE}/delivery-kit-0.9.1.tar.gz`,
  },
  root: "delivery-kit-0.9.1",
  sourceCommit: "bbd1e7fb05d70959a80ba393584a48805185195c",
  /**
   * Runtime dependency of the v0.9.1 archive only: its Codex helpers (libexec/unblock.py,
   * monitor.py, event_native.py) import `websocket` to reach the control socket. It serves the
   * v0.9.1 parity run alone, is installed inside the container and is put on PYTHONPATH as a
   * pure wheel. The harness's own fake control socket is TypeScript (codex-socket.ts).
   */
  websocketClient: {
    name: "websocket_client-1.9.2-py3-none-any.whl",
    sha256: "e1a673830a9c7bfa47b1cd3d5e4178f4c9651d80a4eab02c9c23a1c3ec6250ce",
    url: "https://files.pythonhosted.org/packages/d5/d2/cc4dc1271e464942db7ee278baae2daa99ee77cb2af744025c04da585a3e/websocket_client-1.9.2-py3-none-any.whl",
  },
} as const;

export const PARITY_DIR = process.env.DK_PARITY_DIR ?? "/var/tmp/parity";
/** Root of the extracted 0.9.1 release: bin/, libexec/, scripts/, VERSION and SOURCE_COMMIT. */
export const BASH_ROOT = join(PARITY_DIR, PARITY.root);
export const PARITY_WHEEL = join(PARITY_DIR, PARITY.websocketClient.name);
export const parityInstalled = existsSync(join(PARITY_DIR, "verified"));
