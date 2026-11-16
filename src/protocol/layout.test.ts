import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLayout } from "../layout.ts";
import { LockBusy } from "../lock.ts";
import { makeFixture } from "../testFixtures.ts";
import {
  acquireProtocolLayout,
  checkProtocolLayout,
  declareProtocolWorkspace,
  resolveProtocolLayout,
  resolveProtocolManagement,
  validateProtocolRoot,
} from "./layout.ts";
describe("protocol layout selection", () => {
  it("retains mandatory pending declaration and fences cached selections through cutover", async () => {
    const t = makeFixture();
    const layout = loadLayout(t.root);
    const unmanaged = resolveProtocolManagement(layout);
    const input = {
      authorityRef: "fixture:approved-workspace",
      expectedGeneration: 0 as const,
      workspaceId: "fixture",
    };
    const pending = await declareProtocolWorkspace(layout, input);
    expect(pending).toMatchObject({
      required: { authorityRef: input.authorityRef },
      status: "pending",
    });
    expect(await declareProtocolWorkspace(layout, input)).toEqual(pending);
    expect(() => resolveProtocolLayout(layout)).toThrow("protocol-enrollment-pending");
    await expect(
      acquireProtocolLayout(layout, null, { allowPending: true, expectedManagement: unmanaged }),
    ).rejects.toThrow("protocol-generation-conflict");
    await expect(acquireProtocolLayout(layout, null)).rejects.toThrow(
      "protocol-enrollment-pending",
    );
    (
      await acquireProtocolLayout(layout, null, {
        allowPending: true,
        expectedManagement: pending,
        nonBlocking: true,
      })
    ).release();
    const stateRoot = join(t.base, "external");
    mkdirSync(stateRoot);
    const active = {
      generation: 1,
      required: { authorityRef: input.authorityRef },
      schema: 1,
      stateRoot,
      workspaceId: "fixture",
    };
    writeFileSync(
      join(stateRoot, "workspace.json"),
      JSON.stringify({
        generation: 1,
        required: active.required,
        schema: 1,
        workspaceId: "fixture",
      }),
    );
    writeFileSync(join(layout.varDir, "work-protocol-fence.json"), JSON.stringify(active));
    expect(() => resolveProtocolManagement(layout)).toThrow("protocol-fenced");
    await expect(
      acquireProtocolLayout(layout, null, { allowPending: true, expectedManagement: pending }),
    ).rejects.toThrow("protocol-fenced");
    writeFileSync(join(layout.varDir, "work-protocol.json"), JSON.stringify(active));
    expect(resolveProtocolManagement(layout).status).toBe("active");
    await expect(
      acquireProtocolLayout(layout, null, { allowPending: true, expectedManagement: pending }),
    ).rejects.toThrow("protocol-generation-conflict");
  });
  it("does not initialize an absent configuration and rejects invalid config or a fence without fallback", () => {
    const test = makeFixture();
    const layout = loadLayout(test.root);
    expect(resolveProtocolLayout(layout)).toBeNull();
    expect(existsSync(layout.varDir)).toBe(false);
    mkdirSync(layout.varDir);
    writeFileSync(join(layout.varDir, "work-protocol.json"), "{broken");
    expect(() => resolveProtocolLayout(layout)).toThrow("protocol-unavailable");
    const other = makeFixture();
    const fenced = loadLayout(other.root);
    mkdirSync(fenced.varDir);
    writeFileSync(join(fenced.varDir, "work-protocol-fence.json"), "{}");
    expect(() => resolveProtocolLayout(fenced)).toThrow("protocol-fenced");
  });
  it("rejects source paths, alias descendants, and unrelated Git worktree ancestry", () => {
    const test = makeFixture();
    const layout = loadLayout(test.root);
    expect(() => validateProtocolRoot(layout, join(test.root, "state"))).toThrow(
      "protocol-root-excluded",
    );
    const alias = join(test.base, "alias");
    symlinkSync(test.root, alias);
    expect(() => validateProtocolRoot(layout, join(alias, "missing", "state"))).toThrow(
      "protocol-root-excluded",
    );
    const checkout = join(test.base, "other-source");
    mkdirSync(checkout);
    writeFileSync(join(checkout, ".git"), "gitdir: fixture-only\n");
    expect(() => validateProtocolRoot(layout, join(checkout, "state"))).toThrow(
      "protocol-root-excluded",
    );
    expect(validateProtocolRoot(layout, join(test.base, "external", "new"))).toBe(
      join(test.base, "external", "new"),
    );
  });
  it("allows concurrent shared legacy leases, excludes cutover, then fences a stale selection", async () => {
    const test = makeFixture();
    const layout = loadLayout(test.root);
    const first = await acquireProtocolLayout(layout, null);
    const second = await acquireProtocolLayout(layout, null, { nonBlocking: true });
    await expect(
      acquireProtocolLayout(layout, null, { exclusive: true, nonBlocking: true }),
    ).rejects.toBeInstanceOf(LockBusy);
    second.release();
    first.release();
    const exclusive = await acquireProtocolLayout(layout, null, {
      exclusive: true,
      nonBlocking: true,
    });
    await expect(acquireProtocolLayout(layout, null, { nonBlocking: true })).rejects.toBeInstanceOf(
      LockBusy,
    );
    const stateRoot = join(test.base, "state");
    mkdirSync(stateRoot);
    const config = { generation: 1, schema: 1, stateRoot, workspaceId: "fixture" };
    writeFileSync(
      join(stateRoot, "workspace.json"),
      JSON.stringify({ generation: 1, schema: 1, workspaceId: "fixture" }),
    );
    for (const file of ["work-protocol.json", "work-protocol-fence.json"]) {
      writeFileSync(join(layout.varDir, file), JSON.stringify(config));
    }
    exclusive.release();
    expect(() => checkProtocolLayout(layout, null)).toThrow("protocol-generation-conflict");
    await expect(acquireProtocolLayout(layout, null)).rejects.toThrow(
      "protocol-generation-conflict",
    );
    const active = resolveProtocolLayout(layout)!;
    expect(active.messagesDir).toBe(join(stateRoot, "transport", "messages"));
    (await acquireProtocolLayout(layout, active)).release();
  });
});
