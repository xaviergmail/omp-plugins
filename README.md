# omp-plugins

An [oh-my-pi](https://github.com/can1357/oh-my-pi) marketplace. The catalog lives at
[`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json); each plugin is a
directory under [`plugins/`](plugins).

## Install

This repository is private, so add it by **SSH URL** — the GitHub shorthand
(`xaviergmail/omp-plugins`) resolves to an HTTPS clone and will fail to
authenticate. omp clones the marketplace with your own `git`, so your existing SSH
key is all the auth you need.

```bash
omp plugin marketplace add git@github.com:xaviergmail/omp-plugins.git
omp plugin install mcps@omp-plugins
```

Then restart omp: newly installed extension modules are wired up at session start,
so `/reload-plugins` is not enough for this one.

Same thing from inside a session:

```
/marketplace add git@github.com:xaviergmail/omp-plugins.git
/marketplace install mcps@omp-plugins
```

Install into a single project instead of your user profile with
`--scope project`, which writes to `<project>/.omp/plugins/` rather than
`~/.omp/plugins/`.

## Plugins

| Plugin | Command | What it does |
| --- | --- | --- |
| [`mcps`](plugins/mcps) | `/mcps` | Turn MCP servers on and off for the current session only |

## Manage

```bash
omp plugin list                        # everything installed, all sources
omp plugin disable mcps@omp-plugins    # keep it installed, stop loading it
omp plugin enable  mcps@omp-plugins
omp plugin uninstall mcps@omp-plugins
omp plugin marketplace update omp-plugins   # re-fetch this catalog
omp plugin upgrade mcps@omp-plugins         # reinstall at the catalog's version
```

`marketplace update` only refreshes the catalog. `upgrade` is what reinstalls a
plugin, and it compares the catalog's `version` field — so a release is only
visible to `upgrade` if the version was bumped.

## Adding a plugin to this repo

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

   `private: true` is deliberate — plugins here are consumed by symlink from
   omp's plugin cache and must never be published to npm.

2. Append an entry to `.omp-plugin/marketplace.json`. `metadata.pluginRoot` is
   `plugins`, so `source` is just `"./<name>"`.

3. Names in both files must be lowercase alphanumeric with hyphens or dots, and
   must start and end alphanumerically — `under_scores` and capitals are rejected.

4. Bump the version in **both** `plugins/<name>/package.json` and the catalog
   entry. The catalog value drives `omp plugin upgrade`; the manifest value is
   the fallback recorded at install time.

### Local development

Skip the marketplace round trip and symlink a working copy straight into your
plugin root:

```bash
omp plugin link ./plugins/mcps
```

Editing the source then only needs a session restart. Note that omp de-duplicates
extensions by resolved absolute path and skips slash commands that collide with an
already-registered name — so if you also keep a copy in
`~/.omp/agent/extensions/`, delete it before installing or linking, or one of the
two registrations will be dropped with a diagnostic in `~/.omp/logs/`.

### Type checking

The extension modules import host-bundled packages (`@oh-my-pi/pi-coding-agent`,
`@oh-my-pi/pi-tui`) that omp resolves at load time from inside its own binary.
There is nothing to `npm install`, and an editor with no omp checkout on disk will
flag those imports as unresolved. That is expected: the runtime resolves them, and
omp transpiles extension TypeScript without type checking it.
