import * as prompts from "@clack/prompts"
import { Global } from "@opencode-ai/core/global"
import { VsWorkerPlugins } from "@vsworker/bundle"
import { VsWorkerMcp } from "@vsworker/bundle/mcp"
import { VsWorkerEnv } from "@vsworker/bundle/env"
import { VsWorkerSkills } from "@vsworker/bundle/skills"
import { Effect } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigVariable } from "@/config/variable"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { parsePluginSpecifier } from "@/plugin/shared"
import { Skill } from "@/skill"
import { VsWorkerConfigEdit } from "@/vsworker/config-edit"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const pluginState = Effect.fn("Cli.vsworker.plugins.state")(function* () {
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

const mcpState = Effect.fn("Cli.vsworker.mcp.state")(function* () {
  const config = yield* Config.use.get()
  const flags = yield* RuntimeFlags.Service
  // The bundle is a build constant, read here the same way the plugin list reads its own. Substituted the way
  // the config seam substitutes, so a definition the user copied verbatim is recognised rather than reported as
  // shadowing.
  const substituted = yield* Effect.promise(() =>
    VsWorkerMcp.substitute(VsWorkerMcp.bundle, (text) =>
      ConfigVariable.substitute({
        text,
        type: "virtual",
        source: VsWorkerMcp.SOURCE,
        dir: Global.Path.config,
        missing: "empty",
      }),
    ),
  )
  return VsWorkerMcp.describe({ bundle: substituted.bundle, config: config.mcp, disabled: flags.pure })
})

const skillState = Effect.fn("Cli.vsworker.skills.state")(function* () {
  const config = yield* Config.use.get()
  const flags = yield* RuntimeFlags.Service
  const skill = yield* Skill.Service
  const root = VsWorkerSkills.root(Global.Path.cache)

  const shadowed = new Map<string, string>()
  for (const entry of VsWorkerSkills.bundle) {
    const hit = yield* skill.get(entry.id)
    if (hit && hit.location !== VsWorkerSkills.location(root, entry.id)) shadowed.set(entry.id, hit.location)
  }

  return VsWorkerSkills.describe({
    bundle: VsWorkerSkills.bundle,
    root,
    user: config.vsworker?.skills,
    disabled: flags.pure,
    shadowed,
  })
})

type Label = { icon: string; text: string }

const PLUGIN_LABELS: Record<VsWorkerPlugins.State, Label> = {
  enabled: { icon: "✓", text: "enabled" },
  "disabled-by-config": { icon: "○", text: "disabled in config" },
  "disabled-by-default": { icon: "○", text: "off by default, enable it in config" },
  shadowed: { icon: "⚠", text: "overridden by a plugin you declared yourself" },
  killed: { icon: "○", text: "bundled plugins are disabled for this run" },
}

const MCP_LABELS: Record<VsWorkerMcp.State, Label> = {
  enabled: { icon: "✓", text: "enabled" },
  "disabled-by-config": { icon: "○", text: "disabled in config" },
  "disabled-by-default": { icon: "○", text: "off by default, enable it in config" },
  shadowed: { icon: "⚠", text: "replaced by your own mcp entry" },
  killed: { icon: "○", text: "bundled MCP servers are disabled for this run" },
}

const SKILL_LABELS: Record<VsWorkerSkills.State, Label> = {
  enabled: { icon: "✓", text: "enabled" },
  "disabled-by-config": { icon: "○", text: "disabled in config" },
  "disabled-by-default": { icon: "○", text: "off by default, enable it in config" },
  shadowed: { icon: "⚠", text: "overridden by a skill of the same name on disk" },
  killed: { icon: "○", text: "bundled skills are disabled for this run" },
}

function print(rows: { icon: string; id: string; text: string; detail: string }[], empty: string, hint: string) {
  if (!rows.length) {
    prompts.log.warn(empty)
    prompts.outro(hint)
    return
  }
  for (const row of rows) {
    prompts.log.info(`${row.icon} ${row.id} ${UI.Style.TEXT_DIM}${row.text}\n    ${UI.Style.TEXT_DIM}${row.detail}`)
  }
  const on = rows.filter((row) => row.icon === "✓").length
  prompts.outro(`${on} of ${rows.length} enabled`)
}

export const VsWorkerPluginsListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list the plugins bundled into this build",
  handler: Effect.fn("Cli.vsworker.plugins.list")(function* () {
    UI.empty()
    prompts.intro("Bundled plugins")
    const rows = yield* pluginState()
    print(
      rows.map((row) => {
        const label = PLUGIN_LABELS[row.state]
        const text =
          row.state === "shadowed" && row.shadowedBy ? `overridden by your own ${row.shadowedBy} plugin` : label.text
        return { icon: label.icon, id: row.id, text, detail: `${row.source} ${row.spec}` }
      }),
      "This build bundles no plugins",
      "Add them to vsworker/bundle.jsonc and rebuild",
    )
  }),
})

