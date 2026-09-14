# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

`AGENTS.md` at the repo root is the authoritative style guide (branch names, conventional commits, TypeScript/Effect style, Drizzle schema naming, V2 session-core invariants). Follow it. Several packages carry their own `AGENTS.md` that applies inside that subtree; read the relevant one before editing there:

- `packages/opencode/AGENTS.md` — module shape (flat exports + `export * as Foo from "./foo"`, no `export namespace`, no barrels in multi-sibling dirs), Effect rules (`makeRuntime`, `InstanceState`, Effect v4 beta API), running the TUI in tmux.
- `packages/opencode/test/AGENTS.md` and `test/server/AGENTS.md` — `tmpdir`/`testEffect` fixtures, `it.effect` vs `it.live` vs `it.instance`, no `Effect.sleep` for synchronization.
- `packages/core/src/tool/AGENTS.md` — canonical `Tool.make` representation, registration precedence, output bounding.
- `packages/schema/AGENTS.md` — contract naming (current is unversioned, legacy is `V1`), `optional(...)` helper, no `Schema.Any`.
- `packages/llm/AGENTS.md` — Route = Protocol + Endpoint + Auth + Framing, protocol file section order, cassette recording.
- `packages/opencode/src/session/llm/AGENTS.md` — AI SDK vs native runtime seam.
- `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` — HttpApi handler patterns.
- `packages/app`, `packages/ui`, `packages/session-ui`, `packages/desktop` — i18n is mandatory: never hardcode user-visible English, never change existing English keys/text to ease translation. `packages/app/AGENTS.md` also says never restart the app or server process while debugging.
- `packages/app/e2e/AGENTS.md` — Playwright rules (no `waitForTimeout`, no `.first()` to silence strictness).
- `packages/codemode`, `packages/effect-drizzle-sqlite`, `packages/stats` — package-local boundaries.

`packages/opencode/AGENTS.md` references `specs/effect/migration.md`; that file does not exist in the tree. `CONTEXT.md` is the session-runtime glossary (System Context, Context Epoch, Safe Provider-Turn Boundary, Session Drain, prompt admission vs promotion) and the client-contract architecture; use its vocabulary when touching session or SDK code. `specs/` holds design docs (`specs/v2/*`, `specs/storage/*`, `specs/tui-package.md`).

## Commands

Bun is pinned by `packageManager` (1.3.14); the husky pre-push hook rejects mismatched Bun versions and runs `bun typecheck`. `bunfig.toml` installs exact versions and refuses packages published less than 3 days ago.

```bash
bun install
bun dev                      # legacy TUI, runs packages/opencode against packages/opencode
bun dev .                    # TUI against the repo root
bun dev <dir>                # TUI against another directory
bun dev serve --port 4096    # headless API server
bun dev web                  # server + web UI (proxies app.opencode.ai, not local UI changes)
bun dev spawn                # server in a child process instead of a worker thread (debugger-friendly)
bun dev:web                  # packages/app Vite dev server (needs a running server on :4096)
bun dev:desktop              # Electron app (packages/desktop)
bun dev:console | bun dev:stats | bun dev:storybook
```

`bun dev` launches an interactive TUI. Never run it as a blocking foreground command, and on this machine never run it with default paths: launch it through the isolated launcher in tmux as described under "Local environment (this fork)" below, then inspect with `tmux capture-pane -pt opencode-dev` and stop with `tmux kill-session -t opencode-dev`.

Typecheck, lint, format:

```bash
bun typecheck                # root: turbo across all packages
bun typecheck                # inside a package dir: tsgo --noEmit (never run tsc directly)
bun lint                     # oxlint, type-aware
./script/format.ts           # prettier (semi: false, printWidth: 120)
```

Tests never run from the repo root (`bun test` there fails by design). Run from a package directory:

```bash
cd packages/opencode && bun test                          # whole package
cd packages/opencode && bun test test/session/foo.test.ts # one file
cd packages/opencode && bun test -t "name pattern"        # filter by test name
cd packages/opencode && bun run test:httpapi              # HttpApi coverage/auth/effect gates (CI, Linux)
cd packages/app && bun run test:unit                      # happy-dom unit tests
cd packages/app && bun run test:e2e                       # Playwright
```

