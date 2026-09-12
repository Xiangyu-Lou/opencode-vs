import * as prompts from "@clack/prompts"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { VsWorkerPlugins } from "@vsworker/plugins"
import { Effect } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import path from "path"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigParse } from "@/config/parse"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { parsePluginSpecifier } from "@/plugin/shared"
import { Filesystem } from "@/util/filesystem"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// Same resolution as `opencode mcp add`: prefer a config file that already exists, in the project directory
// first and then under .opencode/, and fall back to opencode.json.
async function resolveConfigPath(baseDir: string, global: boolean) {
  const fallback = path.join(baseDir, "opencode.json")
  const candidates = [fallback, path.join(baseDir, "opencode.jsonc")]
  if (!global) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function patchBundledPlugin(input: { id: string; enabled: boolean; file: string }) {
  return Flock.withLock(`vsworker-plugin-config:${input.file}`, async () => {
    const text = (await Filesystem.exists(input.file)) ? await Filesystem.readText(input.file) : "{}"
    const parsed = ConfigParse.jsonc(text, input.file)
    const current = isRecord(parsed) && isRecord(parsed.vsworker) ? parsed.vsworker : {}
    const plugins = isRecord(current.plugins) ? current.plugins : {}
    // Preserve an existing options object by writing to vsworker.plugins.<id>.enabled instead of replacing it.
    const target = isRecord(plugins[input.id])
      ? ["vsworker", "plugins", input.id, "enabled"]
      : ["vsworker", "plugins", input.id]
    const edits = modify(text, target, input.enabled, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
    await Filesystem.write(input.file, applyEdits(text, edits))
    return input.file
  })
}

const state = Effect.fn("Cli.vsworker.state")(function* () {
  const config = yield* Config.use.get()
  const flags = yield* RuntimeFlags.Service
  return VsWorkerPlugins.describe({
    bundle: VsWorkerPlugins.bundle.server,
    user: config.vsworker?.plugins,
    external: new Set(
      (config.plugin ?? []).map((item) => parsePluginSpecifier(ConfigPlugin.pluginSpecifier(item)).pkg),
    ),
    disabled: flags.pure || flags.disableDefaultPlugins,
  })
})

const STATE_LABELS: Record<VsWorkerPlugins.State, { icon: string; text: string }> = {
  enabled: { icon: "✓", text: "enabled" },
  "disabled-by-config": { icon: "○", text: "disabled in config" },
  "disabled-by-default": { icon: "○", text: "off by default, enable it in config" },
  shadowed: { icon: "⚠", text: "overridden by a plugin you declared yourself" },
  killed: { icon: "○", text: "bundled plugins are disabled for this run" },
}

function explain(row: VsWorkerPlugins.Described) {
  const label = STATE_LABELS[row.state]
  if (row.state === "shadowed" && row.shadowedBy) {
    return { icon: label.icon, text: `overridden by your own ${row.shadowedBy} plugin` }
  }
  return label
}

export const VsWorkerPluginsListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list the plugins bundled into this build",
  handler: Effect.fn("Cli.vsworker.plugins.list")(function* () {
    UI.empty()
    prompts.intro("Bundled plugins")

    const rows = yield* state()
    if (!rows.length) {
      prompts.log.warn("This build bundles no plugins")
      prompts.outro("Add them to vsworker/plugins.jsonc and rebuild")
      return
    }

    for (const row of rows) {
      const hit = explain(row)
      prompts.log.info(
        `${hit.icon} ${row.id} ${UI.Style.TEXT_DIM}${hit.text}\n    ${UI.Style.TEXT_DIM}${row.source} ${row.spec}`,
      )
    }

    const on = rows.filter((row) => row.state === "enabled").length
    prompts.outro(`${on} of ${rows.length} plugin(s) enabled`)
  }),
})

function toggle(enabled: boolean) {
  return Effect.fn("Cli.vsworker.plugins.toggle")(function* (args: { id?: string; global?: boolean }) {
    const id = (args.id ?? "").trim()
    if (!id) {
      yield* fail("plugin id is required")
      return
    }

    const rows = yield* state()
    if (!rows.some((row) => row.id === id)) {
      yield* fail(`${id} is not bundled into this build. Run: opencode vsworker plugins list`)
      return
    }

    const ctx = yield* InstanceRef
    const base = args.global ? Global.Path.config : (ctx?.worktree ?? process.cwd())
    const file = yield* Effect.promise(() => resolveConfigPath(base, Boolean(args.global)))
    yield* Effect.promise(() => patchBundledPlugin({ id, enabled, file }))
    yield* Config.use.invalidate()

    UI.empty()
    prompts.log.success(`${enabled ? "Enabled" : "Disabled"} ${id} in ${file}`)
  })
}

export const VsWorkerPluginsEnableCommand = effectCmd({
  command: "enable <id>",
  describe: "turn on a bundled plugin",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", describe: "bundled plugin id" })
      .option("global", { alias: ["g"], type: "boolean", default: false, describe: "write to the global config" }),
  handler: toggle(true),
})

export const VsWorkerPluginsDisableCommand = effectCmd({
  command: "disable <id>",
  describe: "turn off a bundled plugin",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", describe: "bundled plugin id" })
      .option("global", { alias: ["g"], type: "boolean", default: false, describe: "write to the global config" }),
  handler: toggle(false),
})

export const VsWorkerPluginsCommand = cmd({
  command: "plugins",
  aliases: ["plugin"],
  describe: "inspect and toggle the plugins bundled into this build",
  builder: (yargs) =>
    yargs
      .command(VsWorkerPluginsListCommand)
      .command(VsWorkerPluginsEnableCommand)
      .command(VsWorkerPluginsDisableCommand)
      .demandCommand(),
  async handler() {},
})

export const VsWorkerCommand = cmd({
  command: "vsworker",
  describe: "VsWorker specific commands",
  builder: (yargs) => yargs.command(VsWorkerPluginsCommand).demandCommand(),
  async handler() {},
})
