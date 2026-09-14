export * as VsWorkerDescribe from "./describe"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { VsWorkerPlugins } from "@vsworker/bundle"
import { VsWorkerMcp } from "@vsworker/bundle/mcp"
import { VsWorkerSkills } from "@vsworker/bundle/skills"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigVariable } from "@/config/variable"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { parsePluginSpecifier } from "@/plugin/shared"
import { Skill } from "@/skill"
import { VsWorkerConfigEdit } from "./config-edit"
import { VsWorkerPluginEdit } from "./plugin-edit"
import type { VsWorkerSchema } from "./schema"

type Scope = VsWorkerConfigEdit.Scope

// Both writable config files, read once per request so every row can say which file its value came from and
// so the response carries the revisions a follow-up write must pin itself to.
export type Files = {
  global: { file: string; revision: string; parsed: unknown }
  project?: { file: string; revision: string; parsed: unknown }
}

export const files = Effect.fn("VsWorker.files")(function* () {
  const ctx = yield* InstanceRef
  const root = VsWorkerConfigEdit.projectDir(ctx)
  const globalFile = yield* Effect.promise(() =>
    VsWorkerConfigEdit.resolveFile(VsWorkerConfigEdit.baseDir("global", ctx), "global"),
  )
  const global = yield* Effect.promise(() => VsWorkerConfigEdit.read(globalFile))
  if (!root) return { global }

  const projectFile = yield* Effect.promise(() => VsWorkerConfigEdit.resolveFile(root, "project"))
  // A project without its own config file resolves to the same path as the global one only when the worktree
  // is the config directory itself; treat that as "no project scope" rather than showing the file twice.
  if (projectFile === globalFile) return { global }
  const project = yield* Effect.promise(() => VsWorkerConfigEdit.read(projectFile))
  return { global, project }
})

