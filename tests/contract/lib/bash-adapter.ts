// Bash 0.9.x adapter: renders delivery-kit.json plus the game-dev layout into bus.conf and
// runs bin/delivery-kit with --config and --state-dir. The state directory is the same
// var/games/<g>/bus/ path the Node implementation uses, so file assertions are shared.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Implementation } from "./adapter.ts";
import { KIT_ROOT, type Workspace, writeJson } from "./workspace.ts";

const ENTRY = join(KIT_ROOT, "bin", "delivery-kit");

function quote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function list(value: unknown, separator: string): unknown {
  return Array.isArray(value) ? value.join(separator) : value;
}

function resolveRole(ws: Workspace, role: unknown): string {
  if (typeof role !== "string") return String(role ?? "");
  return ws.conversation(role) ?? role;
}

/** Render bus.conf. `undefined` JSON values leave the key unset, as an omitted JSON field does. */
export function renderBusConf(ws: Workspace): string {
  const c = ws.config;
  const lines: string[] = [];
  const set = (key: string, value: unknown) => {
    if (value === undefined || ws.omit.includes(key)) return;
    lines.push(`${key}=${quote(value)}`);
  };
  set("REPO", ws.repo);
  set("MAIN", c.git?.main);
  set("REMOTE", c.git?.remote);
  set("GH_SLUG", c.git?.github);
  set("DEPARTURES", list(c.schedule?.departures, " "));
  set("BUS_TIMEZONE", c.schedule?.timezone);
  set("DEPLOY_SKIP_RE", c.deploy?.skipPattern);
  set("NODE_IMAGE", c.gate?.image);
  set("CONTAINER_PREFIX", "fixture-");
  set("CPUS", c.resources?.cpus);
  set("MAX_WORKERS", c.resources?.maxWorkers);
  set("LOAD_LIMIT", c.resources?.loadLimit);
  set("GATE_INSTALL", c.gate?.install);
  if (c.gate?.steps !== undefined && !ws.omit.includes("GATE_STEPS")) {
    const steps = Array.isArray(c.gate.steps) ? c.gate.steps : [];
    const rows = steps.map((step: { name?: unknown; run?: unknown }) => quote(`${step.name}|${step.run}`));
    lines.push(`GATE_STEPS=(${rows.join(" ")})`);
  }
  set("DEPLOY_MODE", c.deploy?.mode);
  set("CI_REQUIRED_NAMES", list(c.ci?.requiredNames, "|"));
  set("CI_POLL_SECONDS", c.ci?.pollSeconds);
  set("CI_TIMEOUT_SECONDS", c.ci?.timeoutSeconds);
  set("REPORT_PROJECT", c.reports?.project);
  if (c.reports?.scheduledTicks !== undefined) set("REPORT_SCHEDULED_TICKS", c.reports.scheduledTicks ? 1 : 0);
  if (c.reports?.recipient !== undefined) {
    const key = ws.registry().harness === "claude" ? "REPORT_SESSION_ID" : "REPORT_THREAD";
    set(key, resolveRole(ws, c.reports.recipient));
  }
  if (c.reports?.workerParents !== undefined) {
    const parents = Array.isArray(c.reports.workerParents) ? c.reports.workerParents : [c.reports.workerParents];
    set("WORKER_PARENT_THREADS", parents.map((p) => resolveRole(ws, p)).join(" "));
  }
  if (existsSync(ws.routeFile)) {
    set("MONITOR_ROUTE_FILE", ws.routeFile);
    const wake = ws.gameDevConfig().wakeMinutes;
    set("MONITOR_MINUTES", list(wake, " "));
  }
  if (existsSync(ws.processHealthFile)) set("PROCESS_HEALTH_FILE", ws.processHealthFile);
  set("CODEX_PYTHON", "/usr/bin/python3");
  set("CLAUDE_PYTHON", "/usr/bin/python3");
  return lines.join("\n") + "\n" + ws.legacyConf + (ws.legacyConf.endsWith("\n") || !ws.legacyConf ? "" : "\n");
}

