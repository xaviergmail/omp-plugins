# mcps

`/mcps` — turn MCP servers on and off for the **current session only**. Nothing is
written to `mcp.json`; `/mcp disable` already exists for the persistent case.

```
╭─ MCP servers — this session only ──────────────────────────────────────────╮
│ ▶ ☑ atlassian          enabled · 37 tools                                  │
│   ⚠ aws-devops-agent   disabled in config                                  │
│   ☐ github             disabled · 47 tools                                 │
│   ☑ sentry             enabled · 9 tools                                   │
│   ⚠ xoi-release-agent  enabled, not running — HTTP 401: Missing Bearer token│
├────────────────────────────────────────────────────────────────────────────┤
│ ▶   Apply changes                                                          │
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

The only session-scoped lever the extension API exposes is the active tool set.
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
branch, or `/tree` navigation.

## Servers that are not running

The modal lists every server in the configuration, not just the ones that
registered tools:

- **`disabled in config`** — the entry has `"enabled": false`, or the user
  `disabledServers` denylist names it. Servers suppressed this way never reach the
  MCP manager at all, so they are invisible to every runtime API; the extension
  parses the discovery chain itself (OMP-native, Claude, Gemini, OpenCode, Cursor,
  VS Code, root fallbacks — profile-aware, first source wins) to find them.
- **`enabled, not running`** — configured and enabled, but it contributed no
  tools. There is no extension event for MCP connect failure, so detection is that
  inference. The reason shown after the dash is recovered best-effort from the
  session log (`MCP tool load failed`); a failure inside the 250 ms startup race
  logs nothing, so the reason is sometimes absent while the state is still correct.

Neither kind is toggleable — with no registered tools there is nothing to add to
or remove from the session's tool set, and an extension cannot force a connect.
They render with `⚠`, ignore `space`, and the footer explains why.

## Known limitation

`setActiveToolsByName` pins every requested name that is not already in the live
`xd://` mount set, and the extension API exposes no way to hand it a target mount
partition. A server switched **off and then back on** in the same session
therefore returns as top-level tools — full schemas in each request instead of one
catalog line each — until the next session start remounts it. The confirmation
message says so explicitly. Switching a server off and leaving it off, the common
case, has no such cost.

## Requirements

The modal is a real TUI component rendered through `ctx.ui.custom({ overlay: true })`,
which the interactive TUI provides and the RPC, ACP, and print modes stub out.
Outside the TUI, `/mcps` reports the current state as a notification instead of
opening.