export function revisions(input: Files): VsWorkerSchema.Revisions {
  return {
    global: input.global.revision,
    globalFile: input.global.file,
    project: input.project?.revision,
    projectFile: input.project?.file,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return VsWorkerConfigEdit.isRecord(value) ? value : undefined
}

// Which of the two files we can write carries an explicit decision for this entry. Project wins because that
// is the precedence the config merge itself applies.
function decidedIn(input: Files, read: (parsed: unknown) => boolean): Scope | undefined {
  if (input.project && read(input.project.parsed)) return "project"
  if (read(input.global.parsed)) return "global"
  return undefined
}

function pluginDecision(id: string) {
  return (parsed: unknown) => {
    const vsworker = record(record(parsed)?.["vsworker"])
    const plugins = record(vsworker?.["plugins"])
    return plugins !== undefined && id in plugins
  }
}

function skillDecision(id: string) {
  return (parsed: unknown) => {
    const vsworker = record(record(parsed)?.["vsworker"])
    const skills = record(vsworker?.["skills"])
    return skills !== undefined && id in skills
  }
}

function mcpDecision(id: string) {
  return (parsed: unknown) => {
    const mcp = record(record(parsed)?.["mcp"])
    const entry = record(mcp?.[id])
    return entry !== undefined && "enabled" in entry
  }
}

// ---------------------------------------------------------------------------------------------- lookups

export function isBundledPlugin(id: string) {
  return VsWorkerPlugins.bundle.server.some((entry) => entry.id === id)
}

export function isBundledSkill(id: string) {
  return VsWorkerSkills.bundle.some((entry) => entry.id === id)
}

export function isBundledMcp(id: string) {
  return VsWorkerMcp.bundle.some((entry) => entry.id === id)
}

export function pluginDefault(id: string) {
  return VsWorkerPlugins.bundle.server.find((entry) => entry.id === id)?.defaultEnabled ?? false
}

// The explicit decision this file already carries for a bundled plugin, if any, so writing options does not
// silently flip the switch.
export function pluginEnabled(parsed: unknown, id: string): boolean | undefined {
  const vsworker = record(record(parsed)?.["vsworker"])
  const plugins = record(vsworker?.["plugins"])
  const value = plugins?.[id]
  if (typeof value === "boolean") return value
  const entry = record(value)
  if (entry && typeof entry["enabled"] === "boolean") return entry["enabled"] as boolean
  return undefined
}

// Find a skill by name across every source, together with whether this build may rewrite it.
export const locate = Effect.fn("VsWorker.locate")(function* (name: string) {
  const service = yield* Skill.Service
  const roots = yield* skillRoots()
  const hit = yield* service.get(name)
  if (!hit || !path.isAbsolute(hit.location)) return undefined
  const where = placement({
    location: hit.location,
    globalDir: roots.globalDir,
    projectDir: roots.projectDir,
    home: Global.Path.home,
    cache: Global.Path.cache,
  })
  // A bundled skill materializes into the cache; it is readable but never editable in place.
  const bundledRoot = VsWorkerSkills.root(Global.Path.cache)
  const bundled = hit.location.startsWith(bundledRoot + path.sep)
  return { location: hit.location, editable: where.editable && !bundled }
})

// ---------------------------------------------------------------------------------------------- plugins

export const plugins = Effect.fn("VsWorker.describe.plugins")(function* (input: Files) {
  const config = yield* Config.use.get()
  const flags = yield* RuntimeFlags.Service

  const external = new Set(
    (config.plugin ?? []).map((item) => parsePluginSpecifier(ConfigPlugin.pluginSpecifier(item)).pkg),
  )

  const bundled: (typeof VsWorkerSchema.BundledPlugin.Type)[] = VsWorkerPlugins.describe({
    bundle: VsWorkerPlugins.bundle.server,
    user: config.vsworker?.plugins,
    external,
    disabled: flags.pure || flags.disableDefaultPlugins,
  }).map((row) => {
    const user = config.vsworker?.plugins?.[row.id]
    const options = typeof user === "object" && user ? user.options : undefined
    const entry = VsWorkerPlugins.bundle.server.find((item) => item.id === row.id)
    return {
      ...row,
      options: options ?? entry?.options,
      decidedIn: decidedIn(input, pluginDecision(row.id)),
    }
  })

  const declaredIn = (where: Files["project"], spec: string) =>
    where !== undefined &&
    VsWorkerPluginEdit.specs(where.parsed).some((raw) => VsWorkerPluginEdit.matches(raw, spec, where.file))

  const user: (typeof VsWorkerSchema.UserPlugin.Type)[] = (config.plugin_origins ?? []).map((origin) => {
    const spec = ConfigPlugin.pluginSpecifier(origin.spec)
    const options = ConfigPlugin.pluginOptions(origin.spec)
    const file = origin.source
    const scope: Scope | undefined = declaredIn(input.project, spec)
      ? "project"
      : declaredIn(input.global, spec)
        ? "global"
        : undefined
    const kind = spec.startsWith("file://") ? ("file" as const) : ("npm" as const)
    const where: VsWorkerSchema.Origin = (() => {
      if (file.startsWith("http://") || file.startsWith("https://")) return "remote"
      if (scope) return scope
      // Auto-discovered plugins are attributed to the directory they were scanned from, not to a config file.
      if (!file.endsWith(".json") && !file.endsWith(".jsonc")) return "discovered"
      return "other"
    })()
    return {
      spec,
      name: kind === "file" ? path.basename(spec) : parsePluginSpecifier(spec).pkg,
      kind,
      origin: where,
      file,
      options: options as Record<string, unknown> | undefined,
      removable: scope !== undefined,
      scope,
    }
  })

  return { revisions: revisions(input), bundled, user }
})

// ---------------------------------------------------------------------------------------------- mcp

const substitutedBundle = Effect.fn("VsWorker.describe.mcp.bundle")(function* () {
  // The bundle is a build constant, substituted the way the config seam substitutes so a definition the user
  // copied verbatim is recognised rather than reported as shadowing.
  const result = yield* Effect.promise(() =>
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
  return result.bundle
})

export const mcp = Effect.fn("VsWorker.describe.mcp")(function* (input: Files) {
  const config = yield* Config.use.get()
  const flags = yield* RuntimeFlags.Service
  const service = yield* MCP.Service
  const status = yield* service.status().pipe(Effect.catch(() => Effect.succeed({} as Record<string, MCP.Status>)))
  const bundle = yield* substitutedBundle()

  const bundled: (typeof VsWorkerSchema.BundledMcp.Type)[] = VsWorkerMcp.describe({
    bundle,
    config: config.mcp,
    disabled: flags.pure,
  }).map((row) => ({
    ...row,
    status: status[row.id],
    config: bundle.find((item) => item.id === row.id)!.config,
    decidedIn: decidedIn(input, mcpDecision(row.id)),
  }))

  const bundledIds = new Set(bundle.map((item) => item.id))
  const globalMcp = record(record(input.global.parsed)?.["mcp"])
  const projectMcp = record(record(input.project?.parsed)?.["mcp"])

  const user: (typeof VsWorkerSchema.UserMcp.Type)[] = []
  for (const [name, value] of Object.entries(config.mcp ?? {})) {
    if (bundledIds.has(name)) continue
    // An entry without a `type` cannot be rendered or edited: config decoding already dropped everything else.
    if (!("type" in value)) continue
    const scope: Scope | undefined =
      projectMcp && name in projectMcp ? "project" : globalMcp && name in globalMcp ? "global" : undefined
    const file = scope === "project" ? input.project!.file : scope === "global" ? input.global.file : ""
    user.push({
      name,
      type: value.type,
      target: VsWorkerMcp.target(value),
      enabled: value.enabled !== false,
      origin: scope ?? "other",
      file,
      scope,
      editable: scope !== undefined,
      status: status[name],
      config: value,
    })
  }

  return { revisions: revisions(input), bundled, user }
})

// ---------------------------------------------------------------------------------------------- skills

export type SkillPlacement = {
  origin: VsWorkerSchema.Origin
  scope?: Scope
  editable: boolean
}

// Classify a skill by where its SKILL.md lives. Only skills under a directory we would write to ourselves are
// editable; everything else is someone else's to manage.
export function placement(input: {
  location: string
  globalDir: string
  projectDir?: string
  home: string
  cache: string
}): SkillPlacement {
  const within = (root: string) => input.location === root || input.location.startsWith(root + path.sep)
  if (input.projectDir && within(input.projectDir)) return { origin: "project", scope: "project", editable: true }
  if (within(input.globalDir)) return { origin: "global", scope: "global", editable: true }
  if (within(path.join(input.cache, "skills"))) return { origin: "url", editable: false }
  if (within(path.join(input.home, ".claude")) || within(path.join(input.home, ".agents"))) {
    return { origin: "external", editable: false }
  }
  return { origin: "other", editable: false }
}

export function skillDir(scope: Scope, input: { globalDir: string; projectDir?: string }) {
  return scope === "project" ? input.projectDir : input.globalDir
}

// Where this build writes user skills for each scope. Global mirrors one of the directories the skill scanner
// already walks; project uses .opencode/skills, which the scanner reaches through config.directories().
export const skillRoots = Effect.fn("VsWorker.skillRoots")(function* () {
  const ctx = yield* InstanceRef
  const root = VsWorkerConfigEdit.projectDir(ctx)
  const globalDir = path.join(Global.Path.config, "skills")
  const projectDir = root ? path.join(root, ".opencode", "skills") : undefined
  return { globalDir, projectDir }
})

export const skills = Effect.fn("VsWorker.describe.skills")(function* (input: Files) {
  const config = yield* Config.use.get()
  const flags = yield* RuntimeFlags.Service
  const service = yield* Skill.Service
  const roots = yield* skillRoots()
  const root = VsWorkerSkills.root(Global.Path.cache)

  const shadowed = new Map<string, string>()
  for (const entry of VsWorkerSkills.bundle) {
    const hit = yield* service.get(entry.id)
    if (hit && hit.location !== VsWorkerSkills.location(root, entry.id)) shadowed.set(entry.id, hit.location)
  }

  const bundled: (typeof VsWorkerSchema.BundledSkill.Type)[] = VsWorkerSkills.describe({
    bundle: VsWorkerSkills.bundle,
    root,
    user: config.vsworker?.skills,
    disabled: flags.pure,
    shadowed,
  }).map((row) => ({ ...row, decidedIn: decidedIn(input, skillDecision(row.id)) }))

  const bundledLocations = new Set(VsWorkerSkills.bundle.map((entry) => VsWorkerSkills.location(root, entry.id)))
  const all = yield* service.all()
  const user: (typeof VsWorkerSchema.UserSkill.Type)[] = all
    .filter((skill) => !bundledLocations.has(skill.location))
    // The built-in customize skill has no file of its own.
    .filter((skill) => path.isAbsolute(skill.location))
    .map((skill) => {
      const where = placement({
        location: skill.location,
        globalDir: roots.globalDir,
        projectDir: roots.projectDir,
        home: Global.Path.home,
        cache: Global.Path.cache,
      })
      return {
        name: skill.name,
        description: skill.description,
        location: skill.location,
        origin: where.origin,
        editable: where.editable,
        scope: where.scope,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    revisions: revisions(input),
    bundled,
    user,
    sources: { paths: config.skills?.paths ?? [], urls: config.skills?.urls ?? [] },
  }
})
