# xaviergmail-omp-plugins

A plugin marketplace for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

The catalog lives at [`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json);
each plugin is a directory under [`plugins/`](plugins).

## Plugins

| Plugin | Command | What it does |
| --- | --- | --- |
| [`mcps`](plugins/mcps) | `/mcps` | Turn MCP servers on and off for the current session only, including ones config disables |

## Install

```bash
omp plugin marketplace add xaviergmail/omp-plugins
omp plugin install mcps@xaviergmail-omp-plugins
```

**Then restart omp.** Newly installed extension modules are wired up at session
start, so `/reload-plugins` is not enough for these — it refreshes skills, slash
commands, and MCP servers, but not extension modules.

Same thing from inside a session:

```
/marketplace add xaviergmail/omp-plugins
/marketplace install mcps@xaviergmail-omp-plugins
```

omp clones the marketplace with your own `git`, so `git@github.com:xaviergmail/omp-plugins.git`
and `https://github.com/xaviergmail/omp-plugins.git` work too if you prefer an
explicit URL.

Add `--scope project` to install into a single project (writes to
`<project>/.omp/plugins/`) instead of your user profile (`~/.omp/plugins/`).

### Requirements

An omp build whose extension API provides `ctx.ui.custom()` and
`pi.getActiveTools()` / `pi.setActiveTools()`, and whose bundled
`@oh-my-pi/pi-coding-agent/mcp` exposes `MCPManager.instance()` with
`connectServers()` / `waitForStartup()`. Verified against **omp 18.4.3**.

## Manage

```bash
omp plugin list                                     # everything installed, all sources
omp plugin disable mcps@xaviergmail-omp-plugins     # keep installed, stop loading
omp plugin enable  mcps@xaviergmail-omp-plugins
omp plugin uninstall mcps@xaviergmail-omp-plugins
omp plugin marketplace update xaviergmail-omp-plugins   # re-fetch this catalog
omp plugin upgrade mcps@xaviergmail-omp-plugins         # reinstall at the catalog version
```

`marketplace update` only refreshes the catalog — it installs nothing. `upgrade`
is what reinstalls a plugin, and it compares the catalog's `version` field, so a
release is only visible to `upgrade` if that version was bumped.

## Contributing

Issues and pull requests welcome. A plugin here is a directory plus a catalog
entry:

1. Create `plugins/<name>/` with a `package.json` whose `omp.extensions` array
   points at the entry module(s):

   ```json
   {
     "name": "omp-plugin-<name>",
     "version": "1.0.0",
     "private": true,
     "omp": { "extensions": ["./src/<name>.ts"] }
   }
   ```

   `private: true` is deliberate and stays true even though this repo is public:
   marketplace installs symlink the cached plugin directory into the scope's
   `node_modules` and load `package.json#omp.extensions` from there, so plugins
   are consumed by symlink and must never be published to npm.

2. Append an entry to `.omp-plugin/marketplace.json`. `metadata.pluginRoot` is
   `plugins`, so `source` is just `"./<name>"`.

3. Names in both files must be lowercase alphanumeric with hyphens or dots and
   must start and end alphanumerically — underscores and capitals are rejected.

4. Bump the version in **both** `plugins/<name>/package.json` and the catalog
   entry. The catalog value drives `omp plugin upgrade`; the manifest value is the
   fallback recorded at install time.

There is deliberately no `.claude-plugin/marketplace.json` fallback here. omp
would read one, and Claude Code could too, but these plugins are omp *extension
modules* — they have no meaning in Claude Code, so advertising them there would
only produce installs that do nothing.

### Local development

Skip the marketplace round trip and symlink a working copy straight into your
plugin root:

```bash
omp plugin link ./plugins/mcps
```

Edits then need only a session restart.

### Type checking

Extension modules import host-bundled packages (`@oh-my-pi/pi-coding-agent`,
`@oh-my-pi/pi-tui`) that omp resolves at load time from inside its own binary.
There is nothing to `npm install`, and an editor with no omp checkout on disk will
flag those imports as unresolved. That is expected: the runtime resolves them, and
omp transpiles extension TypeScript without type checking it.

## License

[MIT](LICENSE)
