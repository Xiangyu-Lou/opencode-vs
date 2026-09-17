# Staying mergeable with upstream OpenCode

VsWorker is a fork of `anomalyco/opencode`. Everything the fork adds for bundling plugins, MCP servers, and
skills lives in `vsworker/`, and everything it adds for managing them from the desktop client lives in
`packages/opencode/src/vsworker/` and `packages/app/src/vsworker/`. Outside those directories the fork makes
twenty-two small edits inside upstream files. Twenty of them carry a `// vsworker-seam` comment so a merge that
drops one can be detected mechanically.

## Seam inventory

| File                                          | What the fork adds                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                | `"vsworker"` in `workspaces.packages`                                                                                                                                                                   |
| `packages/opencode/package.json`              | `"@vsworker/bundle": "workspace:*"`                                                                                                                                                                     |
| `packages/core/src/v1/config/config.ts`       | imports `ConfigVsWorkerV1` and adds the optional `vsworker` field. The schema itself is the fork-owned `packages/core/src/v1/config/vsworker.ts`                                                        |
| `packages/opencode/src/plugin/index.ts`       | yields `VsWorkerPlugins.Service`, runs the bundled plugins between the built-in and external loops, adds `VsWorkerPlugins.node` to `deps`                                                               |
| `packages/opencode/src/plugin/tui/runtime.ts` | registers bundled TUI plugins after the built-ins                                                                                                                                                       |
| `packages/opencode/src/config/config.ts`      | yields `VsWorkerMcp.Service`, injects the bundled MCP definitions after the last config source, adds `VsWorkerMcp.node` to `deps`                                                                       |
| `packages/opencode/src/skill/index.ts`        | yields `VsWorkerSkills.Service`, materializes the bundled skills and seeds them before disk discovery, adds `VsWorkerSkills.node` to `deps`                                                             |
| `packages/opencode/src/index.ts`              | registers the `vsworker` CLI command                                                                                                                                                                    |
| `packages/opencode/test/preload.ts`           | sets the three `VSWORKER_DISABLE_BUNDLED_*` variables so upstream suites see the stock sets; writes the cache marker under the renamed app dir                                                          |
| `packages/opencode/src/tool/shell.ts`         | yields `Skill.Service`, and `shellEnv` takes the command so `VsWorkerEnv.resolve` can add each matching skill's `env.json`, plus the config's `vsworker.skill_env` overrides, on top of the environment |
| `packages/opencode/src/tool/skill.ts`         | appends one line naming the variables the skill's `env.json` provides                                                                                                                                   |
| `packages/opencode/test/tool/shell.test.ts`   | adds `Skill.node` to the tool's layer group, because `ShellTool` now yields it                                                                                                                          |
| `packages/opencode/src/installation/index.ts` | yields `VsWorkerRelease.Service` and freezes `method`/`latest`/`upgrade` for a built release, adds `VsWorkerRelease.node` to `deps`                                                                     |
| `packages/core/src/global.ts`                 | `app` is `vsworker`, so the fork owns its XDG directories instead of sharing opencode's                                                                                                                 |
| `packages/opencode/test/cli/mcp-add.test.ts`  | asserts the global config path under the renamed app dir                                                                                                                                                |

## Seam inventory: the management UI

