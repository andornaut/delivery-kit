// Scoped read-only diagnostics. Native transport health never proves activation or handling.
import { performance } from "node:perf_hooks";

import { listingOrNull, recipientAvailability } from "../adapters/claude/agents.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import type { Layout } from "../layout.ts";
import { messageChannelStateDir } from "../messages/paths.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { resolveSelectedRoles, type RoleSelection } from "../registry/selection.ts";

export type DiagnosticStatus = "available" | "unavailable" | "unknown" | "held";
export type DiagnosticLayer = "adapter" | "service" | "frontend" | "bridge" | "channel";
export interface LayerDiagnostic {
  readonly status: DiagnosticStatus;
  readonly code: string;
}

export interface RoleDiagnosis {
  readonly role: string;
  readonly effective_harness: Harness;
  readonly native_id: string | null;
  readonly endpoint: {
    readonly path: string | null;
    readonly source: "option" | "environment" | "managed" | "agents_listing" | "skipped";
  };
  readonly channel_reference: {
    readonly path: string;
    readonly source: "message_channel_state_dir";
  } | null;
  readonly config_reference: { readonly path: string; readonly source: "registry" };
  readonly layers: Record<DiagnosticLayer, LayerDiagnostic>;
  readonly native_session: LayerDiagnostic;
  readonly activation: "unknown";
  readonly native_hold: "unknown";
  readonly failed_layer: DiagnosticLayer | null;
  readonly recovery_owner: "delivery-kit" | "native-codex" | "native-claude" | null;
  readonly supported_next_action:
    "verify_endpoint_configuration" | "inspect_native_session" | "native_owner_required" | "none";
}

export interface HarnessDiagnosis {
  readonly schema: 1;
  readonly roles: readonly RoleDiagnosis[];
}

function layer(status: DiagnosticStatus, code: string): LayerDiagnostic {
  return { code, status };
}

function initial(layout: Layout, registry: Registry, role: string): RoleDiagnosis {
  const harness = resolveHarness(registry, role);
  const id = resolveConversation(registry, role);
  return {
    activation: "unknown",
    channel_reference:
      harness === "claude" && id !== null
        ? { path: messageChannelStateDir(layout, id), source: "message_channel_state_dir" }
        : null,
    config_reference: { path: layout.registryFile, source: "registry" },
    effective_harness: harness,
    endpoint: { path: null, source: "skipped" },
    failed_layer: null,
    layers: {
      adapter: layer("unknown", "scope_not_active"),
      bridge: layer("unknown", "not_probed"),
      channel: layer("unknown", "not_probed"),
      frontend: layer("unknown", "not_probed"),
      service: layer("unknown", "not_probed"),
    },
    native_hold: "unknown",
    native_id: id,
    native_session: layer("unknown", "not_probed"),
    recovery_owner: null,
    role,
    supported_next_action: "none",
  };
}

function failure(
  row: RoleDiagnosis,
  failed: DiagnosticLayer,
  code: string,
  owner: RoleDiagnosis["recovery_owner"],
  action: RoleDiagnosis["supported_next_action"],
): RoleDiagnosis {
  return {
    ...row,
    failed_layer: failed,
    layers: { ...row.layers, [failed]: layer("unavailable", code) },
    recovery_owner: owner,
    supported_next_action: action,
  };
}

