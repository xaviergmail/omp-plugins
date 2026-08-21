import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// The only session-scoped lever the extension API exposes is the active tool set:
// `pi.getActiveTools()` returns `session.getEnabledToolNames()` — top-level tools
// plus everything mounted under `xd://` — and `pi.setActiveTools(names)` replaces
// that whole set. Dropping a server's `mcp__<server>_*` names removes them from the
// model's contract and from the `xd://` device catalog while leaving the MCP
// connection alone, so re-enabling is instant and needs no reconnect.
//
// Every apply passes the FULL desired name list, never an incremental diff, so a
// stale snapshot can never silently demote unrelated tools.
//
// Why a hand-rolled overlay instead of `ctx.ui.select()`: the built-in selector
// routes space into its own search filter, so space-to-toggle is impossible there,
// and its two-line option rendering (label + description) shifts the list layout as
// the cursor moves. A `Component` under `ctx.ui.custom()` owns both.

const DISABLED_ENTRY_TYPE = "io.xoi.mcps.disabled-servers";
const MCP_PREFIX = "mcp__";
const MAX_VISIBLE_ROWS = 18;

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
  sessionManager: {
    getBranch(): Iterable<{ type?: string; customType?: string; data?: unknown }>;
  };
}

/** How a configured server presents in the session right now. */
type ServerState =
  | "on" // has tools, active
  | "off" // has tools, switched off in this session
  | "config-off" // suppressed by config (`enabled: false` or `disabledServers`)
  | "not-running"; // enabled in config but contributed no tools