`packages/opencode/test/preload.ts` isolates every run: temp XDG dirs, in-memory SQLite (`OPENCODE_DB=:memory:`), a fixture models list, and all provider API keys cleared. `packages/llm` provider tests replay cassettes; `RECORD=true` plus the provider key records fresh ones (refresh one cassette, not the whole file).

Code generation (never edit generated output by hand):

```bash
./script/generate.ts                                   # after changing the server API: legacy JS SDK + packages/sdk/openapi.json + format
cd packages/client && bun run generate                 # after changing Protocol or Server HttpApi: src/generated + src/generated-effect
cd packages/client && bun run check:generated          # CI fails if this diff is non-empty
cd packages/core && bun run migration --name <name>    # new Drizzle migration from packages/core/src/**/*.sql.ts
cd packages/core && bun run migration --check
./packages/opencode/script/build.ts --single           # standalone binary in packages/opencode/dist/opencode-<platform>/
```

`nix/hashes.json` is regenerated by the `nix-hashes` workflow whenever the lockfile or patches change; do not hand-edit it.

## Local environment (this fork)

This checkout is for secondary development on top of upstream `anomalyco/opencode`. A daily-use release build (npm `opencode-ai`, installed under nvm at `~/.nvm/versions/node/v24.13.0/bin/opencode`) and the upstream `OpenCode.app` coexist on this machine and must never be affected by work here.

**The two products no longer share a directory (2026-09-13).** `app` in `packages/core/src/global.ts` is `vsworker`, so every build of this fork resolves `~/.config/vsworker/`, `~/.local/share/vsworker/` (`auth.json`, `storage/`, `snapshot/`, `repos/`, `log/`, `tool-output/`), `~/.local/state/vsworker/` and `~/.cache/vsworker/`, while the daily install keeps the `opencode` ones. Authentication is therefore per product: the fork has its own `auth.json` and providers are logged in again inside it. The SQLite file is separated on top of that by channel: source runs have no `OPENCODE_CHANNEL` define, so `InstallationChannel` is `local` and `bun dev` opens `opencode-local.db`; a build made with `OPENCODE_CHANNEL=vsworker` opens `opencode-vsworker.db` (`packages/core/src/database/database.ts`). Migrations run automatically whenever a database opens, so never set `OPENCODE_DISABLE_CHANNEL_DB` or point `OPENCODE_DB` at the daily database. Project-level `.opencode/` directories and the `opencode.json` filename stay shared on purpose: those belong to a repository, not to an install.

Run every dev command (TUI, `serve`, `web`, desktop, built binaries; tests already isolate themselves through the preload) through the launcher `~/.opencode-dev/bin/opencode-dev`. It points the four XDG variables under `~/.opencode-dev/`, sets `OPENCODE_DISABLE_AUTOUPDATE=1`, adds `~/.bun/bin` to `PATH`, and dispatches on its first argument: no argument is the TUI in the caller's directory, `<dir>` is the TUI there, `app` is the `packages/app` Vite dev server, `desktop` is the Electron app in dev mode, and anything else (`serve`, `web`, `auth login`, ...) passes through to the repo's `bun dev`.

Equivalent environment when the launcher cannot be used (scope it to the command, not the shell, because git also honors `XDG_CONFIG_HOME`): `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` under `~/.opencode-dev/{config,data,state,cache}` plus `OPENCODE_DISABLE_AUTOUPDATE=1`. Dev-build files then live at `~/.opencode-dev/config/vsworker/opencode.json` (providers, `mcp`, agents), `~/.opencode-dev/config/vsworker/tui.json`, `~/.opencode-dev/data/vsworker/auth.json` (written by `/connect` or `opencode-dev auth login`), and the databases under `~/.opencode-dev/data/vsworker/`. The `…/opencode/` subdirectories inside the sandbox were renamed to `vsworker/` on 2026-09-13 to follow `app`; nothing else about the launcher changed.

### Runbook (every surface verified on this machine on 2026-09-04)

