# Packaging the VsWorker desktop client

**English** | [简体中文](./PACKAGING.zh.md)

This is the complete build runbook for the **macOS and Windows desktop clients**: from putting a skill, plugin or
MCP server into the bundle, through producing a `.dmg` / `.exe`, to verifying that the artifact really carries
what you put in.

How the three documents divide the work:

| Document                     | Covers                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ |
| [README.md](./README.md)     | What `bundle.jsonc` accepts, how a user turns an entry off, runtime load order |
| **PACKAGING.md** (this file) | How that content gets into a macOS / Windows client                            |
| [UPSTREAM.md](./UPSTREAM.md) | How not to lose the fork's changes when merging upstream                       |

> `packages/desktop/README.md` is an upstream leftover. Its `bun run build && bun run package` carries **no
> channel**, so following it produces a "VsWorker Dev" on the `dev` channel with appId `ai.opencode.desktop.dev`
> — not a distributable VsWorker. This file is the authority.

---

## 0. The artifact pipeline, first

"Packaging" is really two things in sequence: **compile the bundle content into code**, then **put that code
inside an Electron shell**.

```
vsworker/bundle.jsonc
  │   bun run --cwd vsworker bundle generate
  ▼
vsworker/src/{server,tui,mcp,skills}.gen.ts        ← a skill's file contents become string literals here
  │   statically imported by packages/opencode/src/{plugin/index.ts, config/config.ts, skill/index.ts, tool/shell.ts}
  ▼
packages/opencode/dist/node/node.js                ← bun script/build-node.ts (triggered by desktop's prebuild)
  │   electron-vite's virtual:opencode-server plugin pulls it into the main bundle
  ▼
packages/desktop/out/main/{index,sidecar}.js + out/main/chunks/node-*.js   ← the server lands in a chunk
  │   npx electron-builder
  ▼
VsWorker.app / vsworker-desktop-win-x64.exe
```

Three conclusions worth remembering:

- **A skill does not sit as files in the app's resource directory.** Every one of its files is read as a string
  into the `data:` field of `vsworker/src/skills.gen.ts` (see that file's header comment) and compiled into JS.
  Only at runtime does `materialize()` in `vsworker/src/skills.ts` unpack it to
  `~/.cache/vsworker/vsworker/skills/<id>/`, because the skill tool needs a real directory. A plugin is
  `import * as m0 from "../plugins/hello/index.ts"`, an MCP server is a JSON constant — both likewise compiled in.
- **Skip `bundle generate` and your change is not in the artifact.** After editing `bundle.jsonc` or
  `vsworker/skills/**` you must regenerate. `bundle check` in `.github/workflows/vsworker.yml` is the gate.
- **The 144 MB `resources/opencode-cli` binary is not in a vsworker artifact.**
  `packages/desktop/scripts/prebuild.ts:11` downloads it only when `channel === "dev"`, and the `files` array at
  `electron-builder.config.ts:75` carries a `"!resources/opencode-cli*"`. It is something `bun run dev` leaves in
  your working tree. VsWorker's server is the copy compiled into `out/main/sidecar.js`.

---

## 1. Prerequisites

- **Bun 1.3.14 or newer.** `packages/script/src/index.ts:13-18` builds the range `^1.3.14` from the root
  `package.json` `packageManager` field and throws if it is not satisfied, so the build fails at the first step.
  Note it is a **range** (`>=1.3.14 <2.0.0`), not an exact pin.
- **Node 22 or newer** (needed by `npx electron-builder`). `.github/actions/setup-bun/action.yml:11-16` explains
  the floor: native install scripts invoke `node-gyp`, which requires Node ≥ 22. CI uses 24; this machine has
  v24.13.0.
- One `bun install` at the repo root. **On Windows add `--linker hoisted`** — see §4.2.
- The first `electron-builder` run downloads two sets of things, about 165 MB together, with **no progress
  output**. Do not assume it has hung:
  - the Electron 42.3.3 runtime (~141 MiB) → `~/Library/Caches/electron` on macOS,
    `%LOCALAPPDATA%\electron\Cache` on Windows
  - electron-builder's own NSIS / 7-Zip toolsets → `~/Library/Caches/electron-builder` on macOS,
    `%LOCALAPPDATA%\electron-builder\Cache` on Windows
- The platform matrix:

  | Build host    | mac                       | win x64                | win arm64                            | linux    |
  | ------------- | ------------------------- | ---------------------- | ------------------------------------ | -------- |
  | macOS arm64   | arm64 native / x64 cross  | cross (§4.1, verified) | cross                                | untested |
  | Windows x64   | **no** (needs `codesign`) | **native** (§4.2)      | cross (needs `OPENCODE_TARGET_ARCH`) | no       |
  | Windows arm64 | no                        | cross                  | native                               | no       |

- The directory `packages/desktop/native/` **does not exist** in this repository, so the `extraResources` entry
  pointing at it (`electron-builder.config.ts:86-90`) is silently skipped. **That is normal** — both platforms
  build successfully this way, and `bun run native:build` has no use here.

---

## 2. Step one: putting a skill / plugin / MCP server into the bundle

The full field reference is in [README.md](./README.md). This section only covers what you have to do at
packaging time.

### 2.1 Skill

A skill is vendored under `vsworker/skills/`, as **either a directory `<id>/` or a zip archive `<id>.zip`**
holding one. The manifest entry is identical either way.

- `SKILL.md` is required, its frontmatter `name` must **equal** the manifest `id`, and `description` cannot be
  empty.
- An optional `env.json` (flat JSON; bash commands running inside that skill directory receive these environment
  variables — see README's `#### env.json`).
- Anything else is up to you: `scripts/` and `references/` are bundled along with it.

Hard constraints, from `vsworker/script/skill-source.ts`:

- **No symlinks** — the error reads `is a symlink. A bundled skill has to be self-contained.`
- Skipped automatically: `__pycache__/`, `.git/`, `.DS_Store`, `Thumbs.db`, `.gitkeep`, `*.pyc`, `*.pyo`,
  `__MACOSX/`, `._*` (macOS AppleDouble sidecars)
- Size warnings: a single file over 256 KiB, or a skill over 1 MiB
- One `<id>` **cannot be both a directory and a zip** — that is an error, not a precedence rule

A few more for a zip, from `readArchive`:

- Either wrap everything in a single top-level directory (`zip -r <id>.zip <id>/`) or put `SKILL.md` at the
  archive root (`cd <id> && zip -r ../<id>.zip .`). A **single, unambiguous** top-level directory is stripped;
  anything else is left as it is. The wrapper need not be named `<id>` — `SKILL.md`'s `name` settles identity —
  but a mismatch produces a warning.
- The executable bit comes from the Unix mode recorded in the archive, not from the machine doing the packaging.
  A zip written on Windows carries no mode, so nothing in it is executable.
- **A zip is a build-time source format only**: `bundle generate` reads it and inlines the contents into
  `skills.gen.ts`. No zip ships in the artifact and nothing is unpacked on a user's machine.
- `.gitignore` cannot reach inside a zip, so the skip list above is the only defence. `generate` prints one
  warning per archive naming what it dropped.

Two ways to add one:

```bash
# A. Vendor one out of your own global skills directory (edits bundle.jsonc and regenerates for you)
#    Both <dir> and <file.zip> are accepted
bun run --cwd vsworker bundle import skill <name> [--from <dir|file.zip>] [--force]

# B. By hand: create vsworker/skills/<id>/, or drop <id>.zip straight into vsworker/skills/,
#    then add an entry to the skills array in bundle.jsonc
#    { "id": "<id>", "description": "why it is bundled" }
```

### 2.2 Plugin

`source` is one of three: `local` / `npm` / `github`.

- **`local` is the least trouble** and the recommended shape for in-house plugins: the entrypoint is always
  `vsworker/plugins/<id>/index.ts`. Copy `vsworker/plugins/hello/index.ts` to start.
- `npm` needs an exact version (ranges are rejected); `github` needs `repo` plus a full 40-character `ref`.

A bundled plugin has five authoring prohibitions (native modules, `import.meta.dir`, dynamic import, `Bun.*` /
`$`, `oc-themes`) — see README's `## What a bundled plugin may do`. They exist because it is compiled into a
bundle, not installed at runtime.

### 2.3 MCP server

Each entry's `config` is exactly the `mcp.<id>` value from `opencode.json`, copied verbatim.

- **Do not hardcode secrets.** Use `{env:VAR}` or `{file:path}`; both are substituted at config-load time. The
  generator scans for `token|secret|key|password|passwd|credential|auth` and warns.
- `config.enabled` is **rejected outright** by manifest validation: use the outer `defaultEnabled` to control the
  default.
- What ships is **the definition, not the server**: for a `type: "local"` entry, `command[0]` has to already exist
  on every user's machine.

```bash
bun run --cwd vsworker bundle import mcp <name> [--from <file>] [--id <id>] [--off]
```

### 2.4 Generate and check

```bash
bun run --cwd vsworker bundle generate       # rewrites src/*.gen.ts, bundle.schema.json, package.json deps
bun run --cwd vsworker bundle check          # should print bundle is up to date (…), with the current entry count
bun run --cwd vsworker bundle check --seams  # should print all 19 seams present
```

The `bun install` inside `generate` **only runs when a non-local plugin exists**
(`vsworker/script/bundle.ts:508`), so a pure local-plus-skill change never touches `bun.lock`.

> **Do not run `bundle generate` on Windows** — see the boxed note at the end of §4.2. `bundle check` is fine.

**Commit checklist** (miss one and CI goes red):

```
vsworker/bundle.jsonc
vsworker/src/{server,tui,mcp,skills}.gen.ts
vsworker/bundle.schema.json
vsworker/package.json
vsworker/skills/**          # any skill you added or changed
bun.lock                    # only changes when a non-local plugin changes
```

---

## 3. Step two: building the macOS client

```bash
cd packages/desktop
export OPENCODE_CHANNEL=vsworker
export OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
bun run build
npx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts
```

That builds arm64 on Apple Silicon, i.e. **a native build**. Building an **Intel (darwin-x64) package is a cross
build**, and like the Windows one in §4.1 it needs the right `node-pty` installed and electron-vite told about the
target architecture — changing the electron-builder flag alone is not enough:

```bash
bun install --cwd packages/desktop --os=darwin --cpu=x64 "@lydell/node-pty-darwin-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=darwin OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --mac --x64 --publish never --config electron-builder.config.ts
```

### What `OPENCODE_CHANNEL=vsworker` actually decides

This is the easiest thing to get wrong: **four independent resolvers** each read this variable and each controls
something different. Because `bun run build` and `npx electron-builder` are two separate commands, both have to
see it — hence `export` (`$env:` on Windows, see §4.2).

| Read at                                          | Decides                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/desktop/scripts/utils.ts:12`           | which icons / metainfo prebuild uses, and whether to download the CLI          |
| `packages/desktop/electron.vite.config.ts:8`     | the `import.meta.env.OPENCODE_CHANNEL` injected into the main bundle           |
| `packages/desktop/electron-builder.config.ts:32` | appId `com.vsworker.desktop`, productName `VsWorker`, no publish, mac signing  |
| `packages/app/vite.js:8`                         | the renderer; `vsworker` maps to `prod`, so there is no DEV badge or debug bar |

A knock-on effect: `UPDATER_ENABLED` in `src/main/constants.ts` is true only for `beta` / `prod`, so **a vsworker
build has no auto-updater** and "Check for updates" is greyed out in the menu. That is deliberate — every
upstream update feed serves opencode, so an auto-update would replace VsWorker with opencode.

### Why `OPENCODE_VERSION` has to be set explicitly

Without it, `packages/script/src/index.ts:26-36` decides this is a preview build and the version becomes
`0.0.0-vsworker-<UTC timestamp>`. That value goes into both `extraMetadata.version` (the app's version) and the
server bundle, so set something meaningful and the app and the server inside it report the same number.

The convention is `<upstream version>-vsworker.<UTC timestamp>`, e.g. `1.18.30-vsworker.202609130958`.

### What `bun run build` does

Bun's pre-script convention runs `prebuild` first (`packages/desktop/scripts/prebuild.ts`, four steps):

1. `copy-icons.ts vsworker` — the vsworker channel reuses the `icons/prod` artwork (`copy-icons.ts:8` has the
   comment: only the name and bundle id differ), copied into the gitignored `resources/icons`.
2. `copy-metainfo.ts vsworker` — writes `resources/com.vsworker.desktop.metainfo.xml` (used on Linux).
3. **`cd ../opencode && bun script/build-node.ts`** — this is where §0's pipeline lands:
   `packages/opencode/src/node.ts`, together with the `vsworker/src/*.gen.ts` files it statically imports, is
   bundled into `packages/opencode/dist/node/node.js`. **This is the step where the bundle enters the artifact.**
4. Only the dev channel downloads the CLI — vsworker skips it.

Then `electron-vite build` produces three outputs: main (`index.js` + `sidecar.js`), preload, and renderer.

### Artifacts

All under `packages/desktop/dist/`:

```
vsworker-desktop-mac-arm64.dmg          # distribute this one
vsworker-desktop-mac-arm64.dmg.blockmap
vsworker-desktop-mac-arm64.zip
vsworker-desktop-mac-arm64.zip.blockmap
mac-arm64/VsWorker.app                  # the unpackaged .app; double-click it to try the build locally
```

The names come from `artifactName: "vsworker-desktop-${os}-${arch}.${ext}"`.

### Signing and notarization

The vsworker channel defaults to `identity: process.env.CSC_NAME ?? "-"`, i.e. **ad-hoc signing**: Apple Silicon
will not launch a completely unsigned bundle, and ad-hoc satisfies the loader without asserting an origin.
`notarize` and `dmg.sign` both follow `Boolean(process.env.CSC_NAME)`, so neither happens by default.

To sign and notarize properly (assuming you have a Developer ID):

```bash
export CSC_NAME="Developer ID Application: <your name> (<TEAMID>)"
export APPLE_API_KEY=/path/to/AuthKey_XXXX.p8
export APPLE_API_KEY_ID=XXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**What to tell people when it is not properly signed**: an ad-hoc signed app copied to someone else's machine is
blocked by Gatekeeper on first open. They need right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/VsWorker.app`. Send that sentence along with the installer.

---

## 4. Step three: building the Windows client

Two routes: cross-build on macOS (§4.1, the one verified on this machine), or build natively on a Windows PC
(§4.2). **The native route is the simpler one** — two fewer environment variables, no cross-platform
`bun install`, no cleanup step — but it has a few prerequisites macOS does not.

### 4.1 Cross-building on macOS

#### Why two extra environment variables

`node-pty` is a **prebuilt native module**, one npm package per platform, and the main bundle imports it
**statically**. `electron-vite` cannot see `electron-builder`'s `--win` flag — they are two separate commands and
the former runs first — so `electron.vite.config.ts:15-21` has to be told the target platform explicitly:

```ts
const targetPlatform = process.env.OPENCODE_TARGET_PLATFORM || process.platform
const targetArch = process.env.OPENCODE_TARGET_ARCH || process.arch
const nodePtyPkg = `@lydell/node-pty-${targetPlatform}-${targetArch}`
```

**Get either one wrong and the app imports a module that is not inside it, the moment it starts.** The package
also has to actually be installed — `bun install` only installs the optional dependency matching the current
machine.

#### Commands

```bash
bun install --cwd packages/desktop --os=win32 --cpu=x64 "@lydell/node-pty-win32-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker
export OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=win32 OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
```

The version `1.2.0-beta.12` comes from the catalog in the root `package.json` and from
`optionalDependencies` in `packages/desktop/package.json`; the two must agree.

**arm64 Windows**: replace all three `x64` with `arm64`, use the package `@lydell/node-pty-win32-arm64`, and pass
`--win --arm64` to electron-builder.

#### Two things to do afterwards

```bash
bun install                 # back at the repo root, drop the foreign-platform module
```

- `out/` **only holds the last target platform you built**. Re-run `bun run build` before packaging for a
  different platform, or electron-builder puts the previous platform's main bundle inside the new shell.
- Cross-building leaves both the host and the target copy of node-pty in
  `packages/desktop/node_modules/@lydell/` (the Windows package ends up carrying the darwin-arm64 one too —
  harmless, just wasted space). Run `bun install` afterwards to restore. The native route has neither problem,
  and its `.exe` is correspondingly leaner.

### 4.2 Building natively on a Windows PC

> **This section has not yet been run end to end on a physical Windows machine.** The commands and prerequisites
> below are derived from the Windows matrix in `.github/workflows/publish.yml`, from `electron-builder`'s source,
> and from this repository's configuration. CI proves that `bun install` / `bun run build` /
> `npx electron-builder --win` do work on Windows — but on the `prod` channel. The `OPENCODE_CHANNEL=vsworker`
> artifact, installing the resulting installer, and the PowerShell commands in this section and §5 are all
> untested. **Once someone runs it, delete this note and turn the `[derived]` markers into observed facts.**
>
> Each claim carries its provenance: `[from CI]` = the Windows matrix in `publish.yml` actually executes it;
> `[derived]` = read straight from this repo's config or source, logically certain; `[unverified]` = plausible,
> nobody has run it.

#### Commands (PowerShell 7)

```powershell
# repo root, once (see the prerequisites below for why --linker hoisted)
bun install --linker hoisted

cd packages\desktop
$env:OPENCODE_CHANNEL = "vsworker"
$env:OPENCODE_VERSION = "1.18.30-vsworker.$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))"
bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
```

Compared with §4.1, **what is missing is the point**:

- **No `OPENCODE_TARGET_PLATFORM` / `OPENCODE_TARGET_ARCH`.** When those are unset,
  `electron.vite.config.ts:19-21` falls back to `process.platform` / `process.arch`, which on an x64 Windows host
  are already `win32` / `x64` — yielding exactly `@lydell/node-pty-win32-x64`. The whole rationale in §4.1 does
  not apply here. `[derived]` + `[from CI]`: the Build step at `publish.yml:320-333` sets neither variable on
  either Windows matrix row.
- **No `bun install --cwd packages/desktop --os=win32 --cpu=x64 …`.** `publish.yml:235-250` gives
  `bun_install_flags` only to the two macOS rows; the Windows rows have none, because a local `bun install`
  already resolves the matching optional dependency. `[from CI]`
- **No cleanup `bun install`.** No foreign-platform module was ever installed, and the artifact carries only the
  `win32-x64` copy. `[derived]`

Two notes on the syntax:

- `$env:VAR = "…"` is the `export` equivalent: it sets the variable on the current PowerShell process, so both
  `bun run build` and `npx electron-builder` inherit it as child processes. §3's point that both commands must
  see `OPENCODE_CHANNEL` holds here too.
- `$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))` is the exact equivalent of `$(date -u +%Y%m%d%H%M)`. Do
  **not** use `Get-Date -UFormat` (deprecated in PS 7), and do **not** use `Get-Date -Format` without
  `.ToUniversalTime()` — that gives local time.

#### arm64 Windows

On an **arm64 Windows host**, the sequence above is unchanged except for `--win --arm64` (`process.arch` is
already `arm64`). `[unverified]`

On an **x64 Windows host targeting arm64** it is a cross build, and all of §4.1 comes back:

```powershell
bun install --linker hoisted --cwd packages\desktop --os=win32 --cpu=arm64 "@lydell/node-pty-win32-arm64@1.2.0-beta.12"
cd packages\desktop
$env:OPENCODE_CHANNEL = "vsworker"
$env:OPENCODE_VERSION = "1.18.30-vsworker.$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))"
$env:OPENCODE_TARGET_ARCH = "arm64"     # required: process.arch is x64
bun run build
npx electron-builder --win --arm64 --publish never --config electron-builder.config.ts
cd ..\..
bun install --linker hoisted            # restore: drop the foreign-arch node-pty
```

> **`$env:` persists for the whole PowerShell session.** Before building x64 again after an arm64 build, either
> open a fresh `pwsh` or run `Remove-Item Env:\OPENCODE_TARGET_ARCH`, or the next `bun run build` silently
> re-targets arm64. And since `out/` only holds the last target platform, always re-run `bun run build` when
> switching — easier to trip over on Windows than on macOS, because flipping between the two architectures is
> routine there.

#### Windows-only prerequisites

Everything in §1 still applies. These are the ones **only Windows has**:

**`bun install` needs `--linker hoisted`.** `.github/actions/setup-bun/action.yml:56-66` does this on Windows
only, with a comment pointing at bun#28147 and the patched peer dependencies in `patches/` (this repo has 19
`patchedDependencies`). `[from CI]`. Two things neither doc makes obvious:

- **The flag is not sticky.** Any later bare `bun install` reverts to the default isolated linker, so pass it
  **every** time — including the `--cwd packages\desktop` one in the arm64 variant above. `[derived]`
- **`bundle generate` can undo it.** `vsworker/script/bundle.ts:490-494` spawns a bare `bun install`. Today
  `bundle.jsonc` has no non-`local` plugin so that path is unreachable (`bundle.ts:507`), but it will bite once
  one is added. `[derived]`

**Install Visual Studio 2022 Build Tools (Desktop development with C++) and Python 3.** The intuition that
everything is prebuilt is wrong for exactly one package: `tree-sitter-powershell@0.25.10` (a direct dependency at
`packages/opencode/package.json:145`) declares `"install": "node-gyp-build"`, but its published tarball ships
**no** `prebuilds/` directory, so it falls through to `node-gyp rebuild` and compiles from source — and it is in
the root `package.json` `trustedDependencies`, so bun always runs its install script. `[derived]`
The `windows-2025` runners come with MSVC and Python preinstalled, which is why CI has no install step for them
— **that must not be read as "not needed"**. Python 3.12+ additionally needs
`python -m pip install setuptools`, since `distutils` was removed; that is exactly what CI does at
`setup-bun/action.yml:52-54`. `[from CI]`

Every other native dependency is download-only or pure JS: `esbuild`'s postinstall fetches a binary,
`electron@42.3.3` has no `scripts` field at all, and `@parcel/watcher`'s `install` script is not in
`trustedDependencies` so bun never runs it (the per-platform prebuilt packages cover it). The root `postinstall`
calls `packages/core/script/fix-node-pty.ts`, whose entire body is wrapped in `if (process.platform !== "win32")`
(line 11), so on Windows it runs and does nothing. `[derived]`

**Run `git config --global core.autocrlf false` before cloning.** This is the sleeper failure. There is no
`* text=auto` anywhere — the root `.gitattributes` has only two `linguist-generated` lines — while the Git for
Windows installer defaults `core.autocrlf` to `true`. The consequences:

1. `bundle check` reports all four `*.gen.ts` as stale on a freshly cloned tree, because `bundle.ts:497-500`
   compares prettier's output (LF by default) against the bytes on disk. `[derived]`
2. Worse is "fixing" that with `bundle generate`: `resolveSkill` reads `SKILL.md` and each script as raw bytes
   (`bundle.ts:297-301`) and writes them through `JSON.stringify` into the `data:` field (`bundle.ts:346-348`),
   so every CRLF becomes a literal `\r\n` permanently baked into `skills.gen.ts`. **That corruption reaches
   users** — `materialize()` writes `data` back to disk verbatim. `[derived]`

**Enable Developer Mode and `git config --global core.symlinks true` before cloning.** The repo tracks 60
symlinks; 55 of them are `packages/*/public/*` (favicons, social share images, `site.webmanifest`), and
`packages/app/public` is the renderer's `publicDir` (`electron.vite.config.ts:101`). If they are not
materialized they become one-line text files — **the build still succeeds and ships an app with broken icons and
manifest**. `core.symlinks` is sampled at clone time; changing it afterwards requires a fresh checkout.
`[derived]`

**Long paths.** The deepest relative path under the isolated linker is 200 characters, dropping to about 148 with
`--linker hoisted`; the repo's own deepest source path is 127. Add the clone root and electron-builder's NSIS
staging directory on top and the 260-character MAX_PATH is not far away. Cheap insurance:

```powershell
git config --system core.longpaths true
# elevated, once per machine:
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1
```

and prefer a short clone root like `C:\dev\`. `[derived]` for the measurements, `[unverified]` for whether it
actually breaks without them.

**Defender exclusions.** `node_modules` is 3.1 GB across roughly 2,400 packages, the Electron zip is 141 MiB, and
NSIS reads the whole tree again while building the installer — real-time scanning inspects every one of those
writes. Recommended (elevated): `Add-MpPreference -ExclusionPath` for the repo, `%LOCALAPPDATA%\electron`,
`%LOCALAPPDATA%\electron-builder` and `%LOCALAPPDATA%\Temp`, plus
`Add-MpPreference -ExclusionProcess bun.exe, node.exe`. Without them, expect `bun install` and the first
`electron-builder` run to be several times slower than on macOS. `[unverified]`

**PowerShell 7 is not required to build** — 5.1 works. Nothing spawns `pwsh` off CI; both places that would
(`electron-builder.config.ts:21-30` and `scripts/utils.ts:88-90`) are behind CI guards. Install 7 anyway, because
the verification snippets in §5 use `[System.Text.Encoding]::Latin1` (.NET 5+); the 5.1 equivalent is
`[System.Text.Encoding]::GetEncoding(28591)`. `[derived]`

#### Artifacts and how it installs

Identical to §4.1, because the `win` and `nsis` blocks in `electron-builder.config.ts` come from `getBase()` and
do not depend on the build host:

```
packages\desktop\dist\vsworker-desktop-win-x64.exe           # the NSIS installer, distribute this one
packages\desktop\dist\vsworker-desktop-win-x64.exe.blockmap
packages\desktop\dist\win-unpacked\                          # the unpacked directory, useful for inspection
```

`nsis.oneClick: true` plus `perMachine: false` means **a one-click, per-user install**: no directory prompt, and
it lands in `%LOCALAPPDATA%\Programs\vsworker-desktop`.

That directory name comes from `extraMetadata.name` (`"vsworker-desktop"`), **not** from productName — a
one-click per-user installer names its directory after the package rather than the product. Without the override,
the workspace name `@opencode-ai/desktop` would produce `%LOCALAPPDATA%\Programs\@opencode-aidesktop`.

Data directories on Windows: `%USERPROFILE%\.config\vsworker` and its three siblings (`xdg-basedir` has no
Windows special case), and Electron's userData is `%APPDATA%\com.vsworker.desktop`. Nothing collides with the
official OpenCode; the comparison table is in README's `## Living next to the official OpenCode`.

#### Unsigned (for a different reason on Windows)

In §4.1, `signWindows()` (`electron-builder.config.ts:21-30`) is stopped by the **first** guard,
`process.platform !== "win32"`. On Windows that guard **passes**, and what actually stops signing is the second
one: `if (process.env.GITHUB_ACTIONS !== "true") return` (`:23`). The outcome is the same — a locally built
`.exe` has **no Authenticode signature**, and SmartScreen warns on first run (click "More info" → "Run anyway").
Say so when you send it to a colleague. `[derived]`

**So can I just set `GITHUB_ACTIONS=true`?** No, and it may break the build. Two outcomes:

- **Without pwsh 7 installed**: `electron-builder.config.ts:25-29` spawns `pwsh` and gets `ENOENT`. Nothing
  swallows that rejection — `winPackager.js:197` in `app-builder-lib` does `await this.signIf(file)`, which
  retries three times and then throws. **electron-builder fails the build.**
- **With pwsh 7 installed**: `script/sign-windows.ps1` runs, clears its own CI check at line 12, then reaches
  lines 23-26 and finds the three Azure Trusted Signing variables (`AZURE_TRUSTED_SIGNING_ENDPOINT` /
  `_ACCOUNT_NAME` / `_CERTIFICATE_PROFILE`) unset, prints `Skipping Windows signing…` and exits 0.
  electron-builder then records the file as signed even though nothing happened.

Bottom line: **setting `GITHUB_ACTIONS=true` never produces a signature and can break the build. Don't.**
`[derived]`

One counter-intuitive detail worth stating: the hook **is** invoked on every platform. In
`windowsSignToolManager.js:132-159`, `cscInfo` is null with no certificate, but because the custom
`signtoolOptions.sign` function exists, electron-builder does not take the "skip signing" branch — it calls our
function, which returns immediately. That is also why it never downloads the `winCodeSign-*` toolset.
`[derived]`

#### Do not run `bundle generate` on Windows

> `vsworker/script/bundle.ts:309` computes `executable` as
> `process.platform !== "win32" && (stat.mode & 0o111) !== 0` — **always `false` on win32**. NTFS has no execute
> bit and `core.filemode` defaults to `false` on Windows anyway; the explicit guard just makes it deterministic.
> The consequence: every `executable: true` entry in `vsworker/src/skills.gen.ts` is rewritten to `false`, and
> `export const hash` changes with it (`bundle.ts:332-344` notes that `executable` is part of the hash, so "a
> chmod alone still invalidates"). CI runs on `ubuntu-latest` (`.github/workflows/vsworker.yml:15`) where the
> execute bits are intact, so its byte-exact comparison fails: `Generated output is stale`.
>
> **To be honest about the blast radius**: there is **no user-visible impact today** — the existing skills are
> invoked as `python3 scripts/foo.py`, which does not need the execute bit. So this is a red-CI and
> repo-hygiene problem, not a functional one — until someone adds a skill whose instructions call
> `./scripts/foo.py` directly. A bundle generated on Windows would then ship a non-executable script that fails
> on macOS and Linux with `permission denied`.
>
> A contributor working on Windows should therefore:
>
> - Run `bun run --cwd vsworker bundle check` freely — it is read-only and platform-neutral, provided
>   `core.autocrlf` is `false`.
> - Edit `vsworker/bundle.jsonc` and `vsworker/skills/**` freely.
> - Have `bundle generate` run on macOS, Linux, or WSL2, and commit from there. (A WSL2 checkout on the Linux
>   filesystem is the cleanest answer: a real POSIX filesystem, so execute bits and LF both behave.)
> - If a Windows-generated `skills.gen.ts` gets committed by accident:
>   `git checkout -- vsworker/src/skills.gen.ts`, or `chmod +x` the scripts back on any POSIX machine and
>   regenerate.
>
> **The packaging commands in this section are unaffected** — `bun run build` only consumes the already-generated
> `*.gen.ts`.
>
> The real fix would be to derive `executable` from the git index mode (`git ls-files -s`) rather than
> `fs.stat`, making the generator host-independent. That has not been done.

---

## 5. Verifying the artifact really carries the bundle

Four layers, cheapest first. bash on macOS, PowerShell on Windows.

**① Search the compiled main bundle for the skill's string**

```bash
# macOS / Linux
grep -rl "well-intervention-recommendation" packages/desktop/out/main/
```

```powershell
# Windows
Get-ChildItem -Path packages\desktop\out\main -Recurse -File -Filter *.js |
  Select-String -Pattern "well-intervention-recommendation" -List |
  Select-Object -ExpandProperty Path
```

It should hit `packages/desktop/out/main/chunks/node-*.js` — that chunk is the server bundle pulled in by
`virtual:opencode-server`. **Search recursively**: the content is in the chunk, not in `index.js` or
`sidecar.js`, so a plain `grep out/main/*.js` returns nothing and looks like a failure. Substitute your own
skill's `id`.

In the PowerShell version **`-Filter *.js` is not optional**: `out/main/chunks/` also holds several MB of
`photon_rs_bg-*.wasm` and `tree-sitter-*.wasm`, and `Select-String` over those produces noise.

**② Search the packaged `app.asar`, confirming it reached what actually ships**

```bash
# macOS
grep -ac "well-intervention-recommendation" \
  packages/desktop/dist/mac-arm64/VsWorker.app/Contents/Resources/app.asar
# a cross-built Windows artifact can be checked the same way, from macOS
grep -ac "well-intervention-recommendation" packages/desktop/dist/win-unpacked/resources/app.asar
```

`-a` is needed because an asar is a binary container. A non-zero count is enough — this is the strongest check,
because it proves the content reached the artifact that gets distributed, not just an intermediate one.

On Windows, **a byte scan is the recommendation** — self-contained, no external tool:

```powershell
$asar   = "packages\desktop\dist\win-unpacked\resources\app.asar"
$needle = "well-intervention-recommendation"
$bytes  = [System.IO.File]::ReadAllBytes((Resolve-Path $asar))
$text   = [System.Text.Encoding]::Latin1.GetString($bytes)   # PS 5.1: [System.Text.Encoding]::GetEncoding(28591)
$n = 0; $i = 0
while (($i = $text.IndexOf($needle, $i)) -ge 0) { $n++; $i += $needle.Length }
"$n hit(s)"
```

Latin1 specifically, because it is a strict byte-to-character bijection: no byte sequence in the archive can be
dropped, merged, or turned into U+FFFD, the way a UTF-8 or ANSI decode can. The needle is pure ASCII, so it
survives the mapping unchanged.

For a quick yes/no, `findstr /M /C:"well-intervention-recommendation" <path>` works — it handles binary input
natively and `/M` behaves like `grep -l` — but it has no count and is unreliable on very long lines, so treat it
as a smoke test.

> **Do not** use a bare `Select-String -Path …app.asar`. It splits a NUL-laden, hundreds-of-MB blob into lines, a
> single "line" can be tens of MB, and the encoding heuristics differ between PS 5.1 (ANSI) and PS 7 (UTF-8). It
> may work, or it may silently miss — and the failure mode is a **false negative**, the worst possible outcome
> for a verification step.
>
> **Also do not search `dist\vsworker-desktop-win-x64.exe`.** The NSIS installer is LZMA-compressed end to end;
> searching inside it always returns 0 (measured). Only `win-unpacked\resources\app.asar` is searchable.

**③ Check the app's identity**

On macOS one `Info.plist` has everything:

```bash
plutil -p packages/desktop/dist/mac-arm64/VsWorker.app/Contents/Info.plist \
  | grep -E "CFBundleIdentifier|CFBundleName|CFBundleShortVersionString"
```

Expect `com.vsworker.desktop` / `VsWorker` / the `OPENCODE_VERSION` you set. Seeing
`ai.opencode.desktop.dev` or "VsWorker Dev" means `OPENCODE_CHANNEL` never reached the electron-builder command.

**Windows has no `plutil`, and no single file carries all three fields.** Check in several places, in this order:

```powershell
# (a) the exe's VersionInfo - the closest analogue, and it proves both CHANNEL and VERSION landed
(Get-Item packages\desktop\dist\win-unpacked\VsWorker.exe).VersionInfo |
  Format-List ProductName, FileDescription, CompanyName, FileVersion, ProductVersion, LegalCopyright
```

| Field             | Expected                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| `ProductName`     | `VsWorker` (a dev-channel build says `VsWorker Dev`)                             |
| `FileDescription` | `VsWorker`                                                                       |
| `FileVersion`     | the **full** `OPENCODE_VERSION`, e.g. `1.18.30-vsworker.202609151830`            |
| `ProductVersion`  | `1.18.30.0` — the prerelease part is stripped; **do not** check the version here |

```powershell
# (b) the cheapest check of all: the filename. A wrong channel gives win-unpacked\VsWorker Dev.exe
Get-ChildItem packages\desktop\dist\win-unpacked\*.exe

# (c) the only place appId appears verbatim
Select-String -Path packages\desktop\dist\builder-effective-config.yaml -Pattern "appId|productName"
```

(c) should show `appId: com.vsworker.desktop` / `productName: VsWorker`. **Note** that this file is written only
when `!isCI && process.stdout.isTTY` (`packager.js:298-302` in `app-builder-lib`), so run the build in an
interactive pwsh and do not pipe its output, or the file simply will not exist.

> **Do not** grep the asar for `com.vsworker.desktop` to determine the channel. The `APP_IDS` map at
> `packages/desktop/src/main/index.ts:60-66` compiles **all four** channels' app ids into every build, and `:128`
> additionally hardcodes the literal `"ai.opencode.desktop.dev"`. Finding one proves nothing.

**④ Open the app and look**

Open `VsWorker.app` / `VsWorker.exe` → Settings (`cmd+,` on macOS, `Ctrl+,` on Windows) → **Extensions** → the
Plugins / Skills / MCP servers tabs. Every bundled entry should be listed. This is the only way to verify that a
user can actually reach them.

> CI also has a CLI-side smoke test (`.github/workflows/vsworker.yml:47-56`, on `ubuntu-latest`): after
> `vsworker skills enable hello -g` it checks that `~/.cache/vsworker/vsworker/skills/hello/SKILL.md` is on disk.
> The desktop client uses the same `materialize()`, so that indirectly proves the unpacking logic — but it is not
> evidence about Windows.

---

## 6. Troubleshooting

### General

| Symptom                                                     | Cause                                                                                                | Fix                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `bundle check` reports stale                                | `bundle.jsonc` or `skills/**` changed without regenerating                                           | `bun run --cwd vsworker bundle generate` (not on Windows — see §4.2)          |
| `bundle check --seams` is missing a seam                    | an upstream merge ate a `// vsworker-seam` marker                                                    | restore it from the seam inventory in [UPSTREAM.md](./UPSTREAM.md)            |
| app crashes at startup, cannot find `@lydell/node-pty-*`    | `OPENCODE_TARGET_*` disagrees with electron-builder's platform flag, or the package is not installed | line up all the platform names in §4, re-run `bun run build`                  |
| the build is called "VsWorker Dev", appId ends in `.dev`    | electron-builder never saw `OPENCODE_CHANNEL`                                                        | use `export` / `$env:` so both commands can read it                           |
| version is `0.0.0-vsworker-…`                               | `OPENCODE_VERSION` was not set                                                                       | see §3                                                                        |
| icons or metainfo missing                                   | electron-builder was run without `bun run build` first                                               | `resources/icons` and `resources/*.metainfo.xml` are gitignored build outputs |
| rebuilt for another platform, artifact is still the old one | `out/` was not rebuilt                                                                               | always `bun run build` before switching platform                              |
| `bun run native:build` fails                                | `packages/desktop/native/` does not exist in this repo                                               | ignore it; that script has no use here                                        |
| first electron-builder run prints nothing for ages          | downloading the Electron runtime and the NSIS toolsets, ~165 MB                                      | wait; there is no progress bar. Cache locations are in §1                     |
| worried about clashing with an installed `OpenCode.app`     | it cannot                                                                                            | appId, data dirs, database and install dir are all separate — see README      |

### Windows-only

| Symptom                                                                        | Cause                                                                                                                                                       | Fix                                                                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bun install` hangs or fails on `tree-sitter-powershell`, log shows `gyp ERR!` | it ships no `prebuilds/`, so `node-gyp-build` falls back to compiling; it is in `trustedDependencies` so bun always runs it                                 | install VS 2022 Build Tools (Desktop development with C++) and Python 3, then re-run `bun install --linker hoisted` |
| `node-gyp` reports `No module named 'distutils'`                               | Python 3.12+ removed distutils                                                                                                                              | `python -m pip install setuptools`                                                                                  |
| all four `*.gen.ts` report stale on a fresh clone                              | `core.autocrlf=true` gives a CRLF working tree; `bundle.ts:497-500` compares bytes, prettier emits LF                                                       | `git config --global core.autocrlf false`, then re-clone. **Do not "fix" it with `bundle generate`**                |
| only `skills.gen.ts` is stale, right after you ran `bundle generate`           | `bundle.ts:309` forces the execute bit to `false` on win32                                                                                                  | `git checkout -- vsworker/src/skills.gen.ts`; see the boxed note at the end of §4.2                                 |
| app icons or `site.webmanifest` are one-line text paths                        | cloned with `core.symlinks=false`, so 55 `packages/*/public/*` symlinks became text files                                                                   | enable Developer Mode, `git config --global core.symlinks true`, re-clone                                           |
| path-too-long or `ENOENT` deep inside `node_modules`                           | 200 characters at the deepest under the isolated linker, plus the clone root, versus MAX_PATH 260                                                           | `core.longpaths` + the `LongPathsEnabled` registry value; clone to `C:\dev\`; use `--linker hoisted`                |
| `electron-builder` reports `spawn pwsh ENOENT` and fails                       | you set `GITHUB_ACTIONS=true`; `electron-builder.config.ts:23` lets it through and `:26` spawns `pwsh`; `winPackager.js:197` does not swallow the rejection | do not set `GITHUB_ACTIONS`. It cannot produce a signature anyway — see §4.2                                        |
| arm64 build starts and cannot find `@lydell/node-pty-win32-arm64`              | building arm64 on an x64 machine without `OPENCODE_TARGET_ARCH=arm64`                                                                                       | see the arm64 variant in §4.2; all three architecture names must agree                                              |
| built one architecture then the other, artifact is still the first             | `$env:OPENCODE_TARGET_ARCH` persists for the session, and `out/` holds only the last build                                                                  | `Remove-Item Env:\OPENCODE_TARGET_ARCH` or open a new window; `bun run build` before switching                      |
| `bun install` and the first `electron-builder` are absurdly slow               | 3.1 GB of node_modules across ~2,400 packages, scanned file by file                                                                                         | add the Defender exclusions listed in §4.2                                                                          |
| `dist\builder-effective-config.yaml` does not exist                            | `packager.js:298` writes it only when not in CI and stdout is a TTY                                                                                         | run in an interactive pwsh and do not pipe the output                                                               |
| searching `app.asar` finds nothing, but the build is fine                      | `Select-String` is unreliable on binary input and very long lines; the NSIS `.exe` is LZMA-compressed                                                       | use the byte scan in §5②, and search only `win-unpacked\resources\app.asar`                                         |

---

## 7. Quick reference

After changing bundle content:

```bash
bun run --cwd vsworker bundle generate
bun run --cwd vsworker bundle check && bun run --cwd vsworker bundle check --seams
```

macOS (Apple Silicon), end to end:

```bash
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
bun run build
npx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts
```

Windows x64, cross-built on macOS, end to end:

```bash
bun install --cwd packages/desktop --os=win32 --cpu=x64 "@lydell/node-pty-win32-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=win32 OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
cd ../.. && bun install
```

Windows x64, built natively on a Windows PC, end to end:

```powershell
bun install --linker hoisted
cd packages\desktop
$env:OPENCODE_CHANNEL = "vsworker"
$env:OPENCODE_VERSION = "1.18.30-vsworker.$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))"
bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
```

---

## Appendix A: distribution

The vsworker channel has **no publish configuration and no update feed** (the comment at
`electron-builder.config.ts:175` explains why), so releasing means handing out the `.dmg` / `.exe` yourself.

- macOS: send the `.dmg` with the Gatekeeper note from the end of §3.
- Windows: send the `.exe` with the SmartScreen note from §4.2's "Unsigned".
- Keep the `<upstream version>-vsworker.<UTC timestamp>` convention so every package can be identified uniquely.
- Users will not be upgraded automatically — the updater is off, so a new version means shipping a new package.

The config also declares Linux targets (`AppImage` / `deb` / `rpm`, with `rpm.packageName` set to `vsworker`),
but none of them has been tried on this machine and they are out of scope here.

## Appendix B: the CLI binary (not the desktop client)

The desktop client does not depend on it, but the same bundle is also compiled into the CLI binary. The command
comes from `.github/workflows/vsworker.yml:43`:

```bash
cd packages/opencode
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

The output is `packages/opencode/dist/opencode-<platform>/bin/opencode` — `opencode-darwin-arm64` on this
machine, and **`dist\opencode-windows-x64\bin\opencode.exe` on Windows**: `script/build.ts:149` deliberately
renames `win32` to `windows` (the comment says `win32` confuses npm), and `windowsify()` appends `.exe`.

> **Mind the order**: `script/build.ts` starts with `rm -rf dist`, which also deletes
> `packages/opencode/dist/node/` — exactly the server bundle the desktop prebuild produces. So building the CLI
> and then the desktop client is fine, because `bun run build` regenerates it; but the **reverse** (desktop,
> then CLI, then electron-builder directly) fails. Re-run `bun run build` whenever you need to repackage the
> desktop artifact.

Smoke test:

```bash
BIN=./dist/opencode-darwin-arm64/bin/opencode
"$BIN" vsworker plugins list
"$BIN" vsworker mcp list
"$BIN" vsworker skills list
```

```powershell
$BIN = ".\dist\opencode-windows-x64\bin\opencode.exe"
& $BIN vsworker plugins list
& $BIN vsworker mcp list
& $BIN vsworker skills list
```
