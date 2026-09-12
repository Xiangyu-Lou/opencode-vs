# Staying mergeable with upstream OpenCode

VsWorker is a fork of `anomalyco/opencode`. Everything the fork adds for plugin bundling lives in
`vsworker/`, except for seven small edits inside upstream files. Each of those carries a `// vsworker-seam`
comment so a merge that drops one can be detected mechanically.

## Seam inventory

| File                                          | What the fork adds                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                | `"vsworker"` in `workspaces.packages`                                                                                                            |
| `packages/opencode/package.json`              | `"@vsworker/plugins": "workspace:*"`                                                                                                             |
| `packages/core/src/v1/config/config.ts`       | imports `ConfigVsWorkerV1` and adds the optional `vsworker` field. The schema itself is the fork-owned `packages/core/src/v1/config/vsworker.ts` |
| `packages/opencode/src/plugin/index.ts`       | yields `VsWorkerPlugins.Service`, runs the bundled plugins between the built-in and external loops, adds `VsWorkerPlugins.node` to `deps`        |
| `packages/opencode/src/plugin/tui/runtime.ts` | registers bundled TUI plugins after the built-ins                                                                                                |
| `packages/opencode/src/index.ts`              | registers the `vsworker` CLI command                                                                                                             |
| `packages/opencode/test/preload.ts`           | sets `VSWORKER_DISABLE_BUNDLED_PLUGINS=1` so upstream suites see the stock plugin set                                                            |

Fork-owned files that live inside the upstream tree because they need its path aliases and fixtures, but
which upstream will never touch:

- `packages/core/src/v1/config/vsworker.ts`
- `packages/opencode/src/cli/cmd/vsworker.ts`
- `packages/opencode/test/vsworker/*.test.ts`

The two `package.json` seams are the only ones that are not marked, because JSON has no comments.
`plugins check --seams` covers the five that are.

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
bun run --cwd vsworker plugins check --seams
bun run --cwd vsworker plugins check
bun typecheck
cd packages/opencode && bun test test/vsworker test/plugin test/config
```

Expected conflict hotspots, in rough order of likelihood:

1. `bun.lock` — resolve by taking upstream's file and rerunning `bun install`.
2. `packages/opencode/src/plugin/index.ts` — upstream changes the plugin host often. The seam only needs to
   stay between the built-in loop and the external loop.
3. The two `package.json` dependency lines.

If `plugins check --seams` reports a missing seam, reapply it from the table above before shipping. A
dropped seam does not fail typecheck or tests; it silently ships a build with no bundled plugins.

## Updating a bundled plugin

```bash
bun run --cwd vsworker plugins outdated
bun run --cwd vsworker plugins bump <id>          # or: bump <id> <version|sha>
```

`bump` repins the manifest and regenerates. Commit `vsworker/plugins.jsonc`, `vsworker/package.json`,
`vsworker/src/*.gen.ts`, `vsworker/plugins.schema.json`, and `bun.lock` together. A plugin version published
less than three days ago cannot be installed, because the root `bunfig.toml` sets `minimumReleaseAge` to
259200 seconds. Wait it out rather than editing `minimumReleaseAgeExcludes`, which is an upstream file.

## Why bundling rather than runtime install

OpenCode installs plugins from npm at runtime into `~/.cache/opencode/packages/<spec>` and never
re-resolves them. That needs network access on the end user's machine, gives no way to ship a fix, and
cannot work on an intranet. Compiling plugins into the build makes a VsWorker release the single unit of
delivery: the plugins a build contains are exactly the plugins the manifest pinned when that build was made.