Start each surface in its own tmux session so it can be inspected with `tmux capture-pane -pt <session>`, attached with `tmux attach -t <session>` (detach with `ctrl+b d`), and stopped with `tmux kill-session -t <session>`.

**TUI** (database `opencode-local.db`):

```bash
tmux new-session -d -s opencode-dev "$HOME/.opencode-dev/bin/opencode-dev /Users/lou/Projects/vs/opencode-vs"
```

**Headless server + hosted web UI** (same database as the TUI; the UI is proxied from `https://app.opencode.ai`, so it needs network and does not reflect local UI code; the backend binds to 127.0.0.1 and is unsecured unless `OPENCODE_SERVER_PASSWORD` is set):

```bash
tmux new-session -d -s opencode-dev-server "$HOME/.opencode-dev/bin/opencode-dev serve --port 4096"
open http://localhost:4096
```

`opencode-dev web --port 4096` does the same and opens the browser itself. Readiness: `curl -s http://127.0.0.1:4096/global/health` returns 200.

**Local web UI development** (Vite serves `packages/app` on `http://localhost:3000` and talks to the backend above on 4096; override with `VITE_OPENCODE_SERVER_HOST` / `VITE_OPENCODE_SERVER_PORT`):

```bash
tmux new-session -d -s opencode-dev-app "$HOME/.opencode-dev/bin/opencode-dev app"
open http://localhost:3000
```

**Desktop (Electron dev mode)**:

```bash
tmux new-session -d -s opencode-dev-desktop "$HOME/.opencode-dev/bin/opencode-dev desktop"
```

- `predev` runs first: it builds the server bundle from source, downloads the Electron runtime into `packages/desktop/node_modules/electron/dist` when missing (about 110 MB zip, 292 MB extracted, no progress output), and installs `@opencode-ai/cli-darwin-arm64` into `packages/desktop/resources/opencode-cli` (144 MB). The first launch took about 16 minutes on this network; later launches skip the downloads.
- The app is named "OpenCode Dev". Its Electron data lives in `~/Library/Application Support/ai.opencode.desktop.dev`; the installed `OpenCode.app` uses `ai.opencode.desktop`.
- The sidecar backend is forked with the launcher's environment, listens on a random `127.0.0.1` port, and, because the bundle is built for the `dev` channel, opens `~/.opencode-dev/data/opencode/opencode-dev.db`, a different file from the TUI's `opencode-local.db`.
- First-launch onboarding creates an empty `~/Documents/Default Project` folder.
- Do not set `OPENCODE_SIDECAR_V2=1`. That path probes every known state home, including the installed desktop app's, and would reuse a daily background daemon if one were running.
- Killing the tmux session ends electron-vite but **not** the Electron app: it is reparented to launchd and keeps running against a dead Vite server and dead stdio. Always quit it from the Dock, or run `pkill -f "node_modules/electron/dist/Electron"`. Do not match on `packages/desktop/node_modules/electron` — that path is a symlink into the bun store, so the running process's command line is `node_modules/.bun/electron@<version>/node_modules/electron/dist/Electron` and the pattern silently matches nothing. Verify with `pgrep -fl "node_modules/electron/dist/Electron"` before assuming the app is gone.

**Rules that apply to every surface**:

- `OPENCODE_DISABLE_AUTOUPDATE=1` is required for source runs (the launcher sets it). The TUI worker calls `upgrade()` on start (`packages/opencode/src/cli/tui/worker.ts`), which detects the install method with `npm list -g` and would find the daily package; a `local` build currently aborts only because `semver.major("local")` throws. Do not rely on that. A **built** VsWorker release needs no flag: `Installation.method()` returns `unknown`, `latest()` returns the running version and `upgrade()` refuses, because upstream's feeds all serve opencode (`vsworker/src/release.ts`, seam in `packages/opencode/src/installation/index.ts`).
- `bun dev serve` defaults to a random port; pass `--port` only when a fixed one is needed and avoid one the daily install may be serving on.
- The dev data dir starts with no `auth.json`. Authenticate providers again inside the dev build. Never read, copy, or reuse the daily `auth.json` or `opencode.json` on the user's behalf.
- Narrower overrides exist when full isolation is not wanted: `OPENCODE_CONFIG_DIR` replaces only the config dir, `OPENCODE_DB` (absolute path or `:memory:`) replaces only the database. Neither isolates `auth.json`, state locks, logs, or cache.
- Never run `npm install -g opencode-ai`, `brew`, or any upgrade path from this checkout.

