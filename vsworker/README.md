# Bundled plugins, MCP servers, and skills

**English** | [简体中文](./README.zh.md)

VsWorker ships a curated set of plugins, MCP server definitions, and skills inside the product. They are compiled
into the CLI binary and the desktop server bundle at build time, so an end user never needs npm, GitHub, or any
network access for them to work. Updating any of them means shipping a new VsWorker release.

Everything in this directory is fork-owned. Upstream OpenCode files are touched in exactly twenty-two places,
twenty of them marked `// vsworker-seam` and all of them listed in [UPSTREAM.md](./UPSTREAM.md).

This file is the field reference: what the manifest accepts, and how a user turns an entry off. Building the
macOS and Windows desktop clients is [PACKAGING.md](./PACKAGING.md); merging upstream is
[UPSTREAM.md](./UPSTREAM.md).

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

Every section is optional and holds an array of objects. A whole file, with one entry of each kind:

```jsonc
{
  "$schema": "./bundle.schema.json",
  "plugins": [
    {
      "id": "intranet",
      "source": "local",
      "description": "Points the agent at the internal docs host.",
      "options": { "url": "http://10.0.0.5" },
    },
  ],
  "mcp": [
    {
      "id": "intranet-docs",
      "description": "Read-only search over the internal docs.",
      "config": {
        "type": "remote",
        "url": "http://10.0.0.5/mcp",
        "headers": { "Authorization": "Bearer {env:INTRANET_TOKEN}" },
      },
    },
  ],
  "skills": [
    {
      "id": "report-review",
      "description": "The review checklist the team applies to a 可研报告.",
    },
  ],
}
```

That bundles a plugin whose code lives at `vsworker/plugins/intranet/index.ts`, an MCP server the user reaches as
`intranet-docs`, and a skill whose files live at `vsworker/skills/report-review/`. Trailing commas and comments
are fine — it is JSONC, and `bundle import` preserves both. The sections below say what each kind accepts.

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
// npm, pinned to an exact version.
{
  "id": "wakatime",
  "source": "npm",
  "package": "opencode-wakatime",
  "version": "1.2.3",
  "description": "Sends coding activity to WakaTime.",
},

// GitHub, pinned to a commit.
{
  "id": "team-tools",
  "source": "github",
  "package": "team-tools",
  "repo": "acme/team-tools",
  "ref": "0123456789abcdef0123456789abcdef01234567",
},

// In-house: the code is at vsworker/plugins/intranet/index.ts, which is what "local" defaults to.
{
  "id": "intranet",
  "source": "local",
  "options": { "url": "http://10.0.0.5", "timeout": 5000 },
  "defaultEnabled": false,
},
```

The three sources take **disjoint** fields, and mixing them is rejected rather than ignored: `version` only
applies to `npm`, `repo` and `ref` only to `github`, and a `local` entry takes nothing but `path`. Two entries
cannot bundle the same `package`, and an `id` has to match `[a-z0-9][a-z0-9._-]*`.

A GitHub repository whose plugin lives in a subdirectory cannot be used directly, because Bun git dependencies
address a whole repository. Vendor that plugin into `vsworker/plugins/` as a `local` entry instead.

### `mcp`

`config` is an `mcp.<id>` value exactly as it would appear in `opencode.json`, in the flat V1 shape. The `id` is
the server name users see, and the prefix on its tool names.

```jsonc
// A remote server. The token is read from the user's environment when config loads, never baked into the build.
{
  "id": "intranet-docs",
  "description": "Read-only search over the internal docs.",
  "config": {
    "type": "remote",
    "url": "http://10.0.0.5/mcp",
    "headers": { "Authorization": "Bearer {env:INTRANET_TOKEN}" },
  },
},