interface ServerRow {
  name: string;
  /** Registered `mcp__…` tool names owned by this server; empty when it never connected. */
  tools: string[];
  state: ServerState;
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

/** Config scan is stable for a session; the per-turn reconcile must not re-read files. */
const configCache = new Map<string, McpConfig>();

/**
 * Read the MCP configuration OMP discovers, in its precedence order.
 *
 * Two reasons the extension must parse these files itself rather than ask the
 * runtime. First, `getAllTools()` reports MCP tools with a synthetic `sourceInfo`
 * (`{ source: "mcp", path: "<mcp:name>" }`) carrying no server identity, and
 * `mcp__<server>_<tool>` does not split unambiguously — `mcp__chrome_devtools_list`
 * could be `chrome`/`devtools_list` or `chrome-devtools`/`list`. Second, a server
 * suppressed by `enabled: false` or `disabledServers` never reaches the MCP manager
 * at all, so it is invisible at every API level; listing it requires the raw file.
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

  const names = (value: unknown): Set<string> =>
    new Set(Array.isArray(value) ? value.filter((n): n is string => typeof n === "string") : []);
  const user = readJson(userPath);
  const config: McpConfig = {
    entries,
    denied: names(user?.disabledServers),
    forced: names(user?.enabledServers),
  };
  configCache.set(cwd, config);
  return config;
}

/** Effective config verdict: denylist wins, then `enabled: false` unless force-enabled. */
function configEnabled(config: McpConfig, name: string): boolean {
  if (config.denied.has(name)) return false;
  return config.entries.get(name)?.enabled !== false || config.forced.has(name);
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
  errors: Map<string, string>,
): ServerRow[] {
  const groups = groupToolsByServer(allTools, config);
  const names = new Set<string>([...config.entries.keys(), ...groups.keys()]);
  const rows: ServerRow[] = [];
  for (const name of names) {
    const tools = groups.get(name) ?? [];
    let state: ServerState;
    if (tools.length > 0) state = sessionDisabled.has(name) ? "off" : "on";
    else if (!configEnabled(config, name)) state = "config-off";
    else state = "not-running";
    rows.push({ name, tools, state, error: state === "not-running" ? errors.get(name) : undefined });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Only a server with registered tools can be switched: the rest have nothing to remove. */
function isToggleable(row: ServerRow): boolean {
  return row.tools.length > 0;
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
  disabled: string[];
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
  #draft: Set<string>;
  #done: (result: ModalResult | undefined) => void;
  #theme: ThemeLike;
  #index = 0;
  #scroll = 0;
  /** Row count including the actions appended after the servers. */
  #total: number;
  #nameWidth: number;

  constructor(rows: ServerRow[], disabled: ReadonlySet<string>, theme: ThemeLike, done: (r: ModalResult | undefined) => void) {
    this.#rows = rows;
    this.#draft = new Set(disabled);
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
    if (row && !isToggleable(row)) {
      return row.state === "config-off"
        ? "disabled in the config file — use /mcp enable, then restart"
        : "no tools registered — nothing to switch this session";
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
    const toggleable = isToggleable(row);
    const marker = toggleable ? (off ? t.fg("dim", "☐") : t.fg("accent", "☑")) : t.fg("dim", "⚠");
    const name = fit(toggleable && !off ? t.fg("text", row.name) : t.fg("dim", row.name), this.#nameWidth);

    // Status lives on THIS line at a fixed column, so cursor movement never
    // changes any row's height and the list cannot shift under the cursor.
    let status: string;
    if (!toggleable && row.state === "config-off") status = "disabled in config";
    else if (!toggleable) status = row.error ? `enabled, not running — ${row.error}` : "enabled, not running";
    else status = `${off ? "disabled" : "enabled"} · ${row.tools.length} tool${row.tools.length === 1 ? "" : "s"}`;

    return `${cursor}${marker} ${name}  ${t.fg("dim", status)}`;
  }

  #move(delta: number): void {
    this.#index = Math.min(this.#total - 1, Math.max(0, this.#index + delta));
  }

  #activate(): void {
    const action = ACTIONS[this.#index - this.#rows.length];
    if (!action) {
      const row = this.#rows[this.#index];
      if (!row || !isToggleable(row)) return; // informational row
      if (this.#draft.has(row.name)) this.#draft.delete(row.name);
      else this.#draft.add(row.name);
      return;
    }
    switch (action.id) {
      case "apply":
        this.#done({ disabled: [...this.#draft] });
        return;
      case "all-on":
        this.#draft.clear();
        return;
      case "all-off":
        for (const row of this.#rows) if (isToggleable(row)) this.#draft.add(row.name);
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
   * Exact tool names removed per server, so re-enabling restores only what this
   * extension took away — never a tool some other feature (`/tools`, `--tools`,
   * plan mode) deliberately left inactive.
   */
  const removed = new Map<string, Set<string>>();

  const toolGroups = (ctx: CtxLike): Map<string, string[]> =>
    groupToolsByServer(pi.getAllTools() as unknown as ToolInfoLike[], readMcpConfig(ctx.cwd));

  const persist = (): void => {
    pi.appendEntry(DISABLED_ENTRY_TYPE, { servers: [...disabled] });
  };

  /** Rebuild `disabled` from the session branch (resume / branch / tree navigation). */
  const restoreState = (ctx: CtxLike): void => {
    let latest: string[] | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== DISABLED_ENTRY_TYPE) continue;
      const data = entry.data;
      const servers = data && typeof data === "object" && "servers" in data ? data.servers : undefined;
      if (Array.isArray(servers)) latest = servers.filter((s): s is string => typeof s === "string");
    }
    disabled.clear();
    for (const name of latest ?? []) disabled.add(name);
  };

  /**
   * Bring the active tool set in line with `nextDisabled` and adopt it as the new
   * state. Always hands `setActiveTools` the complete desired name list.
   */
  const apply = async (
    ctx: CtxLike,
    nextDisabled: ReadonlySet<string>,
  ): Promise<{ off: [string, number][]; on: [string, number][] }> => {
    const enabled = pi.getActiveTools();
    const enabledSet = new Set(enabled);
    const drop = new Set<string>();
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
        off.push([name, taken.length]);
      } else {
        const record = removed.get(name);
        if (!record) continue;
        // Only names this extension removed, that still exist and are not active.
        const back = tools.filter(tool => record.has(tool) && !enabledSet.has(tool));
        removed.delete(name);
        if (back.length === 0) continue;
        restore.push(...back);
        on.push([name, back.length]);
      }
    }

    if (drop.size > 0 || restore.length > 0) {
      // Preserve existing order (built-ins first) and append restorations.
      await pi.setActiveTools(enabled.filter(name => !drop.has(name)).concat(restore));
    }

    disabled.clear();
    for (const name of nextDisabled) disabled.add(name);
    return { off, on };
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
   * `setActiveToolsByName` pins every requested name that is not already in the
   * live `xd://` mount set, and the extension API exposes no way to hand it a
   * target mount partition (`setActiveToolPresentation` is session-internal). So a
   * re-enabled server comes back as top-level tools — full schemas in the request
   * rather than one catalog line each — until the next session start remounts it.
   * Say so rather than let the prompt silently grow.
   */
  const summarize = (result: { off: [string, number][]; on: [string, number][] }): string => {
    const parts: string[] = [];
    const fmt = ([name, count]: [string, number]) => `${name} (${count})`;
    if (result.off.length > 0) parts.push(`off: ${result.off.map(fmt).join(", ")}`);
    if (result.on.length > 0) {
      parts.push(`on: ${result.on.map(fmt).join(", ")} — listed top-level until next session start`);
    }
    return parts.length > 0 ? `MCP ${parts.join(" · ")}` : "MCP servers unchanged";
  };

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx as unknown as CtxLike);
    await reconcile(ctx as unknown as CtxLike);
  });
  pi.on("session_branch", async (_event, ctx) => {
    restoreState(ctx as unknown as CtxLike);
    await reconcile(ctx as unknown as CtxLike);
  });
  pi.on("session_tree", async (_event, ctx) => {
    restoreState(ctx as unknown as CtxLike);
    await reconcile(ctx as unknown as CtxLike);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await reconcile(ctx as unknown as CtxLike);
  });

  pi.registerCommand("mcps", {
    description: "Turn MCP servers on/off for this session only",
    handler: async (_args, commandCtx) => {
      const ctx = commandCtx as unknown as CtxLike;
      const config = readMcpConfig(ctx.cwd);
      const rows = buildRows(
        pi.getAllTools() as unknown as ToolInfoLike[],
        config,
        disabled,
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

      const picked = await ctx.ui.custom<ModalResult | undefined>(
        (tui, theme, _keybindings, done) => {
          const modal = new McpModal(rows, disabled, theme, done);
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

      const result = await apply(ctx, new Set(picked.disabled));
      persist();
      ctx.ui.notify(summarize(result), "info");
    },
  });
}