| File                                                             | What the fork adds                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts`    | `.addHttpApi(VsWorkerApi)` on `InstanceHttpApi`                                                                                              |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | `vsworkerHandlers` in the `instanceApiRoutes` handler list                                                                                   |
| `packages/opencode/test/server/httpapi-exercise/index.ts`        | spreads `vsworkerScenarios` into the route-coverage list                                                                                     |
| `packages/app/src/components/settings-v2/dialog-settings-v2.tsx` | one `<VsWorkerSettingsNav />` and one `<VsWorkerSettingsPanels />`                                                                           |
| `packages/app/src/context/language.tsx`                          | merges the fork's i18n domain into the base dictionary and into each locale loader                                                           |
| `packages/app/src/components/dialog-connect-provider.tsx`        | the custom provider leads both provider pickers                                                                                              |
| `packages/app/src/context/settings.tsx`                          | `defaultSettings.general` spreads `agentVisibilityDefaults()`, so the agent picker ships visible and upstream's one-time latch is pre-seeded |

Fork-owned files behind those seams:

- `packages/opencode/src/vsworker/*` — config writes, entry description, skill files, plugin specs
- `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/vsworker.ts`
- `packages/opencode/test/{vsworker/*,server/httpapi-vsworker.test.ts,server/httpapi-exercise/vsworker.ts}`
- `packages/app/src/vsworker/*` and `packages/app/e2e/regression/vsworker-{settings,agent-picker}.spec.ts`

The generated SDK (`packages/sdk/openapi.json`, `packages/sdk/js/src/**/gen/*`) contains the VsWorker routes.
It is regenerated, never hand-edited: on a conflict take upstream's copy and rerun `./script/generate.ts`.

Fork-owned files that live inside the upstream tree because they need its path aliases and fixtures, but which
upstream will never touch:

- `packages/core/src/v1/config/vsworker.ts`
- `packages/opencode/src/cli/cmd/vsworker.ts`
- `packages/opencode/test/vsworker/*`

Rebrand edits are a separate, unmarked category: strings and identifiers that name the product or its directories
(`packages/core/src/plugin/skill.ts`, `packages/core/src/plugin/skill/customize-opencode.md`,
`packages/opencode/src/skill/index.ts`, `packages/tui/src/feature-plugins/home/tips-view.tsx`,
`packages/opencode/test/server/httpapi-exercise/environment.ts`, and the desktop
channel files under `packages/desktop/`). They are not seams because losing one in a merge is visible in the
product rather than silent. The desktop `vsworker` channel is the largest of them:
`scripts/utils.ts`, `scripts/copy-icons.ts`, `scripts/copy-metainfo.ts`, `electron-builder.config.ts`,
`electron.vite.config.ts`, `src/main/{constants,index,migrate,logging}.ts`, plus `packages/app/vite.js`, whose
own channel resolver decides the renderer's release-versus-development affordances. `electron.vite.config.ts`
also gained `OPENCODE_TARGET_PLATFORM` / `OPENCODE_TARGET_ARCH`, so a cross build picks the right prebuilt
`node-pty` package instead of the build machine's.

The two `package.json` seams are the only ones that are not marked, because JSON has no comments.
`bundle check --seams` covers the twenty that are. `.prettierignore` also gains a `vsworker/skills/` line, which is
not a seam: losing it only means the formatter rewrites vendored skill files, which `bundle check` then reports as
drift.

## Merging upstream

There is no `upstream` remote configured by default. Add one:

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
```

Then:

```bash
git fetch upstream
git checkout dev && git merge --ff-only upstream/dev
git checkout vsworker && git merge dev
bun install
bun run --cwd vsworker bundle check --seams
bun run --cwd vsworker bundle check
./script/generate.ts                      # the SDK carries the fork's routes; regenerate after every merge
bun typecheck
cd packages/opencode && bun test test/vsworker test/server/httpapi-vsworker.test.ts test/plugin test/config test/skill test/mcp
cd packages/opencode && bun run test:httpapi
cd packages/app && bun run test:unit
```

Expected conflict hotspots, in rough order of likelihood:

1. `bun.lock` — resolve by taking upstream's file and rerunning `bun install`.
2. `packages/opencode/src/plugin/index.ts` — upstream changes the plugin host often. The seam only needs to stay
   between the built-in loop and the external loop.
3. `packages/opencode/src/config/config.ts` — the seam has to stay after every merge step, including the managed
   preferences block, and before `result` is returned. Anything merged in after it would be invisible to the
   bundled-MCP precedence rules.
4. `packages/opencode/src/skill/index.ts` — the seeding loop has to stay before `loadSkills`, which is what makes
   a disk skill of the same name win.
5. `packages/opencode/src/tool/shell.ts` — `shellEnv` has to keep receiving the command. Upstream changes this
   function's signature rarely, but a merge that reverts it to `(ctx, cwd)` compiles only after the call site is
   reverted too, which is the shape to watch for.
6. The two `package.json` dependency lines.
7. `packages/app/src/context/language.tsx` — upstream adds locales to the `loaders` map often. Every entry has
   to keep passing its own locale as `merge`'s third argument; a new entry that forgets it will not typecheck.
8. `packages/app/src/context/settings.tsx` — upstream iterates on the layout-sunset machinery in this file.
   `...agentVisibilityDefaults()` has to stay inside `defaultSettings.general`: a merge that drops the spread
   fails typecheck, but one that resolves the hunk in upstream's favour restores `showCustomAgents: false`
   and still compiles. `packages/app/src/vsworker/agent-visibility.test.ts` asserts the spread is present.
9. `packages/sdk/**` generated output — never merge it by hand, rerun `./script/generate.ts`.

If `bundle check --seams` reports a missing seam, reapply it from the table above before shipping. A dropped seam
does not fail typecheck or tests; it silently ships a build with part of the bundle missing.

## Updating bundled content

```bash
bun run --cwd vsworker bundle outdated
bun run --cwd vsworker bundle bump <id>          # or: bump <id> <version|sha>
```

`bump` repins a plugin in the manifest and regenerates. MCP definitions and skills are edited in place: change
`bundle.jsonc` or the files under `vsworker/skills/`, then run `bundle generate`. A skill vendored as a
`<id>.zip` there is a source file like any other — re-read on every `generate` and `check`, never shipped as an
archive.

Commit `vsworker/bundle.jsonc`, `vsworker/package.json`, `vsworker/src/*.gen.ts`, `vsworker/bundle.schema.json`,
`vsworker/skills/**`, and `bun.lock` together. A plugin version published less than three days ago cannot be
installed, because the root `bunfig.toml` sets `minimumReleaseAge` to 259200 seconds. Wait it out rather than
editing `minimumReleaseAgeExcludes`, which is an upstream file.

## Why bundling rather than runtime install

OpenCode installs plugins from npm at runtime into `~/.cache/vsworker/packages/<spec>` and never re-resolves them.
MCP servers and skills are not installed at all: each user configures them by hand. All three need either network
access or per-machine setup, give no way to ship a fix, and cannot work on an intranet. Compiling them into the
build makes a VsWorker release the single unit of delivery: what a build contains is exactly what the manifest
pinned when that build was made.