// A local server, bundled but off until a user turns it on. command[0] has to already exist on their machine.
{
  "id": "sqlite",
  "defaultEnabled": false,
  "config": {
    "type": "local",
    "command": ["uvx", "mcp-server-sqlite", "--db", "./app.db"],
    "cwd": "./data",
    "environment": { "SQLITE_READONLY": "1", "SQLITE_TOKEN": "{file:secrets/sqlite-token}" },
    "timeout": 10000,
  },
},
```

A `remote` entry needs `type` and `url`, and may carry `headers` and `oauth`. A `local` entry needs `type` and
`command`, and may carry `cwd`, `environment` and `timeout`. Relative `cwd` resolves against the workspace; a
relative `{file:}` path resolves against the user's global config directory.

`config.enabled` is rejected: use `defaultEnabled`, because `enabled` is the key a user writes to override it.

Two things a bundled definition cannot do for you:

- **Secrets.** The definition is compiled into every copy of the build, so a literal token in `headers`,
  `oauth.clientSecret`, or `environment` ships to everyone. Use `{env:VAR}` or `{file:path}` instead. Both are
  substituted at config-load time, with relative `{file:}` paths resolved against the user's global config
  directory. `bundle generate` warns about the literals it can spot.
- **Installing the server.** For a `local` server, `command[0]` has to already exist on each user's machine.
  Remote servers have no such requirement, which is why they are the better fit for bundling.

### `skills`

Skills are vendored in this repository under `vsworker/skills/`, as **either a directory `<id>/` or a `.zip`
archive `<id>.zip`** holding one: `SKILL.md` plus whatever `scripts/` or `references/` files it needs. Every file
is inlined into the build and written to `~/.cache/vsworker/vsworker/skills/<id>/` the first time a build that
has skills enabled starts. They need a real directory on disk at runtime because the `skill` tool lists sibling
files and slash commands resolve relative paths.

```jsonc
// A directory at vsworker/skills/report-review/
{
  "id": "report-review",
  "description": "审核流程 the team follows for 可研报告",
},

// An archive at vsworker/skills/drilling-intervention-recommendation.zip. The entry is the same either way.
{
  "id": "drilling-intervention-recommendation",
  "description": "钻井事故与复杂情况处置措施推荐",
},

// Bundled but off until a user enables it. Set "path" only when the source is not at skills/<id>.
{
  "id": "hello",
  "defaultEnabled": false,
  "description": "Template and smoke test for skill bundling.",
},
```

A skill entry is short because most of it lives on disk. What the first entry above refers to:

```
vsworker/skills/report-review/
  SKILL.md          # required, and its frontmatter name must equal the entry's id
  env.json          # optional, see below
  scripts/…         # optional, anything the skill needs
  references/…
```

```markdown
---
name: report-review
description: Use when reviewing a 可研报告 against the team's checklist.
---

