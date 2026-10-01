import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearCache as clearDiscoveryFileCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import {
  type Component,
  Key,
  matchesKey,
  padding,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// `/mcps` — session-only on/off switch for MCP servers.
//
// Why tool activation and not config: turning a server "off" for the current
// session must not touch `mcp.json` (that is `/mcp disable`, and it persists).
// The session-scoped lever for a running server is the active tool set:
// `pi.getActiveTools()` returns `session.getEnabledToolNames()` — top-level tools
// plus everything mounted under `xd://` — and `pi.setActiveTools(names)` replaces
// that whole set. Dropping a server's `mcp__<server>_*` names removes them from the
// model's contract and from the `xd://` device catalog while leaving the MCP
// connection alone, so re-enabling is instant and needs no reconnect.
//
// A server disabled in config (`enabled: false` or `disabledServers`) has no
// connection and no tools to activate, so switching it on goes through the
// session's own `MCPManager` instead: host discovery supplies the definition,
// the manager connects it and hands its tools to the session exactly as it does
// at startup, and switching it off disconnects it again. Still nothing is written
// to `mcp.json`.
//
// Every apply passes the FULL desired name list, never an incremental diff, so a
// stale snapshot can never silently demote unrelated tools.
//
// Why a hand-rolled overlay instead of `ctx.ui.select()`: the built-in selector
// routes space into its own search filter, so space-to-toggle is impossible there,
// and its two-line option rendering (label + description) shifts the list layout as
// the cursor moves. A `Component` under `ctx.ui.custom()` owns both.

/**
 * Custom session entry holding this session's switches. The type string predates
 * the `connected` field and stays as is so sessions saved by 1.0.x still restore.
 */
const STATE_ENTRY_TYPE = "io.xoi.mcps.disabled-servers";
const MCP_PREFIX = "mcp__";
const MAX_VISIBLE_ROWS = 18;
/**
 * Cap on waiting for the session to register a newly connected server's tools:
 * `waitForStartup` also waits on unrelated servers that are still starting.
 */
const TOOL_REFRESH_DRAIN_MS = 5_000;

// ---------------------------------------------------------------------------
// Minimal structural types. `@oh-my-pi/pi-coding-agent` is not resolvable outside
// the monorepo, so everything the extension touches is described locally.
// ---------------------------------------------------------------------------

interface ToolInfoLike {
  name: string;
  sourceInfo?: { source?: string };
}

interface BoxGlyphs {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeLeft: string;
  teeRight: string;
}

interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
  boxRound: BoxGlyphs;
}

interface TuiLike {
  setFocus(component: unknown): void;
  requestRender(): void;
}

interface UiLike {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: TuiLike, theme: ThemeLike, keybindings: unknown, done: (result: T) => void) => Component,
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
  ): Promise<T>;
}

interface CtxLike {
  hasUI: boolean;
  mode?: string;
  cwd: string;
  ui: UiLike;
  /** The agent this session runs: `kind` is `"main"` for the top-level session, `"sub"` for any spawned one. */
  agent?: { kind?: string };
  sessionManager: {
    getBranch(): Iterable<{ type?: string; customType?: string; data?: unknown }>;
  };
}

/** Connect-time server config (`MCPServerConfig`, `mcp/types.ts`). */
type ConnectConfig = Record<string, unknown>;

/** The slice of the session's `MCPManager` used to run config-off servers. */
interface McpManagerLike {
  getAllServerNames(): string[];
  getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
  connectServers(
    configs: Record<string, ConnectConfig>,
    sources: Record<string, unknown>,
    onStatus: undefined,
    startupTimeoutMs: number,
  ): Promise<{ errors: Map<string, string> }>;
  waitForStartup(timeoutMs: number): Promise<unknown>;
  disconnectServer(name: string): Promise<void>;
}

/** Canonical server record from host discovery (`MCPServer`, `capability/mcp.ts`). */
interface DiscoveredServer {
  name: string;
  transport?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envPolicy?: string;
  envLiteralKeys?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  headerPolicy?: string;
  timeout?: number;
  requestIdFormat?: string;
  instructions?: boolean;
  auth?: unknown;
  oauth?: unknown;
  _source: unknown;
}

/** How a configured server presents in the session right now. */
type ServerState =
  | "on" // has tools, active
  | "off" // has tools, switched off in this session
  | "session-on" // disabled in config, switched on (connected) for this session
  | "config-off" // suppressed by config (`enabled: false` or `disabledServers`), not connected
  | "not-running"; // enabled in config but contributed no tools

