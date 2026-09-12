# Bundled plugins

VsWorker ships a curated set of plugins inside the product. They are compiled into the CLI binary and the
desktop server bundle at build time, so an end user never needs npm, GitHub, or any network access for a
bundled plugin to work. Updating a bundled plugin means shipping a new VsWorker release.

Everything in this directory is fork-owned. Upstream OpenCode files are touched in exactly seven places, all
marked `// vsworker-seam` and listed in [UPSTREAM.md](./UPSTREAM.md).

## The manifest

`plugins.jsonc` is the single place that decides what gets bundled. After editing it, run:

```bash
bun run --cwd vsworker plugins generate
```

That rewrites this package's `dependencies`, runs `bun install`, and regenerates `src/server.gen.ts`,
`src/tui.gen.ts`, and `plugins.schema.json`. Commit all of those together with `bun.lock`.

### Entry fields

| Field            | Applies to  | Meaning                                                                                                        |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `id`             | all         | Stable identity. Users key off it in `opencode.json`, and the CLI prints it. Lowercase, no `internal:` prefix. |
| `source`         | all         | `npm`, `github`, or `local`.                                                                                   |
| `package`        | npm, github | Package name. Must match the `name` in the package's own `package.json`.                                       |
| `version`        | npm         | Exact version. Ranges are rejected, because a range would make two builds of the same commit differ.           |
| `repo`           | github      | `owner/repo`.                                                                                                  |
| `ref`            | github      | Full 40 character commit sha. Branch names are rejected for the same reason ranges are.                        |
| `path`           | local       | Entrypoint relative to `vsworker/`. Defaults to `plugins/<id>/index.ts`.                                       |
| `kind`           | all         | `server` or `tui`. Detected from the package exports; set it only to override.                                 |
| `enabled`        | all         | `false` removes the plugin from the build entirely. Default `true`.                                            |
| `defaultEnabled` | all         | `false` bundles the plugin but leaves it off until a user turns it on. Default `true`.                         |
| `options`        | all         | Passed to the plugin as its second argument. Users can override individual keys.                               |
| `description`    | all         | Why this plugin is bundled. For humans.                                                                        |

### Examples

```jsonc
// An npm package, pinned
{ "id": "wakatime", "source": "npm", "package": "opencode-wakatime", "version": "1.2.3" }

// A GitHub repository, pinned to a commit. The repo root must be an installable npm package.
{ "id": "team-tools", "source": "github", "package": "team-tools", "repo": "acme/team-tools",
  "ref": "0123456789abcdef0123456789abcdef01234567" }

// An in-house plugin living under vsworker/plugins/
{ "id": "intranet", "source": "local", "options": { "url": "http://10.0.0.5" } }
```

A GitHub repository whose plugin lives in a subdirectory cannot be used directly, because Bun git
dependencies address a whole repository. Vendor that plugin into `vsworker/plugins/` as a `local` entry
instead.

## Commands

```bash
bun run --cwd vsworker plugins generate        # regenerate everything from the manifest
bun run --cwd vsworker plugins check           # CI gate: fail if the generated output is stale
bun run --cwd vsworker plugins check --seams   # CI gate: fail if an upstream merge dropped a seam
bun run --cwd vsworker plugins validate        # validate the manifest only
bun run --cwd vsworker plugins outdated        # what newer versions/commits exist upstream
bun run --cwd vsworker plugins bump <id> [ver] # repin one plugin, then regenerate
```

At runtime:

```bash
opencode vsworker plugins list                 # what is bundled and whether it is running
opencode vsworker plugins enable <id>          # write vsworker.plugins.<id> = true
opencode vsworker plugins disable <id> [-g]    # ... = false, -g for the global config
```

## How a user turns a plugin off

Server-kind plugins are controlled from `opencode.json`, global or per project. Project config wins per key.

```jsonc
{
  "vsworker": {
    "plugins": {
      "wakatime": false,
      "intranet": { "enabled": true, "options": { "url": "http://10.0.0.9" } },
    },
  },
}
```

TUI-kind plugins use the TUI's own mechanism instead: `plugin_enabled` in `tui.json`, or the plugin manager
inside the TUI. Both are keyed by the same `id`.

Declaring the same npm package in the ordinary `plugin` array overrides the bundled copy entirely, which is
how a user pins their own version of something VsWorker ships.

## Load order and kill switches

Built-in OpenCode plugins load first, then bundled plugins in manifest order, then external plugins from
`plugin`. Later hooks see the state earlier ones left behind, so a user's own plugin can always correct a
bundled one.

| Switch                               | Effect                       |
| ------------------------------------ | ---------------------------- |
| `VSWORKER_DISABLE_BUNDLED_PLUGINS=1` | Bundled plugins only         |
| `OPENCODE_PURE=1`                    | Bundled and external plugins |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` | Built-in and bundled plugins |

## What a bundled plugin may do

A bundled plugin is compiled into the binary, so it runs from `$bunfs` on the CLI and from a Node bundle in
the desktop app. It has no directory of its own on disk. That rules out:

- native modules and anything with an install script, since `bun build` cannot inline them
- reading assets relative to `import.meta.dir` or `__dirname`
- `require()` or dynamic `import()` of paths computed at runtime
- `Bun.*` APIs, including the `$` shell, because the desktop sidecar runs on Node where `input.$` is undefined
- `oc-themes` theme files and attention sound packs, for TUI plugins, since both need a package directory

Plain JS/TS that talks to the SDK client, the filesystem, and the network is fine. `plugins check` warns
about the cases it can detect.

Plugins are typechecked against this repository's own `@opencode-ai/plugin`, so an upstream change to the
hook API surfaces as a failing `bun typecheck` here rather than as a broken release.

## Writing an in-house plugin

Copy `plugins/hello/` and add an entry to the manifest. The default export follows the standard OpenCode
plugin contract, `{ id, server }` for server plugins or `{ id, tui }` for TUI plugins. The `hello` plugin is
bundled into every build with `defaultEnabled: false` as the smoke test for this pipeline, so a release is
unaffected until someone enables it.

## Adding other content later

The manifest and the generator are shaped so skills, agents, and commands can be bundled the same way: add a
top-level array to the schema in `script/manifest.ts`, emit a second generated module, and read it from the
matching discovery point. Nothing about plugin bundling has to change first.