function confPath(ws: Workspace): string {
  return join(ws.root, "bus.conf");
}

function env(ws: Workspace): Record<string, string> {
  return { ...ws.baseEnv(), PYTHONPATH: websocketShim(ws), ...ws.env };
}

function contextual(ws: Workspace, words: string[]): Command {
  writeFileSync(confPath(ws), renderBusConf(ws));
  writeJson(ws.configFile, ws.config);
  return {
    argv: ["bash", ENTRY, "--config", confPath(ws), "--state-dir", ws.state, ...words],
    cwd: ws.root,
    env: env(ws),
  };
}

export const bashImplementation: Implementation = {
  name: "bash",
  available: true,
  help: (ws, word) => ({ argv: ["bash", ENTRY, word], cwd: ws.root, env: env(ws) }),
  command: contextual,
  bare: (ws, words) => ({ argv: ["bash", ENTRY, ...words], cwd: ws.root, env: env(ws) }),
  checkConfig: (ws) => contextual(ws, ["check-config"]),
  status: (ws) => contextual(ws, ["status"]),
  resourceReport: (ws) => contextual(ws, ["resource-report"]),
  request: (ws, id) => contextual(ws, ["request-once", "--request-id", id]),
  monitorSnapshot: (ws, args) => contextual(ws, ["monitor-snapshot", ...args]),
  monitorAck: (ws, args) => contextual(ws, ["monitor-ack", ...args]),
  run: (ws) => contextual(ws, ["run"]),
  channel: (ws, args) => ({
    argv: ["/usr/bin/python3", join(KIT_ROOT, "libexec", "claude_channel.py"), ...args],
    cwd: ws.root,
    env: env(ws),
  }),
};

// The 0.9 Codex helpers import `websocket` (websocket-client), which the offline image lacks.
// This minimal RFC 6455 client is generated into scratch for the Bash adapter only; it speaks
// to the fake control socket exactly as websocket-client would over the given Unix socket.
const WEBSOCKET_SHIM = String.raw`import base64, json, os, struct


class WebSocketException(Exception):
    pass


class _Connection:
    def __init__(self, sock):
        self.sock = sock
        self.buffer = b''

    def settimeout(self, value):
        self.sock.settimeout(value)

    def _read(self, size):
        while len(self.buffer) < size:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WebSocketException('connection closed')
            self.buffer += chunk
        data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data

    def send(self, text):
        payload = text.encode('utf-8')
        mask = os.urandom(4)
        header = bytes([0x81])
        if len(payload) < 126:
            header += bytes([0x80 | len(payload)])
        elif len(payload) < 65536:
            header += bytes([0x80 | 126]) + struct.pack('>H', len(payload))
        else:
            header += bytes([0x80 | 127]) + struct.pack('>Q', len(payload))
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def recv(self):
        while True:
            first, second = self._read(2)
            length = second & 0x7f
            if length == 126:
                length = struct.unpack('>H', self._read(2))[0]
            elif length == 127:
                length = struct.unpack('>Q', self._read(8))[0]
            payload = self._read(length)
            opcode = first & 0x0f
            if opcode == 8:
                raise WebSocketException('connection closed')
            if opcode in (1, 2):
                return payload.decode('utf-8')

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def create_connection(url, socket=None, timeout=None, **kwargs):
    if timeout is not None:
        socket.settimeout(timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    socket.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                    'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    response = b''
    while b'\r\n\r\n' not in response:
        chunk = socket.recv(4096)
        if not chunk:
            raise WebSocketException('handshake failed')
        response += chunk
    head, rest = response.split(b'\r\n\r\n', 1)
    if b' 101 ' not in head.split(b'\r\n', 1)[0]:
        raise WebSocketException('handshake rejected')
    connection = _Connection(socket)
    connection.buffer = rest
    return connection
`;

function websocketShim(ws: Workspace): string {
  const dir = join(ws.root, "pyshim");
  if (!existsSync(join(dir, "websocket.py"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "websocket.py"), WEBSOCKET_SHIM);
  }
  return dir;
}