interface ServerRow {
  name: string;
  /** Registered `mcp__…` tool names owned by this server; empty when it never connected. */
  tools: string[];
  state: ServerState;
  /** Suppressed by config: switching it on connects it for this session, switching it off disconnects it. */
  configOff: boolean;
  /** Best-effort failure text recovered from the session log. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Active profile's agent directory, mirroring OMP's own profile resolution. */
function agentDir(): string {
  const explicit = process.env.PI_CODING_AGENT_DIR;
  if (explicit) return explicit;
  const home = homedir();
  const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
  return profile ? join(home, ".omp", "profiles", profile, "agent") : join(home, ".omp", "agent");
}


// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface McpConfig {
  /** Configured server name -> whether its own entry opts out. First source wins. */
  entries: Map<string, { enabled: boolean }>;
  /** Active-profile user denylist: always wins. */
  denied: Set<string>;
  /** Active-profile user allowlist: overrides a source's `enabled: false`. */
  forced: Set<string>;
}

/** Mirror of `sanitizeMCPToolNamePart`: how a server name becomes a tool-name part. */
function sanitizePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The string members of a JSON array value; anything else is empty. */
function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((n): n is string => typeof n === "string") : []);
}

/** Cached for the per-turn reconcile, which must not re-read files; `/mcps` rescans on open. */
const configCache = new Map<string, McpConfig>();

/**
 * Read the MCP configuration OMP discovers, in its precedence order.
 *
 * Two reasons the extension parses these files itself rather than ask the
 * runtime. First, `getAllTools()` reports MCP tools with a synthetic `sourceInfo`
 * (`{ source: "mcp", path: "<mcp:name>" }`) carrying no server identity, and
 * `mcp__<server>_<tool>` does not split unambiguously — `mcp__chrome_devtools_list`
 * could be `chrome`/`devtools_list` or `chrome-devtools`/`list`. Second, a server
 * suppressed by `enabled: false` or `disabledServers` never reaches the MCP manager
 * at all, so no live runtime state lists it. The scan is synchronous and cheap
 * enough to back the per-turn reconcile; connecting a config-off server needs its
 * full definition, which comes from host discovery instead (`discoverDefinitions`).
 */
function readMcpConfig(cwd: string): McpConfig {
  const cached = configCache.get(cwd);
  if (cached) return cached;

  const home = homedir();
  const agent = agentDir();
  const userPath = join(agent, "mcp.json");

  // [path, key holding the server map] in OMP's discovery precedence order.
  const sources: [string, string][] = [
    [join(cwd, ".omp", "mcp.json"), "mcpServers"],
    [join(cwd, ".omp", ".mcp.json"), "mcpServers"],
    [userPath, "mcpServers"],
    [join(agent, ".mcp.json"), "mcpServers"],
    [join(home, ".claude.json"), "mcpServers"],
    [join(home, ".claude", "mcp.json"), "mcpServers"],
    [join(cwd, ".claude", ".mcp.json"), "mcpServers"],
    [join(cwd, ".claude", "mcp.json"), "mcpServers"],
    [join(home, ".gemini", "settings.json"), "mcpServers"],
    [join(cwd, ".gemini", "settings.json"), "mcpServers"],
    [join(home, ".config", "opencode", "opencode.json"), "mcp"],
    [join(cwd, "opencode.json"), "mcp"],
    [join(home, ".cursor", "mcp.json"), "mcpServers"],
    [join(cwd, ".cursor", "mcp.json"), "mcpServers"],
    [join(cwd, ".vscode", "mcp.json"), "servers"],
    [join(cwd, "mcp.json"), "mcpServers"],
    [join(cwd, ".mcp.json"), "mcpServers"],
  ];

  const readJson = (path: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined; // absent or malformed: nothing to learn from it
    }
  };

  const entries = new Map<string, { enabled: boolean }>();
  for (const [path, key] of sources) {
    const map = readJson(path)?.[key];
    if (!map || typeof map !== "object") continue;
    for (const [name, value] of Object.entries(map)) {
      if (entries.has(name)) continue; // first source wins, as in OMP dedup
      const enabled = !(value && typeof value === "object" && "enabled" in value && value.enabled === false);
      entries.set(name, { enabled });
    }
  }

  const user = readJson(userPath);
  const config: McpConfig = {
    entries,
    denied: stringSet(user?.disabledServers),
    forced: stringSet(user?.enabledServers),
  };
  configCache.set(cwd, config);
  return config;
}

/** Effective config verdict: denylist wins, then `enabled: false` unless force-enabled. */
function configEnabled(config: McpConfig, name: string): boolean {
  if (config.denied.has(name)) return false;
  return config.entries.get(name)?.enabled !== false || config.forced.has(name);
}

/**
 * Every server definition host discovery finds, by name, config-off ones
 * included. `loadAllMCPConfigs` drops those through its `suppress` hook, so this
 * calls the capability loader underneath it without one. `all` is in precedence
 * order, so the first record per name is the one that owns the name.
 */