export const VsWorkerMcpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list the MCP servers bundled into this build",
  handler: Effect.fn("Cli.vsworker.mcp.list")(function* () {
    UI.empty()
    prompts.intro("Bundled MCP servers")
    const rows = yield* mcpState()
    print(
      rows.map((row) => ({
        icon: MCP_LABELS[row.state].icon,
        id: row.id,
        text: MCP_LABELS[row.state].text,
        detail: `${row.type} ${row.target}`,
      })),
      "This build bundles no MCP servers",
      "Add them to vsworker/bundle.jsonc and rebuild",
    )
  }),
})

export const VsWorkerSkillsListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list the skills bundled into this build",
  handler: Effect.fn("Cli.vsworker.skills.list")(function* () {
    UI.empty()
    prompts.intro("Bundled skills")
    const rows = yield* skillState()
    // env.json is what a colleague most often needs to check after installing a build, so the count of variables
    // a skill provides is shown next to its directory. Names and values stay out of the list.
    const described = yield* Effect.forEach(rows, (row) =>
      Effect.promise(async () => ({
        row,
        env: row.state === "enabled" ? await VsWorkerEnv.describe(path.dirname(row.location)) : undefined,
      })),
    )
    print(
      described.map(({ row, env }) => ({
        icon: SKILL_LABELS[row.state].icon,
        id: row.id,
        text: SKILL_LABELS[row.state].text,
        detail: (row.shadowedBy ?? row.location) + (env ? ` · ${VsWorkerEnv.FILE}: ${env.keys.length} variables` : ""),
      })),
      "This build bundles no skills",
      "Add them to vsworker/bundle.jsonc and rebuild",
    )
  }),
})

const ids = (kind: VsWorkerConfigEdit.Kind) =>
  Effect.gen(function* () {
    if (kind === "plugins") return (yield* pluginState()).map((row) => row.id)
    if (kind === "mcp") return (yield* mcpState()).map((row) => row.id)
    return (yield* skillState()).map((row) => row.id)
  })

function toggle(kind: VsWorkerConfigEdit.Kind, enabled: boolean) {
  return Effect.fn(`Cli.vsworker.${kind}.toggle`)(function* (args: { id?: string; global?: boolean }) {
    const id = (args.id ?? "").trim()
    if (!id) {
      yield* fail("id is required")
      return
    }

    if (!(yield* ids(kind)).includes(id)) {
      yield* fail(`${id} is not bundled into this build. Run: opencode vsworker ${kind} list`)
      return
    }

    const ctx = yield* InstanceRef
    const scope = args.global ? "global" : "project"
    const base = VsWorkerConfigEdit.baseDir(scope, ctx)
    const file = yield* Effect.promise(() => VsWorkerConfigEdit.resolveFile(base, scope))
    yield* Effect.promise(() => VsWorkerConfigEdit.toggle({ kind, id, enabled, file }))
    yield* Config.use.invalidate()

    UI.empty()
    prompts.log.success(`${enabled ? "Enabled" : "Disabled"} ${id} in ${file}`)
  })
}

function toggleCommands(kind: VsWorkerConfigEdit.Kind, noun: string) {
  const builder = (yargs: Parameters<NonNullable<Parameters<typeof effectCmd>[0]["builder"]>>[0]) =>
    yargs
      .positional("id", { type: "string", describe: `bundled ${noun}` })
      .option("global", { alias: ["g"], type: "boolean", default: false, describe: "write to the global config" })

  return {
    enable: effectCmd({
      command: "enable <id>",
      describe: `turn on a bundled ${noun}`,
      builder,
      handler: toggle(kind, true),
    }),
    disable: effectCmd({
      command: "disable <id>",
      describe: `turn off a bundled ${noun}`,
      builder,
      handler: toggle(kind, false),
    }),
  }
}

const pluginToggles = toggleCommands("plugins", "plugin id")
const mcpToggles = toggleCommands("mcp", "server name")
const skillToggles = toggleCommands("skills", "skill name")

export const VsWorkerPluginsEnableCommand = pluginToggles.enable
export const VsWorkerPluginsDisableCommand = pluginToggles.disable

export const VsWorkerPluginsCommand = cmd({
  command: "plugins",
  aliases: ["plugin"],
  describe: "inspect and toggle the plugins bundled into this build",
  builder: (yargs) =>
    yargs
      .command(VsWorkerPluginsListCommand)
      .command(pluginToggles.enable)
      .command(pluginToggles.disable)
      .demandCommand(),
  async handler() {},
})

export const VsWorkerMcpCommand = cmd({
  command: "mcp",
  describe: "inspect and toggle the MCP servers bundled into this build",
  builder: (yargs) =>
    yargs.command(VsWorkerMcpListCommand).command(mcpToggles.enable).command(mcpToggles.disable).demandCommand(),
  async handler() {},
})

export const VsWorkerSkillsCommand = cmd({
  command: "skills",
  aliases: ["skill"],
  describe: "inspect and toggle the skills bundled into this build",
  builder: (yargs) =>
    yargs.command(VsWorkerSkillsListCommand).command(skillToggles.enable).command(skillToggles.disable).demandCommand(),
  async handler() {},
})

export const VsWorkerCommand = cmd({
  command: "vsworker",
  describe: "VsWorker specific commands",
  builder: (yargs) =>
    yargs.command(VsWorkerPluginsCommand).command(VsWorkerMcpCommand).command(VsWorkerSkillsCommand).demandCommand(),
  async handler() {},
})