## Architecture

Bun workspaces + turbo monorepo. Backend code is Effect v4 beta (`effect-smol`, pinned in the catalog and patched under `patches/`), UIs are SolidJS, storage is Drizzle + SQLite, model calls go through the Vercel AI SDK by default with an opt-in native runtime.

### Two generations coexist

**Legacy host, `packages/opencode`** (`opencode` binary, yargs CLI in `src/index.ts`). It owns command parsing, config discovery, the embedded server (`src/server`, Effect HttpApi mounted with a raw fallback), the V1 session runtime (`src/session`), plugins, LSP, MCP, and the TUI worker. It imports heavily from `@opencode-ai/core`. Path aliases: `@/*` → `packages/opencode/src/*`, `@test/*` → `packages/opencode/test/*`.

**Current (V2) stack**, split into packages with an enforced dependency direction:

```
schema  →  protocol  →  server
schema  →  core      →  server
client  →  {schema, protocol} only (never core/server); root export is zero-Effect, /effect adds Effect
sdk-next composes client + core + server (in-process host, no listener)
cli     →  core, server, sdk, tui   (new Effect-based CLI, bin `lildax`, daemon-backed)
```

- `packages/schema` — browser-safe wire/storage contracts shared by everything. Current contracts are unversioned (`Session`, `Permission`); retained legacy ones are explicitly `V1`. `V2` in a name is transitional and should be removed as contracts normalize.
- `packages/protocol` — HttpApi groups, errors, middleware placement built from Schema.
- `packages/core` — domain services: Location-scoped services, session store/runner/execution (`src/session`), tool registry (`src/tool`), system-context algebra (`src/system-context`), database + migrations (`src/database`), providers, permissions, plugins. Bun/Node variants are selected through `#sqlite`, `#pty`, `#fff` import conditions.
- `packages/server` — hosts Protocol's groups with concrete middleware; authoritative `HttpApi`.
- `packages/client` — Promise and Effect clients emitted by `packages/httpapi-codegen` from a Protocol-only projection of the API (`src/contract.ts`, built with `makeDefaultApi` plus transport-only middleware keys); generated output is tested for equivalence with Server's concrete HttpApi.
- `packages/sdk-next` — scoped embedded OpenCode that runs Server's router in memory.
- `packages/sdk/js` (`@opencode-ai/sdk`) — the legacy published SDK, generated from OpenAPI with hey-api; still the boundary the TUI, app, and plugin packages consume.

### UI surfaces

- `packages/tui` (`@opencode-ai/tui`) — OpenTUI + Solid terminal app. Per `specs/tui-package.md`, the SDK is its only OpenCode boundary: missing data goes into the server API and regenerated SDK, never imported from backend modules. Both CLIs are thin adapters that call its public `run(...)`. Tool renderers key on SDK tool-name strings and treat input/metadata as `unknown`.
- `packages/ui` (published `@opencode-ai/ui`) — shared Solid components, theme, icons. `packages/session-ui` — session/message/diff rendering. `packages/app` — the web app (Vite). `packages/desktop` — Electron wrapper around `app`; renderer talks only through `window.api` from `src/preload`, main registers IPC in `src/main/ipc.ts`.
- `packages/storybook` renders `ui`/`session-ui` stories.

### LLM path

`packages/opencode/src/session/llm.ts` is the session-owned orchestration layer (auth, config, model resolution, plugins, permissions, telemetry). It picks per request between the default AI SDK path (`session/llm/ai-sdk.ts` adapts `fullStream` into shared `LLMEvent`s) and the native `packages/llm` runtime (`native-request.ts` lowers input to `LLMRequest`, `native-runtime.ts` calls `LLMClient`). Native is opt-in via `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` or `OPENCODE_EXPERIMENTAL=true` and falls back to AI SDK for unsupported providers. `packages/llm` itself is Schema-first and session-agnostic; providers are configured facades over `Route.make({ protocol, endpoint, auth, framing })`.