async function discoverDefinitions(cwd: string): Promise<Map<string, DiscoveredServer>> {
  // Discovery caches file reads for the whole process; drop them so an edit made
  // since startup is seen, as the modal's own rescan sees it (`/mcp reload` does the same).
  clearDiscoveryFileCache();
  const result = (await loadCapability("mcps", { cwd })) as unknown as { all: DiscoveredServer[] };
  const byName = new Map<string, DiscoveredServer>();
  for (const server of result.all) if (!byName.has(server.name)) byName.set(server.name, server);
  return byName;
}

/**
 * A discovery record as a connect config. Mirrors the host's private
 * `convertToLegacyConfig` (`mcp/config.ts`) except that `enabled` is left out:
 * the server is being switched on.
 */
function toConnectConfig(server: DiscoveredServer): ConnectConfig {
  const type = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
  const config: ConnectConfig = {
    type,
    timeout: server.timeout,
    requestIdFormat: server.requestIdFormat,
    instructions: server.instructions,
    auth: server.auth,
    oauth: server.oauth,
  };
  if (type === "stdio") {
    config.command = server.command ?? "";
    if (server.args) config.args = server.args;
    if (server.env) config.env = server.env;
    if (server.envPolicy) config.envPolicy = server.envPolicy;
    if (server.envLiteralKeys) config.envLiteralKeys = server.envLiteralKeys;
    if (server.cwd) config.cwd = server.cwd;
  } else {
    config.url = server.url ?? "";
    if (server.headers) config.headers = server.headers;
    if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
  }
  return config;
}

/** The top-level session's MCP manager (subagents share it); absent when MCP is off. */
function mcpManager(): McpManagerLike | undefined {
  return MCPManager.instance() as unknown as McpManagerLike | undefined;
}

// ---------------------------------------------------------------------------
// Failure text
// ---------------------------------------------------------------------------

/**
 * Last logged connect failure per server, from this process's own log file.
 *
 * The runtime records `{ type: "failed", serverName, error }` on an internal event
 * channel that carries no extension event, so the log is the only place an
 * extension can recover *why* a server is dead. Detection never depends on it —
 * "enabled in config, zero registered tools" is the signal; this only supplies the
 * message, and a fast failure inside the 250 ms startup race logs nothing at all.
 */
function readServerErrors(): Map<string, string> {
  const errors = new Map<string, string>();
  const dir = join(agentDir(), "..", "logs");
  const suffix = `.${process.pid}.log`;
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(suffix));
  } catch {
    return errors;
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      // Cheap prefilter: the vast majority of lines are not MCP failures.
      if (!line.includes('"mcp:') || !line.includes('"level":"error"')) continue;
      let record: { path?: unknown; error?: unknown };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const path = typeof record.path === "string" ? record.path : undefined;
      if (!path?.startsWith("mcp:")) continue;
      let raw: string | undefined;
      if (typeof record.error === "string") raw = record.error;
      else if (record.error && typeof record.error === "object" && "message" in record.error) {
        const message = record.error.message;
        if (typeof message === "string") raw = message;
      }
      if (!raw) continue;
      errors.set(path.slice(4), summarizeError(raw));
    }
  }
  return errors;
}

