// Endpoint selection is separate from socket availability, authentication and readiness.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface CodexControlSocketOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly controlSocket?: string;
}

export interface CodexControlSocketEndpoint {
  readonly path: string;
  readonly source: "option" | "environment" | "managed";
}

const INVALID_PATH = "Codex control socket must be a nonempty absolute path without NUL bytes";

class EndpointConfigurationError extends Error {
  readonly source: CodexControlSocketEndpoint["source"];

  constructor(source: CodexControlSocketEndpoint["source"]) {
    super(INVALID_PATH);
    this.name = "EndpointConfigurationError";
    this.source = source;
  }
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function endpoint(
  source: CodexControlSocketEndpoint["source"],
  path: unknown,
): CodexControlSocketEndpoint {
  if (!absolutePath(path)) {
    throw new EndpointConfigurationError(source);
  }
  return { path, source };
}

/** Select a path without reading it. Explicit invalid configuration never falls back. */
export function resolveCodexControlSocket(
  options: CodexControlSocketOptions = {},
): CodexControlSocketEndpoint {
  const env = options.env ?? process.env;
  if (options.controlSocket !== undefined) {
    return endpoint("option", options.controlSocket);
  }
  if (Object.hasOwn(env, "CODEX_CONTROL_SOCKET")) {
    return endpoint("environment", env.CODEX_CONTROL_SOCKET);
  }
  const home = options.home ?? homedir();
  if (!absolutePath(home)) {
    throw new EndpointConfigurationError("managed");
  }
  return endpoint("managed", join(home, ".codex/app-server-control/app-server-control.sock"));
}

export interface CodexEndpointContext {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly discovery?: "configured" | "managed";
}

export interface CodexEndpoint {
  readonly path: string | null;
  readonly source: "override" | "environment" | "managed-default" | "none";
  readonly status: "resolved" | "unconfigured" | "invalid";
  readonly reason: string | null;
}

const SOURCES = {
  environment: "environment",
  managed: "managed-default",
  option: "override",
} as const;

/** Configured-only callers preserve missing-configuration behaviour and their own diagnostics. */
export function resolveCodexEndpoint(
  context: CodexEndpointContext,
  override?: string,
): CodexEndpoint {
  if (
    context.discovery !== "managed" &&
    override === undefined &&
    !Object.hasOwn(context.env, "CODEX_CONTROL_SOCKET")
  ) {
    return { path: null, reason: null, source: "none", status: "unconfigured" };
  }
  try {
    const selected = resolveCodexControlSocket({
      env: context.env,
      ...(context.homeDirectory === undefined ? {} : { home: context.homeDirectory }),
      ...(override === undefined ? {} : { controlSocket: override }),
    });
    return {
      path: selected.path,
      reason: null,
      source: SOURCES[selected.source],
      status: "resolved",
    };
  } catch (error) {
    if (!(error instanceof EndpointConfigurationError)) {
      throw error;
    }
    return { path: null, reason: error.message, source: SOURCES[error.source], status: "invalid" };
  }
}