### Session runtime invariants (see AGENTS.md "V2 Session Core" and CONTEXT.md)

Prompt admission is durable and separate from execution: `SessionV2.prompt(...)` writes one `session_input` row, then an advisory `SessionExecution.wake(sessionID)` drains it. Steer prompts promote at the next safe provider-turn boundary; queued prompts promote only when the session would otherwise go idle. One explicit `llm.stream(request)` per provider turn; reload projected history before continuing. System context is composed from stable-keyed Context Sources, rendered once per Context Epoch as an immutable baseline (provider-cache prefix), with changes admitted lazily as Mid-Conversation System Messages at safe boundaries. Session drains are process-local with no durable identity.

### Everything else

- `packages/plugin` — public `@opencode-ai/plugin` API (v1 promise + v2 effect/promise surfaces).
- `packages/web` — Astro docs/marketing site (opencode.ai); commits there use the `docs:` scope. `packages/docs` is Mintlify-style doc content.
- `packages/console/*`, `packages/stats/*`, `packages/enterprise`, `packages/slack`, `packages/function`, `infra/` — hosted services deployed with SST (`sst.config.ts`).
- `packages/codemode` — confined code execution over schema-described tools. `packages/http-recorder` — Effect HTTP cassette record/replay. `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node` — vendored Effect/Drizzle SQLite adapters, kept generic.
- `.opencode/` — this repo's own OpenCode config, agents, commands, and skills (`.opencode/skills/effect` says to consult effect-smol source rather than memory for Effect v4 APIs).

## Contribution rules that affect how you work

- Default branch is `dev`; `main` may not exist locally. Diff against `dev` or `origin/dev`.
- Branch names: at most three hyphenated words, no slashes or type prefixes. Commits and PR titles: `type(scope): summary` with types `feat|fix|docs|chore|refactor|test`.
- Every PR must reference an issue (`Fixes #123`), stay small, explain how it was verified, and include screenshots for UI changes. Long AI-generated descriptions get PRs closed.
- UI and core product features require design review with the core team before implementation; bug fixes, providers, LSP/formatter additions, and docs are the expected contribution types.
- New providers go to `github.com/anomalyco/models.dev`, not here.

## Bundled plugins, MCP servers, and skills (`vsworker/`)

This fork ships a curated set of plugins, MCP server definitions, and skills compiled into the product. The
manifest is `vsworker/bundle.jsonc`; `bun run --cwd vsworker bundle generate` regenerates `vsworker/src/*.gen.ts`,
`vsworker/bundle.schema.json`, and the `dependencies` block of `vsworker/package.json`, then runs `bun install`.
Commit all of those, plus anything under `vsworker/skills/`, with `bun.lock`. `bundle check` is the CI drift gate
and `bundle check --seams` verifies the thirteen marked edits in upstream files survived the last merge (fifteen
files are touched; the two `package.json` ones cannot carry a comment).

Skills are vendored under `vsworker/skills/<id>/` and written to `~/.cache/vsworker/vsworker/skills/` at runtime,
because the skill tool needs a real directory. A skill directory may carry a flat `env.json`; its pairs are
exported to bash commands that run inside that directory or name a path inside it, for bundled skills and for any
skill a user drops on disk alike (`vsworker/src/env.ts`, seam in `packages/opencode/src/tool/shell.ts`). MCP
entries carry a definition, not a server: keep credentials out of them and use `{env:VAR}` / `{file:path}`, which
are substituted at config load.

Read `vsworker/README.md` before adding anything (the manifest reference, the `bundle import` helpers, and the
constraints compiled-in content has to satisfy) and `vsworker/UPSTREAM.md` before merging upstream (the seam
inventory and the merge runbook). Upstream suites keep the stock sets because `packages/opencode/test/preload.ts`
sets `VSWORKER_DISABLE_BUNDLED_PLUGINS`, `_MCP`, and `_SKILLS`; tests under `packages/opencode/test/vsworker/`
clear them themselves.
