import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Layout } from "../layout.ts";

/** Fixture configuration only, never a production migration or native-ingress receipt. */
export function activateProtocolFixture(layout: Layout): string {
  const stateRoot = mkdtempSync(join(tmpdir(), "protocol-runtime-state-"));
  const config = { generation: 1, schema: 1, stateRoot, workspaceId: "fixture" };
  mkdirSync(layout.varDir, { recursive: true });
  writeFileSync(
    join(stateRoot, "workspace.json"),
    JSON.stringify({ generation: 1, schema: 1, workspaceId: "fixture" }),
  );
  for (const name of ["work-protocol-fence.json", "work-protocol.json"]) {
    writeFileSync(join(layout.varDir, name), JSON.stringify(config));
  }
  return stateRoot;
}