Body: the instructions the model reads once the skill loads.
```

The manifest entry is the same either way, so a skill that arrives from the 识油 platform as an archive is
dropped in as-is. `path` may name either form. Having both `skills/<id>/` and `skills/<id>.zip` is an error
rather than a precedence rule: the skills hash gates `bundle check`, so a machine missing one of the two would
otherwise produce a different hash with nothing on screen to explain it.

The frontmatter `name` must equal the `id`, and a `description` is required, because that is what the model picks
skills by. `vsworker/skills/` is listed in the repo's `.prettierignore`, so a vendored skill keeps the exact bytes
it was imported with. Editor and interpreter droppings are not bundled: `__pycache__/`, `*.pyc`, `*.pyo`,
`.DS_Store`, `Thumbs.db`, `._*` AppleDouble sidecars, `__MACOSX/` and `.git/` are skipped, because they differ
per machine and would make the skills hash disagree between the machine that ran `generate` and CI.

#### Archives

An archive is a **build-time source format only**. `bundle generate` reads it, inlines the files it holds, and
`bundle check` re-reads it; nothing ships as an archive and nothing is unpacked on a user's machine.

- Either wrap the files in a single top-level directory (`zip -r <id>.zip <id>/`) or put `SKILL.md` at the
  archive root (`cd <id> && zip -r ../<id>.zip .`). A single wrapping directory is stripped; anything else is
  left alone, so an archive with two top-level directories fails for want of a `SKILL.md`. The wrapper does not
  have to be named `<id>` — `SKILL.md`'s `name` is what settles identity — but a mismatch is warned about.
- The executable bit comes from the archive's own Unix mode, so it is the same on every machine. An archive
  written on Windows carries no mode and nothing in it is executable. Nothing else about the host is read, which
  makes an archive marginally _safer_ than a directory for hash stability: `core.autocrlf` cannot rewrite bytes
  inside a `.zip`, and a case- or Unicode-normalizing filesystem cannot rename its entries.
- An entry that escapes the skill (`../`), a duplicate name, a symlink entry, an encrypted entry, or a non-ASCII
  name not flagged UTF-8 is refused at build time rather than guessed at.
- A `.gitignore` cannot reach inside an archive, so the skip list above is the only thing keeping junk out of
  the build. `generate` prints one warning per archive naming what it dropped.

#### `env.json`

A skill may carry an `env.json`, in its directory or inside its archive. Its pairs become environment variables
for the bash commands that run in that skill. The shape comes from the 识油 platform, which parses the same file when it registers a skill: a
**flat** JSON object, no comments, no grouping, no nesting.

```jsonc
{ "PLATFORM_BASE_URL": "http://10.68.199.207", "QA_THRESHOLD": "0.69", "GRAPH_ENABLED": "1" }
```

- Values may be strings, numbers, booleans (`true` → `"1"`), or `null` (→ `""`). Anything else is an error.
- Keys must look like environment variables, `[A-Za-z_][A-Za-z0-9_]*`. A leading `_` is exported like any other
  key, because the platform does the same.
- A file with **any** problem exports nothing, rather than half a configuration, and logs one warning. The
  warning is not repeated until the file changes.
- `{env:VAR}` and `{file:path}` are substituted per machine at load time, exactly as in a bundled MCP definition.
  Note that a vendored skill's own scripts usually read `env.json` directly too, and they see the placeholder
  text, not the substituted value. Use placeholders only for variables the host alone consumes.

**Scope.** A skill's variables reach a bash command when the command runs in that skill: its working directory is
the skill directory (or below it), or its command line names a path inside it, absolute, relative to the working
directory, or under `~`. A bare word never matches, so unrelated commands are untouched. Two skills therefore
never collide over a variable name.

**Precedence.** Skill variables override the inherited environment and anything a plugin sets through
`shell.env`; a `KEY=value cmd` prefix inside the command still wins after that, by shell rules. Because they
override, a key like `PATH` or `HOME` in an `env.json` will replace the real one: name variables for the skill.

This applies to any skill the host discovers, not just bundled ones. A colleague who drops a skill directory
into `~/.config/vsworker/skills/<name>/` gets the same behaviour, which is how a skill is customised: copy the
bundled directory there, edit its `env.json`, and the disk copy wins by name.

**Overriding a bundled skill's variables.** `vsworker.skill_env.<id>` in `opencode.json` holds per-variable
overrides, layered over the skill's own `env.json` for exactly the same commands. This is what the desktop
client's **Environment** button writes, and it is the way to change a bundled skill's configuration without
copying the whole directory: the cache the build materializes into is rewritten whenever the bundle changes, so
an edit made there does not survive an upgrade.

```jsonc
{ "vsworker": { "skill_env": { "drilling-intervention-recommendation": { "PLATFORM_BASE_URL": "http://10.0.0.5" } } } }
```

- Global and project values merge **per variable**, project winning, so a project can retarget one address
  without restating the rest.
- Values are substituted at config load, so `{env:VAR}` works here even for a vendored script that reads
  `env.json` literally and would otherwise see the placeholder text.
- A variable the skill reads but does not ship can be set this way too; it does not have to appear in `env.json`.
- Overrides apply to whichever skill of that name is loaded, and they apply even when the skill ships no
  `env.json` at all.

Precedence, highest first: a `KEY=value` prefix on the command, then `vsworker.skill_env`, then the skill's
`env.json`, then a plugin's `shell.env`, then the inherited environment.

The `skill` tool tells the model which variables a skill provides, by name only. `bundle validate` and
`bundle generate` parse a vendored `env.json` with the same parser the product uses, so a file that loads at build
time loads at runtime, and they warn when a key that looks like a credential carries a literal value.

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
bun run --cwd vsworker bundle import skill <name> [--from <dir|file.zip>] [--force]
```

`import mcp` reads `~/.config/vsworker/opencode.json` (or `--from`), accepts both the flat and the
`mcp.servers` shapes, moves `enabled` into `defaultEnabled`, and warns about literal secrets. `import skill`
copies `~/.config/vsworker/skills/<name>` or `<name>.zip` into `vsworker/skills/` under the same name, reading
`SKILL.md` out of the source first so an archive that imports is one that bundles. Both append to
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

Copy `plugins/hello/` or `skills/hello/` and add a manifest entry. The `hello` plugin is bundled with
`defaultEnabled: false`, as the smoke test for this pipeline, so a release is unaffected until someone enables
it. The `hello` skill is on, so a build can be checked end to end without editing any config.

## Living next to the official OpenCode

VsWorker is installed alongside upstream opencode on the same machines, so it owns everything it writes:

|                            | VsWorker                                                                                        | official opencode                             |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Config, data, state, cache | `~/.config/vsworker`, `~/.local/share/vsworker`, `~/.local/state/vsworker`, `~/.cache/vsworker` | the same paths under `opencode`               |
| Database                   | `opencode-vsworker.db`                                                                          | `opencode.db`                                 |
| Desktop app                | `VsWorker.app`, bundle id `com.vsworker.desktop`                                                | `OpenCode.app`, `ai.opencode.desktop`         |
| Windows install dir        | `%LOCALAPPDATA%\Programs\vsworker-desktop`                                                      | `%LOCALAPPDATA%\Programs\@opencode-aidesktop` |
| Updater                    | frozen                                                                                          | npm / brew / curl                             |

