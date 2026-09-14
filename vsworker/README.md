# Bundled plugins, MCP servers, and skills

VsWorker ships a curated set of plugins, MCP server definitions, and skills inside the product. They are compiled
into the CLI binary and the desktop server bundle at build time, so an end user never needs npm, GitHub, or any
network access for them to work. Updating any of them means shipping a new VsWorker release.

Everything in this directory is fork-owned. Upstream OpenCode files are touched in exactly eleven places, nine of
them marked `// vsworker-seam` and all of them listed in [UPSTREAM.md](./UPSTREAM.md).

## The manifest

`bundle.jsonc` is the single place that decides what gets bundled. After editing it, run:

```bash
bun run --cwd vsworker bundle generate
```

That rewrites this package's `dependencies`, runs `bun install`, and regenerates `src/server.gen.ts`,
`src/tui.gen.ts`, `src/mcp.gen.ts`, `src/skills.gen.ts`, and `bundle.schema.json`. Commit all of those together
with `bun.lock`.

Three fields mean the same thing in all three sections:

| Field            | Meaning                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `id`             | Stable identity. Users key off it in config, and the CLI prints it. Lowercase. |
| `enabled`        | `false` removes the entry from the build entirely. Default `true`.             |
| `defaultEnabled` | `false` bundles it but leaves it off until a user turns it on. Default `true`. |
| `description`    | Why this entry is bundled. For humans.                                         |

### `plugins`

| Field     | Applies to  | Meaning                                                                           |
| --------- | ----------- | --------------------------------------------------------------------------------- |
| `source`  | all         | `npm`, `github`, or `local`.                                                      |
| `package` | npm, github | Package name. Must match the `name` in the package's own `package.json`.          |
| `version` | npm         | Exact version. Ranges are rejected, because a range would make two builds differ. |
| `repo`    | github      | `owner/repo`.                                                                     |
| `ref`     | github      | Full 40 character commit sha. Branch names are rejected for the same reason.      |
| `path`    | local       | Entrypoint relative to `vsworker/`. Defaults to `plugins/<id>/index.ts`.          |
| `kind`    | all         | `server` or `tui`. Detected from the package exports; set it only to override.    |
| `options` | all         | Passed to the plugin as its second argument. Users can override individual keys.  |

```jsonc
// An npm package, pinned
{ "id": "wakatime", "source": "npm", "package": "opencode-wakatime", "version": "1.2.3" }

// A GitHub repository, pinned to a commit. The repo root must be an installable npm package.
{ "id": "team-tools", "source": "github", "package": "team-tools", "repo": "acme/team-tools",
  "ref": "0123456789abcdef0123456789abcdef01234567" }

// An in-house plugin living under vsworker/plugins/
{ "id": "intranet", "source": "local", "options": { "url": "http://10.0.0.5" } }
```

A GitHub repository whose plugin lives in a subdirectory cannot be used directly, because Bun git dependencies
address a whole repository. Vendor that plugin into `vsworker/plugins/` as a `local` entry instead.

### `mcp`

`config` is an `mcp.<id>` value exactly as it would appear in `opencode.json`, in the flat V1 shape. The `id` is
the server name users see, and the prefix on its tool names.

```jsonc
{ "id": "intranet-docs", "config": { "type": "remote", "url": "http://10.0.0.5/mcp",
  "headers": { "Authorization": "Bearer {env:INTRANET_TOKEN}" } } }

{ "id": "sqlite", "config": { "type": "local", "command": ["uvx", "mcp-server-sqlite", "--db", "./app.db"] },
  "defaultEnabled": false }
```

`config.enabled` is rejected: use `defaultEnabled`, because `enabled` is the key a user writes to override it.

Two things a bundled definition cannot do for you:

- **Secrets.** The definition is compiled into every copy of the build, so a literal token in `headers`,
  `oauth.clientSecret`, or `environment` ships to everyone. Use `{env:VAR}` or `{file:path}` instead. Both are
  substituted at config-load time, with relative `{file:}` paths resolved against the user's global config
  directory. `bundle generate` warns about the literals it can spot.
- **Installing the server.** For a `local` server, `command[0]` has to already exist on each user's machine.
  Remote servers have no such requirement, which is why they are the better fit for bundling.

### `skills`

Skills are vendored in this repository under `vsworker/skills/<id>/`, `SKILL.md` plus whatever `scripts/` or
`references/` files it needs. Every file is inlined into the build and written to
`~/.cache/vsworker/vsworker/skills/<id>/` the first time a build that has skills enabled starts. They need a real
directory on disk because the `skill` tool lists sibling files and slash commands resolve relative paths.

```jsonc
{ "id": "report-review", "description": "审核流程 the team follows for 可研报告" }
{ "id": "hello", "path": "skills/hello", "defaultEnabled": false }
```

The frontmatter `name` must equal the `id`, and a `description` is required, because that is what the model picks
skills by. `vsworker/skills/` is listed in the repo's `.prettierignore`, so a vendored skill keeps the exact bytes
it was imported with.

