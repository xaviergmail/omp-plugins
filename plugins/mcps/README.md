# mcps

`/mcps` — turn MCP servers on and off for the **current session only**, including
servers your config disables. Nothing is written to `mcp.json`; `/mcp enable` and
`/mcp disable` already exist for the persistent case.

```
╭─ MCP servers — this session only ──────────────────────────────────────────╮
│ ▶ ☑ atlassian          enabled · 37 tools                                  │
│   ☐ aws-devops-agent   disabled in config                                  │
│   ☐ github             disabled · 47 tools                                 │
│   ☑ linear             enabled this session · 23 tools                     │
│   ☑ sentry             enabled · 9 tools                                   │
│   ⚠ xoi-release-agent  enabled, not running — HTTP 401: Missing Bearer token│
├────────────────────────────────────────────────────────────────────────────┤
│     Apply changes                                                          │
│     Enable all                                                             │
│     Disable all                                                            │
│     Cancel                                                                 │
├────────────────────────────────────────────────────────────────────────────┤
│ space/enter toggle · ↑↓ move · esc cancel                                  │
╰────────────────────────────────────────────────────────────────────────────╯
```

`space` or `enter` toggles the highlighted server, `↑↓`/`j`/`k` move, `esc`
cancels. Every row is one line and the status column starts at a fixed offset, so
moving the cursor never reflows the list.

## How switching off works

For a running server, the session-scoped lever is the active tool set.
`pi.getActiveTools()` returns the session's enabled tool names — top-level tools
plus everything mounted under `xd://` — and `pi.setActiveTools(names)` replaces
that set. Switching a server off drops its `mcp__<server>_*` names, which removes
them from the model's tool contract and from the `xd://` device catalog. The MCP
connection is left untouched, so switching back on is instant and needs no
reconnect.

Every apply passes the complete desired name list rather than an incremental diff,
so a stale snapshot can never silently demote unrelated tools. The extension also
records the exact names it removed per server, so switching back on restores only
what it took away — never a tool that `/tools`, `--tools`, or plan mode
deliberately left inactive.

Interactive MCP discovery finishes *after* `session_start`, and reconnects and
`tools/list_changed` re-register a server's tools through `refreshMCPTools`, which
enables everything it binds. A `before_agent_start` handler therefore re-asserts
the switched-off set once per turn.

The choice is recorded as a custom session entry, so it survives a session resume,
branch, or `/tree` navigation. `/new` starts with every server as config has it,
and `/resume` applies the target session's own choices.

## Switching on a server disabled in config

A server whose entry has `"enabled": false`, or whose name is in the user
`disabledServers` denylist, has no connection and no tools, so the active tool set
cannot switch it. `/mcps` switches it on through the session's own MCP manager
instead:

1. Host discovery supplies the server's full definition, re-read from disk. The
   extension calls the capability loader that `loadAllMCPConfigs` wraps, minus its
   suppression step, so every source format and its environment expansion behave
   as at startup.
2. `MCPManager.connectServers` connects the server and hands its tools to the
   session through the callback startup uses, so they mount under `xd://` like
   any configured server's.
3. Switching the server off again disconnects it; config is the authority again.

While a change is pending, the row says `connects on apply` or
`disconnects on apply`; once the server runs, it reads `enabled this session`. A
server that fails to come up stays off, and the confirmation line gives the reason.

The switch lasts until the session ends:

- Resuming the session reconnects the server in the background, so startup does
  not wait on it.
- `/mcp reload` and `/reload-plugins` reconnect the manager from config alone,
  which drops the server. The next prompt brings it back.
- `/new` disconnects it.

## Subagents

Subagents (the `task` tool, eval `agent()`, `/tan`) share the session's MCP
manager and get every tool it serves at spawn, unless MCP is off for them (plan
mode, restricted tool lists). A server switched on here is therefore available to
subagents spawned after it connects. Switching off a server that config enables
removes its tools from the top-level session only; subagents still get them.

Only the top-level session acts on `/mcps` state. A `/tan` clone's session is a
fork of its parent's, so a revived clone would otherwise replay the parent's
switches on the shared manager and reconnect a server switched off since.

## Servers that are not running

The modal lists every server in the configuration, not just the ones that
registered tools. Servers disabled in config never reach the MCP manager, so the
extension finds them by parsing the discovery chain itself (OMP-native, Claude,
Gemini, OpenCode, Cursor, VS Code, root fallbacks — profile-aware, first source
wins). The scan reruns each time `/mcps` opens, so a config edit made mid-session
shows up.

A server that is **`enabled, not running`** is configured and enabled but
contributed no tools. There is no extension event for MCP connect failure, so
detection is that inference. The reason shown after the dash is recovered
best-effort from the session log (`MCP tool load failed`); a failure inside the
250 ms startup race logs nothing, so the reason is sometimes absent while the state
is still correct.

Such a server is not toggleable: it has no tools to add to or remove from the
session's tool set, and retrying its connection is `/mcp reconnect`'s job. It
renders with `⚠`, ignores `space`, and the footer explains why.

## Known limitation

`setActiveToolsByName` pins every requested name that is not already in the live
`xd://` mount set, and the extension API exposes no way to hand it a target mount
partition. A server switched **off and then back on** in the same session
therefore returns as top-level tools — full schemas in each request instead of one
catalog line each — until the next session start remounts it. The confirmation
message says so explicitly. Switching a server off and leaving it off, the common
case, has no such cost. Neither does an apply that also connects or disconnects a
config-disabled server: the tool refresh that triggers remounts everything first.

## Requirements

The modal is a real TUI component rendered through `ctx.ui.custom({ overlay: true })`,
which the interactive TUI provides and the RPC, ACP, and print modes stub out.
Outside the TUI, `/mcps` reports the current state as a notification instead of
opening.

Switching on a config-disabled server needs a session with MCP enabled and imports
host modules at runtime: `MCPManager` from `@oh-my-pi/pi-coding-agent/mcp`, the
capability loader from `@oh-my-pi/pi-coding-agent/discovery`, and that loader's
file cache from `@oh-my-pi/pi-coding-agent/capability/fs`. Without an MCP manager,
those rows stay informational.