On Windows the same separation holds, through the same two settings. `xdg-basedir` has no Windows special
case, so the four directories become `%USERPROFILE%\.config\vsworker` and its siblings, and the app id decides
the Electron user data directory (`%APPDATA%\com.vsworker.desktop`), the AppUserModelID that groups taskbar
windows and Start menu pins, and the uninstall entry in the registry. The NSIS install directory and the
updater cache come from `extraMetadata.name` instead, which is why it is set to `vsworker-desktop`: a one-click
per-user installer names its directory after the package, not the product. Upstream sets no such name, so the
official installer lands somewhere else entirely.

The directory name is `app` in `packages/core/src/global.ts`. Project-level `.opencode/` directories and the
`opencode.json` filename stay shared on purpose: those belong to a repository, not to an install. Authentication
is therefore per product, and providers are logged in once inside VsWorker.

The updater is frozen because every release feed upstream knows about serves opencode: an auto-update would
replace a VsWorker build with stock opencode, and `uninstall` would run `npm uninstall -g opencode-ai` against the
package the user separately installed. `Installation.method()` reports `unknown`, `latest()` reports the running
version, and `upgrade()` refuses (`vsworker/src/release.ts`). Source runs and tests, which use the channel
`local`, keep upstream behaviour. The desktop `vsworker` channel has no publish target and no Electron updater.

Both apps still register the `opencode://` URL scheme, on macOS and on Windows; VsWorker does not rely on
deep links, so whichever app the system picks is harmless. On Windows the WSL sidecar resolves an `opencode` inside a WSL
distribution, which is a separate Linux install the user set up, not the Windows app next door.

### Building the desktop app

[PACKAGING.md](./PACKAGING.md) is the build runbook: prerequisites, the macOS and Windows commands, what each
environment variable decides, the artifact list, how to verify a build actually carries the bundle, and
troubleshooting. There are two routes to a Windows client: cross-building on macOS, and building natively on a
Windows PC. The native one needs fewer environment variables but adds a C++ toolchain and two git settings of
its own. The short version is that every surface keys off `OPENCODE_CHANNEL=vsworker`, macOS builds are ad-hoc
signed because the fork has no Developer ID, and Windows builds are unsigned either way, so SmartScreen warns on
first run.

## Managing all of this from the desktop client

Settings (`cmd+,`) has an **Extensions** section with **Plugins**, **Skills**, and **MCP servers** tabs. Each tab
lists what this build bundles alongside what the user declared, and writes changes back to the same
`opencode.json(c)` keys the CLI uses, so the UI, the CLI, the TUI, and a hand edit can never disagree.

- Every tab has one **Global / Project** switch that decides which file a change lands in, resolved the same way
  `opencode vsworker … -g` resolves it.
- Writes are surgical `jsonc-parser` edits under a file lock, so comments and formatting survive.
- Each list carries the revision of the file it read. A write pins itself to that revision and is refused with a
  409 if the file changed underneath, rather than overwriting someone else's edit.
- After a write the instance is disposed, which is what makes a toggled MCP server or plugin actually start or
  stop; the UI refetches when the resulting `global.disposed` event arrives.
- Skills the user owns are real directories: `~/.config/vsworker/skills/<name>/SKILL.md` globally, or
  `<worktree>/.opencode/skills/<name>/SKILL.md` for a project. Bundled skills, `~/.claude/skills`, and anything
  pulled from a `skills.urls` index are listed read-only, because they are not ours to rewrite.
- A bundled MCP server can be copied into the user's config to be edited. That is a fork in the road, not a
  patch: the copy stops following the build, exactly as the precedence rules above describe.
- A bundled skill's **Environment** button edits `vsworker.skill_env.<id>` rather than the skill's own files:
  the packaged values are shown as the placeholder of each field, and only what the user actually changed is
  written, so a later build is free to move anything they left alone. Values that look like credentials stay
  covered until asked for.

The routes are `GET|POST|PATCH|PUT|DELETE /vsworker/{plugin,skill,skill-source,mcp}`, declared in
`packages/opencode/src/server/routes/instance/httpapi/groups/vsworker.ts`. They are part of the generated SDK,
so `./script/generate.ts` has to run after any change to them. `vsworker/UPSTREAM.md` lists the five seams this
feature adds.

## One known gap

Bundled skills are registered with the legacy skill service, which is what the model, the `skill` tool, slash
commands, and the TUI's `/skills` dialog all use. The V2 skill service in `packages/core/src/skill.ts` does not
see them. That service has no TUI consumer today and does not scan `~/.claude/skills` either, so nothing a user
can observe is missing; revisit this when V2 takes over skill listing.