async function codex(env: NodeJS.ProcessEnv, row: RoleDiagnosis): Promise<RoleDiagnosis> {
  let endpoint: RoleDiagnosis["endpoint"];
  try {
    endpoint = resolveCodexControlSocket({ env });
  } catch {
    return failure(
      {
        ...row,
        endpoint: {
          path: null,
          source: Object.hasOwn(env, "CODEX_CONTROL_SOCKET") ? "environment" : "managed",
        },
      },
      "adapter",
      "invalid_endpoint_configuration",
      "delivery-kit",
      "verify_endpoint_configuration",
    );
  }
  const selected: RoleDiagnosis = {
    ...row,
    endpoint,
    layers: {
      ...row.layers,
      adapter: layer("available", "endpoint_resolved"),
      bridge: layer("unknown", "native_bridge_probe_unsupported"),
      channel: layer("unknown", "channel_probe_unsupported"),
    },
    recovery_owner: "native-codex",
    supported_next_action: "native_owner_required",
  };
  let client: RpcClient;
  try {
    client = await connectControl(performance.now() + 5000, endpoint.path!);
  } catch {
    return failure(
      selected,
      "service",
      "control_unavailable",
      "native-codex",
      "inspect_native_session",
    );
  }
  const connected = {
    ...selected,
    layers: { ...selected.layers, service: layer("available", "control_initialized") },
  };
  try {
    const result = await client.call("thread/read", {
      includeTurns: false,
      threadId: row.native_id,
    });
    const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
    if (thread === null || thread.id !== row.native_id) {
      return failure(
        connected,
        "frontend",
        "native_identity_unverified",
        "native-codex",
        "inspect_native_session",
      );
    }
    const status = isRecord(thread.status) ? thread.status.type : undefined;
    return {
      ...connected,
      layers: {
        ...connected.layers,
        frontend: layer("unknown", "frontend_probe_unsupported"),
      },
      native_session:
        status === "active" || status === "idle"
          ? layer("available", "exact_thread_observed")
          : layer("unknown", "native_state_unknown"),
    };
  } catch {
    return failure(
      connected,
      "frontend",
      "thread_read_unavailable",
      "native-codex",
      "inspect_native_session",
    );
  } finally {
    client.close();
  }
}

function claude(env: NodeJS.ProcessEnv, row: RoleDiagnosis): RoleDiagnosis {
  const entries = listingOrNull(env);
  const selected: RoleDiagnosis = {
    ...row,
    endpoint: { path: null, source: "agents_listing" },
    layers: {
      ...row.layers,
      adapter: layer("available", "agents_listing_supported"),
      bridge: layer("unknown", "native_bridge_probe_unsupported"),
      channel: layer("unknown", "channel_connection_unverified"),
      service: layer(
        entries === null ? "unavailable" : "available",
        entries === null ? "agents_listing_unavailable" : "agents_listing_observed",
      ),
    },
    recovery_owner: "native-claude",
    supported_next_action: "native_owner_required",
  };
  if (entries === null) {
    return failure(
      selected,
      "service",
      "agents_listing_unavailable",
      "native-claude",
      "inspect_native_session",
    );
  }
  const matches = entries.filter((entry) => entry.sessionId === row.native_id);
  if (matches.length === 0) {
    return failure(
      selected,
      "frontend",
      "exact_session_missing",
      "native-claude",
      "inspect_native_session",
    );
  }
  const availability = recipientAvailability(entries, row.native_id!);
  return {
    ...selected,
    layers: {
      ...selected.layers,
      frontend:
        availability.status === null
          ? layer("unknown", "session_reported_state_unknown")
          : layer("available", "exact_session_reported"),
    },
    native_session:
      availability.status === null
        ? layer("unknown", "session_reported_state_unknown")
        : layer("available", "exact_session_reported"),
  };
}

/** Resolve the entire scope before any probe. Unselected harnesses are never contacted. */
export async function diagnoseHarness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  scope: RoleSelection,
): Promise<HarnessDiagnosis> {
  const roles = resolveSelectedRoles(layout, registry, scope);
  const rows: RoleDiagnosis[] = [];
  for (const role of roles) {
    const row = initial(layout, registry, role);
    const record = registry.roles[role]!;
    if (
      record.ownership !== "active" ||
      record.phase === "held" ||
      record.phase === "source-held"
    ) {
      rows.push(row);
    } else if (row.native_id === null) {
      rows.push(
        failure(row, "adapter", "native_id_missing", "delivery-kit", "inspect_native_session"),
      );
    } else {
      // Serial bounded probes avoid opening a connection for every selected role at once.
      // eslint-disable-next-line no-await-in-loop
      rows.push(row.effective_harness === "codex" ? await codex(env, row) : claude(env, row));
    }
  }
  return { roles: rows, schema: 1 };
}