## Commands

```bash
bun run --cwd vsworker bundle generate        # regenerate everything from the manifest
bun run --cwd vsworker bundle check           # CI gate: fail if the generated output is stale
bun run --cwd vsworker bundle check --seams   # CI gate: fail if an upstream merge dropped a seam
bun run --cwd vsworker bundle validate        # validate the manifest only
bun run --cwd vsworker bundle outdated        # what newer plugin versions/commits exist upstream
bun run --cwd vsworker bundle bump <id> [ver] # repin one plugin, then regenerate

# Import from your own global opencode config, then regenerate
bun run --cwd vsworker bundle import mcp <name> [--from <file>] [--id <id>] [--off]
bun run --cwd vsworker bundle import skill <name> [--from <dir>] [--force]
```

`import mcp` reads `~/.config/vsworker/opencode.json` (or `--from`), accepts both the flat and the
`mcp.servers` shapes, moves `enabled` into `defaultEnabled`, and warns about literal secrets. `import skill`
copies the directory out of `~/.config/vsworker/skills/<name>` into `vsworker/skills/<name>`. Both append to
`bundle.jsonc` without disturbing its comments.

At runtime:

```bash
opencode vsworker plugins list|enable <id>|disable <id> [-g]
opencode vsworker mcp     list|enable <id>|disable <id> [-g]
opencode vsworker skills  list|enable <id>|disable <id> [-g]
```

## How a user turns something off

Each kind uses the most natural key, global or per project. Project config wins per key.

```jsonc
{
  // Plugins and skills are keyed under vsworker.
  "vsworker": {
    "plugins": { "wakatime": false, "intranet": { "enabled": true, "options": { "url": "http://10.0.0.9" } } },
    "skills": { "report-review": false },
  },
  // MCP servers use the stock config key, so nothing fork-specific is needed.
  "mcp": { "intranet-docs": { "enabled": false } },
}
```

Three ways to override a bundled entry entirely, one per kind:

- **Plugin**: declare the same npm package in the ordinary `plugin` array.
- **MCP server**: write a full `mcp.<id>` definition, with a `type`. Note that an entry _without_ a `type` keeps
  only `enabled`, because config decoding drops the rest, so partial edits are not possible: copy the whole
  definition if you want to change a URL or a header.
- **Skill**: put a skill of the same name in `.opencode/skills/`, `~/.config/vsworker/skills/`, `~/.claude/skills/`, or any other discovered
  location. It wins, and the log records a duplicate skill name.

TUI-kind plugins use the TUI's own mechanism instead: `plugin_enabled` in `tui.json`, or the plugin manager inside
the TUI. Both are keyed by the same `id`.

## Load order and kill switches

Built-in OpenCode plugins load first, then bundled plugins in manifest order, then external plugins from `plugin`.
Bundled MCP servers join the merged config after every file and remote source. Bundled skills register before disk
discovery, so anything found on disk overrides them.

| Switch                               | Effect                           |
| ------------------------------------ | -------------------------------- |
| `VSWORKER_DISABLE_BUNDLED_PLUGINS=1` | Bundled plugins only             |
| `VSWORKER_DISABLE_BUNDLED_MCP=1`     | Bundled MCP servers only         |
| `VSWORKER_DISABLE_BUNDLED_SKILLS=1`  | Bundled skills only              |
| `OPENCODE_PURE=1`                    | All three, plus external plugins |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` | Built-in and bundled plugins     |

## What a bundled plugin may do

A bundled plugin is compiled into the binary, so it runs from `$bunfs` on the CLI and from a Node bundle in the
desktop app. It has no directory of its own on disk. That rules out:

- native modules and anything with an install script, since `bun build` cannot inline them
- reading assets relative to `import.meta.dir` or `__dirname`
- `require()` or dynamic `import()` of paths computed at runtime
- `Bun.*` APIs, including the `$` shell, because the desktop sidecar runs on Node where `input.$` is undefined
- `oc-themes` theme files and attention sound packs, for TUI plugins, since both need a package directory

Plain JS/TS that talks to the SDK client, the filesystem, and the network is fine. `bundle check` warns about the
cases it can detect.

Plugins are typechecked against this repository's own `@opencode-ai/plugin`, so an upstream change to the hook API
surfaces as a failing `bun typecheck` here rather than as a broken release.

## Writing in-house content

Copy `plugins/hello/` or `skills/hello/` and add a manifest entry. Both `hello` entries are bundled into every
build with `defaultEnabled: false`, as the smoke test for this pipeline, so a release is unaffected until someone
enables them.

## One known gap

Bundled skills are registered with the legacy skill service, which is what the model, the `skill` tool, slash
commands, and the TUI's `/skills` dialog all use. The V2 skill service in `packages/core/src/skill.ts` does not
see them. That service has no TUI consumer today and does not scan `~/.claude/skills` either, so nothing a user
can observe is missing; revisit this when V2 takes over skill listing.