/** Collapse a transport error blob to one short human line. */
function summarizeError(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  // `HTTP 401: {"jsonrpc":…,"error":{…,"message":"Missing Bearer token"}} [WWW-Authenticate: …]`
  const status = /^HTTP (\d{3})/.exec(oneLine)?.[1];
  const message = /"message"\s*:\s*"([^"]+)"/.exec(oneLine)?.[1];
  if (status && message) return `HTTP ${status}: ${message}`;
  if (status) return `HTTP ${status}`;
  return oneLine.length > 70 ? `${oneLine.slice(0, 69)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Group registered MCP tools by owning server.
 *
 * Longest configured-name prefix wins, so `chrome-devtools` beats a hypothetical
 * `chrome`. Tools matching no configured name are grouped by their first segment.
 */
function groupToolsByServer(allTools: ToolInfoLike[], config: McpConfig): Map<string, string[]> {
  const known: [string, string][] = [];
  const seen = new Set<string>();
  for (const name of config.entries.keys()) {
    const part = sanitizePart(name);
    if (part.length === 0 || seen.has(part)) continue;
    seen.add(part);
    known.push([part, name]);
  }
  known.sort((a, b) => b[0].length - a[0].length);

  const groups = new Map<string, string[]>();
  for (const tool of allTools) {
    if (tool.sourceInfo?.source !== "mcp" && !tool.name.startsWith(MCP_PREFIX)) continue;
    const rest = tool.name.slice(MCP_PREFIX.length);
    let display: string | undefined;
    for (const [part, name] of known) {
      if (rest === part || rest.startsWith(`${part}_`)) {
        display = name;
        break;
      }
    }
    display ??= rest.split("_")[0] || rest;
    const bucket = groups.get(display);
    if (bucket) bucket.push(tool.name);
    else groups.set(display, [tool.name]);
  }
  return groups;
}

/**
 * Every server worth showing: the union of the configuration and whatever actually
 * registered tools, so a config-suppressed server and a server that failed to
 * initialize both stay visible instead of silently vanishing.
 */
function buildRows(
  allTools: ToolInfoLike[],
  config: McpConfig,
  sessionDisabled: ReadonlySet<string>,
  sessionConnected: ReadonlySet<string>,
  errors: Map<string, string>,
): ServerRow[] {
  const groups = groupToolsByServer(allTools, config);
  const names = new Set<string>([...config.entries.keys(), ...groups.keys()]);
  const rows: ServerRow[] = [];
  for (const name of names) {
    const tools = groups.get(name) ?? [];
    const configOff = !configEnabled(config, name);
    // A config-off server switched on this session counts as running before its tools land.
    const running = tools.length > 0 || (configOff && sessionConnected.has(name));
    let state: ServerState;
    if (!running) state = configOff ? "config-off" : "not-running";
    else if (sessionDisabled.has(name)) state = "off";
    else state = configOff ? "session-on" : "on";
    rows.push({ name, tools, state, configOff, error: state === "not-running" ? errors.get(name) : undefined });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A running server switches through its tool set, a config-off one through a
 * connect, which needs the session's MCP manager. An enabled server that is not
 * running has nothing to switch, and an extension cannot repair its connect.
 */
function isToggleable(row: ServerRow, canConnect: boolean): boolean {
  if (row.state === "config-off") return canConnect;
  return row.state !== "not-running";
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

type ActionId = "apply" | "all-on" | "all-off" | "cancel";

const ACTIONS: { id: ActionId; label: string }[] = [
  { id: "apply", label: "Apply changes" },
  { id: "all-on", label: "Enable all" },
  { id: "all-off", label: "Disable all" },
  { id: "cancel", label: "Cancel" },
];

interface ModalResult {
  /** Every server left switched off, config-off ones included. */
  off: string[];
}

/** What one `/mcps` apply changed, for the confirmation line. */
interface ApplyReport {
  off: [string, number][];
  on: [string, number][];
  /** `on` servers came back as top-level tools (see `summarize`). */
  pinned: boolean;
  connected: [string, number][];
  disconnected: string[];
  failed: [string, string][];
}

/** Pad or truncate a possibly ANSI-styled string to exactly `width` columns. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const shown = visibleWidth(text);
  if (shown === width) return text;
  if (shown < width) return text + padding(width - shown);
  const cut = truncateToWidth(text, width);
  const cutWidth = visibleWidth(cut);
  return cutWidth < width ? cut + padding(width - cutWidth) : cut;
}

/**
 * Keyboard-driven server list.
 *
 * Every row is exactly one terminal line and the status column starts at a fixed
 * offset, so moving the cursor never reflows the list — that is the whole reason
 * this is a component rather than a `select()` with `description`s.
 */
class McpModal implements Component {
  focused = false;
  #rows: ServerRow[];
  #canConnect: boolean;
  /** Names drafted off: switched off this session, or disabled in config and not connected. */
  #draft: Set<string>;
  #done: (result: ModalResult | undefined) => void;
  #theme: ThemeLike;
  #index = 0;
  #scroll = 0;
  /** Row count including the actions appended after the servers. */
  #total: number;
  #nameWidth: number;

  constructor(
    rows: ServerRow[],
    disabled: ReadonlySet<string>,
    canConnect: boolean,
    theme: ThemeLike,
    done: (r: ModalResult | undefined) => void,
  ) {
    this.#rows = rows;
    this.#canConnect = canConnect;
    this.#draft = new Set([...disabled, ...rows.filter(r => r.state === "config-off").map(r => r.name)]);
    this.#theme = theme;
    this.#done = done;
    this.#total = rows.length + ACTIONS.length;
    this.#nameWidth = Math.min(28, Math.max(8, ...rows.map(r => r.name.length)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.#done(undefined);
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.#move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.#move(1);
      return;
    }
    // Space and Enter are the same gesture: toggle a server, or run an action row.
    if (matchesKey(data, Key.space) || data === " " || matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      this.#activate();
      return;
    }
  }

  render(width: number): readonly string[] {
    const box = this.#theme.boxRound;
    const bar = this.#theme.fg("border", box.vertical);
    const inner = Math.max(0, width - 4);
    const rule = (left: string, right: string) =>
      this.#theme.fg("border", left + box.horizontal.repeat(Math.max(0, width - 2)) + right);

    const lines: string[] = [];
    lines.push(this.#titleRow(width));

    const visible = Math.min(MAX_VISIBLE_ROWS, this.#total);
    if (this.#index < this.#scroll) this.#scroll = this.#index;
    if (this.#index >= this.#scroll + visible) this.#scroll = this.#index - visible + 1;

    for (let i = this.#scroll; i < Math.min(this.#total, this.#scroll + visible); i++) {
      if (i === this.#rows.length) lines.push(rule(box.teeRight, box.teeLeft));
      lines.push(`${bar} ${fit(this.#renderRow(i), inner)} ${bar}`);
    }

    lines.push(rule(box.teeRight, box.teeLeft));
    lines.push(`${bar} ${fit(this.#theme.fg("dim", this.#footer()), inner)} ${bar}`);
    lines.push(rule(box.bottomLeft, box.bottomRight));
    return lines;
  }

  invalidate(): void {}

  #titleRow(width: number): string {
    const box = this.#theme.boxRound;
    const title = " MCP servers — this session only ";
    const inner = Math.max(0, width - 2);
    const shown = truncateToWidth(title, Math.max(0, inner - 2));
    const fill = Math.max(0, inner - 1 - visibleWidth(shown));
    return (
      this.#theme.fg("border", box.topLeft + box.horizontal) +
      this.#theme.bold(this.#theme.fg("accent", shown)) +
      this.#theme.fg("border", box.horizontal.repeat(fill) + box.topRight)
    );
  }

  #footer(): string {
    const row = this.#rows[this.#index];
    if (row?.state === "not-running") return "no tools registered — nothing to switch this session";
    if (row?.configOff) {
      if (!isToggleable(row, this.#canConnect)) return "disabled in config — this session has no MCP manager to connect it";
      return this.#draft.has(row.name)
        ? "disabled in config — switch on to connect it for this session only"
        : "on for this session only — switch off to disconnect it";
    }
    return "space/enter toggle · ↑↓ move · esc cancel";
  }

  #renderRow(i: number): string {
    const t = this.#theme;
    const cursor = i === this.#index ? t.fg("accent", "▶ ") : "  ";

    const action = ACTIONS[i - this.#rows.length];
    if (action) {
      const label = i === this.#index ? t.fg("accent", action.label) : t.fg("text", action.label);
      return `${cursor}  ${label}`;
    }

    const row = this.#rows[i]!;
    const off = this.#draft.has(row.name);
    const toggleable = isToggleable(row, this.#canConnect);
    const marker = toggleable ? (off ? t.fg("dim", "☐") : t.fg("accent", "☑")) : t.fg("dim", "⚠");
    const name = fit(toggleable && !off ? t.fg("text", row.name) : t.fg("dim", row.name), this.#nameWidth);

    // Status lives on THIS line at a fixed column, so cursor movement never
    // changes any row's height and the list cannot shift under the cursor.
    return `${cursor}${marker} ${name}  ${t.fg("dim", this.#status(row, off))}`;
  }

  /** Status for the drafted state; config-off rows also say what Apply will do to the connection. */
  #status(row: ServerRow, off: boolean): string {
    if (row.state === "not-running") return row.error ? `enabled, not running — ${row.error}` : "enabled, not running";
    const count = row.tools.length;
    const tools = count > 0 ? `${count} tool${count === 1 ? "" : "s"}` : "no tools yet";
    if (!row.configOff) return `${off ? "disabled" : "enabled"} · ${tools}`;
    const running = row.state !== "config-off";
    if (off) return running ? "disabled in config · disconnects on apply" : "disabled in config";
    return running ? `enabled this session · ${tools}` : "enabled this session · connects on apply";
  }

  #move(delta: number): void {
    this.#index = Math.min(this.#total - 1, Math.max(0, this.#index + delta));
  }

  #activate(): void {
    const action = ACTIONS[this.#index - this.#rows.length];
    if (!action) {
      const row = this.#rows[this.#index];
      if (!row || !isToggleable(row, this.#canConnect)) return; // informational row
      if (this.#draft.has(row.name)) this.#draft.delete(row.name);
      else this.#draft.add(row.name);
      return;
    }
    switch (action.id) {
      case "apply":
        this.#done({ off: [...this.#draft] });
        return;
      case "all-on":
        this.#draft.clear();
        // Without a manager a config-off server cannot come up, so it stays drafted off.
        if (!this.#canConnect) for (const row of this.#rows) if (row.state === "config-off") this.#draft.add(row.name);
        return;
      case "all-off":
        for (const row of this.#rows) if (isToggleable(row, this.#canConnect)) this.#draft.add(row.name);
        return;
      case "cancel":
        this.#done(undefined);
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function mcps(pi: ExtensionAPI): void {
  /** Servers the user switched off in this session. */
  const disabled = new Set<string>();
  /**
   * Config-off servers the user switched on in this session. Only servers this
   * extension connected (or adopted from the modal), so restoring a branch tears
   * down nothing else: a subagent shares its parent's manager.
   */
  const connected = new Set<string>();
  /** Connects in flight, so a turn never starts a second one for the same server. */
  const connecting = new Set<string>();
  /**
   * Exact tool names removed per server, so re-enabling restores only what this
   * extension took away — never a tool some other feature (`/tools`, `--tools`,
   * plan mode) deliberately left inactive.
   */
  const removed = new Map<string, Set<string>>();
  /**
   * `apply` reads the active set and writes it back after an await; two
   * interleaved runs could undo each other's restorations, so they queue.
   */
  let applying: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = applying.then(task);
    applying = run.catch(() => undefined);
    return run;
  };

  const toolGroups = (ctx: CtxLike): Map<string, string[]> =>
    groupToolsByServer(pi.getAllTools() as unknown as ToolInfoLike[], readMcpConfig(ctx.cwd));

  const persist = (): void => {
    pi.appendEntry(STATE_ENTRY_TYPE, { servers: [...disabled], connected: [...connected] });
  };

  /** Latest switches persisted on the current branch; `servers` holds the switched-off ones. */
  const readState = (ctx: CtxLike): { disabled: Set<string>; connected: Set<string> } => {
    let data: unknown;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) data = entry.data;
    }
    const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    return { disabled: stringSet(record.servers), connected: stringSet(record.connected) };
  };

  /**
   * Bring the active tool set in line with `nextDisabled` and adopt it as the new
   * state. Always hands `setActiveTools` the complete desired name list.
   *
   * `gone` holds the tools of servers just disconnected. Each disconnect queued a
   * session tool refresh that re-enables every MCP tool, switched-off servers'
   * included, and this snapshot may predate it. So the list is written back
   * whenever `gone` is non-empty: writes queue behind that refresh, which keeps
   * the switched-off servers off once it lands.
   */
  const apply = async (
    ctx: CtxLike,
    nextDisabled: ReadonlySet<string>,
    gone: ReadonlySet<string> = new Set(),
  ): Promise<{ off: [string, number][]; on: [string, number][]; pinned: boolean }> => {
    const enabled = pi.getActiveTools();
    const enabledSet = new Set(enabled);
    const drop = new Set<string>(gone);
    const restore: string[] = [];
    const off: [string, number][] = [];
    const on: [string, number][] = [];

    for (const [name, tools] of toolGroups(ctx)) {
      if (nextDisabled.has(name)) {
        const taken = tools.filter(tool => enabledSet.has(tool));
        if (taken.length === 0) continue;
        for (const tool of taken) drop.add(tool);
        const record = removed.get(name) ?? new Set<string>();
        for (const tool of taken) record.add(tool);
        removed.set(name, record);
        // Re-dropping tools a refresh brought back is upkeep, not a change to report.
        if (!disabled.has(name)) off.push([name, taken.length]);
      } else {
        const record = removed.get(name);
        if (!record) continue;
        removed.delete(name);
        // Only names this extension removed, that still exist and are not active.
        const back = tools.filter(tool => record.has(tool) && !enabledSet.has(tool) && !gone.has(tool));
        restore.push(...back);
        // A tools refresh (after a connect or disconnect) may have re-enabled them already.
        const count = back.length + tools.filter(tool => enabledSet.has(tool)).length;
        if (count > 0) on.push([name, count]);
      }
    }

    if (drop.size > 0 || restore.length > 0) {
      // Preserve existing order (built-ins first) and append restorations.
      await pi.setActiveTools(enabled.filter(name => !drop.has(name)).concat(restore));
    }

    disabled.clear();
    for (const name of nextDisabled) disabled.add(name);
    // Restored names land pinned top-level unless a queued tools refresh remounted them first.
    return { off, on, pinned: restore.length > 0 && gone.size === 0 };
  };

  /**
   * Re-assert the switched-off servers.
   *
   * Interactive MCP discovery finishes after `session_start`, and reconnects and
   * `tools/list_changed` each re-register a server's tools through
   * `refreshMCPTools`, which enables everything it binds. Without this the model
   * would silently get a switched-off server back mid-session.
   */
  const reconcile = async (ctx: CtxLike): Promise<void> => {
    if (disabled.size === 0) return;
    const enabledSet = new Set(pi.getActiveTools());
    let leaked = false;
    for (const [name, tools] of toolGroups(ctx)) {
      if (disabled.has(name) && tools.some(tool => enabledSet.has(tool))) leaked = true;
    }
    if (leaked) await apply(ctx, new Set(disabled));
  };

  /**
   * Connect config-off servers through the session's MCP manager, then wait until
   * every handshake has settled and the session has registered the new tools.
   * Returns the failure text of each server that did not come up.
   */
  const connectNow = async (cwd: string, names: readonly string[]): Promise<Map<string, string>> => {
    const failed = new Map<string, string>();
    if (names.length === 0) return failed;
    const manager = mcpManager();
    if (!manager) {
      for (const name of names) failed.set(name, "no MCP manager in this session");
      return failed;
    }
    const definitions = await discoverDefinitions(cwd);
    const configs: Record<string, ConnectConfig> = {};
    const sources: Record<string, unknown> = {};
    for (const name of names) {
      const server = definitions.get(name);
      if (!server) {
        failed.set(name, "MCP discovery found no definition");
        continue;
      }
      configs[name] = toConnectConfig(server);
      sources[name] = server._source;
    }
    const starting = Object.keys(configs);
    if (starting.length === 0) return failed;
    for (const name of starting) connecting.add(name);
    try {
      // 0 waits for each handshake to settle rather than racing the 250 ms startup window, so the result is final.
      const { errors } = await manager.connectServers(configs, sources, undefined, 0);
      for (const [name, error] of errors) failed.set(name, summarizeError(error));
      // New tools reach the session through the manager's tools-changed callback,
      // which `waitForStartup` drains; only then does the active set list them.
      await manager.waitForStartup(TOOL_REFRESH_DRAIN_MS);
    } finally {
      for (const name of starting) connecting.delete(name);
    }
    return failed;
  };

  /**
   * Restore or reconnect in the background: a server can take seconds to start,
   * and neither session start nor a turn should wait on it. Its tools land through
   * the manager like any slow server's, and the switched-off set is re-asserted after.
   */
  const connectLater = (ctx: CtxLike, names: string[]): void => {
    void (async () => {
      const failed = await connectNow(ctx.cwd, names);
      const lost: string[] = [];
      for (const [name, error] of failed) {
        // A server switched off meanwhile had its connect cancelled on purpose.
        if (connected.delete(name)) lost.push(`${name} — ${error}`);
      }
      if (lost.length > 0) {
        persist();
        ctx.ui.notify(`MCP could not reconnect ${lost.join(", ")}; switched off for this session`, "warning");
      }
      await serialized(() => apply(ctx, new Set(disabled)));
    })().catch(error => {
      ctx.ui.notify(`/mcps: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  };

  /** Tear down a config-off server this session switched on; config stays the authority after. */
  const disconnect = async (name: string): Promise<void> => {
    connected.delete(name);
    removed.delete(name);
    await mcpManager()?.disconnectServer(name);
  };

  /**
   * Re-apply the current branch's switches on session start (resume), session
   * switch (`/new`, `/resume`, fork), branch, and tree navigation. Disconnects run
   * inline; connects run in the background so neither startup nor navigation
   * waits on a server.
   *
   * Subagents skip this, and without loaded state every other path is a no-op for
   * them. They share the top-level session's MCP manager, and a `/tan` clone's
   * session is a fork of the parent's: revived, it would replay the parent's
   * switches as of the fork on that shared manager and reconnect a server the
   * parent has since switched off.
   */
  const restore = async (ctx: CtxLike): Promise<void> => {
    if (ctx.agent?.kind === "sub") return;
    const state = readState(ctx);
    const groups = toolGroups(ctx);
    const gone = new Set<string>();
    for (const name of [...connected]) {
      if (state.connected.has(name)) continue;
      for (const tool of groups.get(name) ?? []) gone.add(tool);
      await disconnect(name);
    }
    for (const name of state.connected) connected.add(name);
    await serialized(() => apply(ctx, state.disabled, gone));
    const manager = mcpManager();
    const missing = [...connected].filter(
      name => !connecting.has(name) && manager?.getConnectionStatus(name) === "disconnected",
    );
    if (missing.length > 0) connectLater(ctx, missing);
  };

  /**
   * `/mcp reload` and `/reload-plugins` reconnect the manager from config alone,
   * which forgets every server this session switched on; bring those back. A
   * server the manager still knows (connected, retrying, or failed) is its to handle.
   */
  const reconnectDropped = (ctx: CtxLike): void => {
    const manager = mcpManager();
    if (!manager || connected.size === 0) return;
    const known = new Set(manager.getAllServerNames());
    const dropped = [...connected].filter(name => !known.has(name) && !connecting.has(name));
    if (dropped.length > 0) connectLater(ctx, dropped);
  };

  /**
   * `setActiveToolsByName` pins every requested name that is not already in the
   * live `xd://` mount set, and the extension API exposes no way to hand it a
   * target mount partition (`setActiveToolPresentation` is session-internal). So a
   * server switched back on by this extension's own write comes back as top-level
   * tools — full schemas in the request rather than one catalog line each — until
   * the next session start remounts it. Say so rather than let the prompt silently
   * grow. When a connect or disconnect in the same apply queued a tools refresh,
   * that refresh re-enables and remounts them first, so there is nothing to say.
   */
  const summarize = (report: ApplyReport): string => {
    const parts: string[] = [];
    const fmt = ([name, count]: [string, number]) => `${name} (${count})`;
    if (report.connected.length > 0) parts.push(`connected for this session: ${report.connected.map(fmt).join(", ")}`);
    if (report.disconnected.length > 0) parts.push(`disconnected: ${report.disconnected.join(", ")}`);
    if (report.off.length > 0) parts.push(`off: ${report.off.map(fmt).join(", ")}`);
    if (report.on.length > 0) {
      const caveat = report.pinned ? " — listed top-level until next session start" : "";
      parts.push(`on: ${report.on.map(fmt).join(", ")}${caveat}`);
    }
    if (report.failed.length > 0) {
      parts.push(`failed: ${report.failed.map(([name, error]) => `${name} — ${error}`).join(", ")}`);
    }
    return parts.length > 0 ? `MCP ${parts.join(" · ")}` : "MCP servers unchanged";
  };

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx as unknown as CtxLike);
  });
  pi.on("session_switch", async (_event, ctx) => {
    await restore(ctx as unknown as CtxLike);
  });
  pi.on("session_branch", async (_event, ctx) => {
    await restore(ctx as unknown as CtxLike);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx as unknown as CtxLike);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    reconnectDropped(ctx as unknown as CtxLike);
    await serialized(() => reconcile(ctx as unknown as CtxLike));
  });

  pi.registerCommand("mcps", {
    description: "Turn MCP servers on/off for this session only",
    handler: async (_args, commandCtx) => {
      const ctx = commandCtx as unknown as CtxLike;
      // Rescan: a hand edit or `/mcp enable` may have changed what config disables.
      configCache.delete(ctx.cwd);
      const config = readMcpConfig(ctx.cwd);
      const rows = buildRows(
        pi.getAllTools() as unknown as ToolInfoLike[],
        config,
        disabled,
        connected,
        readServerErrors(),
      );

      if (rows.length === 0) {
        ctx.ui.notify("No MCP servers are configured.", "warning");
        return;
      }
      // `custom()` needs the interactive TUI; RPC/ACP/print stub it out.
      if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) {
        const state = rows.map(r => `${r.name}=${r.state}`).join(" ");
        ctx.ui.notify(`/mcps needs the interactive TUI. Current state: ${state}`, "warning");
        return;
      }

      const canConnect = mcpManager() !== undefined;
      const picked = await ctx.ui.custom<ModalResult | undefined>(
        (tui, theme, _keybindings, done) => {
          const modal = new McpModal(rows, disabled, canConnect, theme, done);
          tui.setFocus(modal); // overlay mode does not focus for you
          tui.requestRender();
          return modal;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", minWidth: 44, maxHeight: "80%" },
        },
      );
      if (!picked) return;

      const off = new Set(picked.off);
      const configOff = new Set(rows.filter(row => row.configOff).map(row => row.name));
      const toDisconnect = rows.filter(row => row.configOff && row.state !== "config-off" && off.has(row.name));
      const toConnect = rows.filter(row => row.state === "config-off" && !off.has(row.name)).map(row => row.name);

      const gone = new Set<string>();
      for (const row of toDisconnect) {
        for (const tool of row.tools) gone.add(tool);
        await disconnect(row.name);
      }
      if (toConnect.length > 0) ctx.ui.notify(`Connecting ${toConnect.join(", ")}…`, "info");
      const failed = await connectNow(ctx.cwd, toConnect);
      for (const name of toConnect) if (!failed.has(name)) connected.add(name);
      // Adopt config-off servers left on that came up some other way (a manager retry after a timeout).
      for (const row of rows) if (row.configOff && row.tools.length > 0 && !off.has(row.name)) connected.add(row.name);

      // Config-off servers switch by connection, never through the switched-off set.
      const nextDisabled = new Set([...off].filter(name => !configOff.has(name)));
      const result = await serialized(() => apply(ctx, nextDisabled, gone));
      persist();

      const groups = toolGroups(ctx);
      const report: ApplyReport = {
        ...result,
        connected: toConnect
          .filter(name => !failed.has(name))
          .map((name): [string, number] => [name, groups.get(name)?.length ?? 0]),
        disconnected: toDisconnect.map(row => row.name),
        failed: [...failed],
      };
      ctx.ui.notify(summarize(report), report.failed.length > 0 ? "warning" : "info");
    },
  });
}
