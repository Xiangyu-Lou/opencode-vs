// vsworker-seam: fork-owned handlers for the VsWorker management routes.
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import * as InstanceState from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { VsWorkerConfigEdit } from "@/vsworker/config-edit"
import { VsWorkerDescribe } from "@/vsworker/describe"
import { VsWorkerPluginEdit } from "@/vsworker/plugin-edit"
import { VsWorkerSkillFiles } from "@/vsworker/skill-files"
import { Filesystem } from "@/util/filesystem"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  VsWorkerConflictError,
  VsWorkerInvalidError,
  VsWorkerNotFoundError,
  type McpRemovePayload,
  type McpTogglePayload,
  type McpUpsertPayload,
  type PluginAddPayload,
  type PluginRemovePayload,
  type PluginUpdatePayload,
  type SkillRemovePayload,
  type SkillSourcesPayload,
  type SkillTogglePayload,
  type SkillWritePayload,
} from "../groups/vsworker"
import { markInstanceForDisposal } from "../lifecycle"

type Scope = VsWorkerConfigEdit.Scope

// Writes land in files the whole process reads, so the instance is torn down after the response and rebuilt
// on the next request. That is the same mechanism PATCH /config uses, and what makes a toggled MCP server or
// plugin actually start or stop.
const reload = (config: Config.Interface) =>
  Effect.gen(function* () {
    yield* config.invalidate()
    yield* markInstanceForDisposal(yield* InstanceState.context)
  })

const target = Effect.fn("VsWorkerHttpApi.target")(function* (scope: Scope) {
  const ctx = yield* InstanceRef
  if (scope === "project" && !VsWorkerConfigEdit.projectDir(ctx)) {
    return yield* new VsWorkerInvalidError({ message: "no project is open", field: "scope" })
  }
  const base = VsWorkerConfigEdit.baseDir(scope, ctx)
  return yield* Effect.promise(() => VsWorkerConfigEdit.resolveFile(base, scope))
})

// Config writes are plain promises; translate their two expected failures into declared API errors and let
// anything else surface as a 500.
type WriteError = VsWorkerConflictError | VsWorkerInvalidError | VsWorkerNotFoundError

const write = <A>(run: () => Promise<A>): Effect.Effect<A, WriteError> =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error): Effect.Effect<never, WriteError> => {
      if (error instanceof VsWorkerConfigEdit.ConflictError) {
        return Effect.fail(
          new VsWorkerConflictError({
            file: error.file,
            expected: error.expected,
            actual: error.actual,
            message: error.message,
          }),
        )
      }
      if (
        error instanceof VsWorkerSkillFiles.InvalidNameError ||
        error instanceof VsWorkerSkillFiles.ExistsError ||
        error instanceof VsWorkerPluginEdit.InstallError ||
        error instanceof VsWorkerPluginEdit.DuplicateError
      ) {
        return Effect.fail(new VsWorkerInvalidError({ message: error.message }))
      }
      if (error instanceof VsWorkerSkillFiles.MissingError || error instanceof VsWorkerPluginEdit.MissingError) {
        return Effect.fail(
          new VsWorkerNotFoundError({
            id: error instanceof VsWorkerSkillFiles.MissingError ? error.skill : error.spec,
            message: error.message,
          }),
        )
      }
      return Effect.die(error)
    }),
  )

const revisionsAfter = Effect.fn("VsWorkerHttpApi.revisionsAfter")(function* () {
  return VsWorkerDescribe.revisions(yield* VsWorkerDescribe.files())
})

export const vsworkerHandlers = HttpApiBuilder.group(InstanceHttpApi, "vsworker", (handlers) =>
  Effect.gen(function* () {
    // Services are resolved once while the handler layer is built, as the HttpApi conventions require; each
    // one keys its own per-instance state off the request's directory.
    const skill = yield* Skill.Service
    const mcpService = yield* MCP.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    type Deps = Skill.Service | MCP.Service | Config.Service | RuntimeFlags.Service
    const provide = <A, E>(self: Effect.Effect<A, E, Deps>) =>
      self.pipe(
        Effect.provideService(Skill.Service, skill),
        Effect.provideService(MCP.Service, mcpService),
        Effect.provideService(Config.Service, config),
        Effect.provideService(RuntimeFlags.Service, flags),
      )

    const pluginList = Effect.fn("VsWorkerHttpApi.pluginList")(function* () {
      return yield* provide(VsWorkerDescribe.plugins(yield* VsWorkerDescribe.files()))
    })

    const pluginUpdate = Effect.fn("VsWorkerHttpApi.pluginUpdate")(function* (ctx: {
      params: { id: string }
      payload: typeof PluginUpdatePayload.Type
    }) {
      const file = yield* target(ctx.payload.scope)
      const id = ctx.params.id
      if (!VsWorkerDescribe.isBundledPlugin(id)) {
        return yield* new VsWorkerNotFoundError({ id, message: `${id} is not bundled into this build` })
      }
      yield* write(() =>
        VsWorkerConfigEdit.patch({
          file,
          expectedRevision: ctx.payload.expectedRevision,
          edits: (parsed) => {
            const edits: VsWorkerConfigEdit.Edit[] = []
            if (ctx.payload.options !== undefined) {
              // Writing options forces the object form, so set enabled alongside it rather than replacing the
              // object with a bare boolean.
              const enabled =
                ctx.payload.enabled ?? VsWorkerDescribe.pluginEnabled(parsed, id) ?? VsWorkerDescribe.pluginDefault(id)
              edits.push({
                path: ["vsworker", "plugins", id],
                value: { enabled, options: ctx.payload.options ?? undefined },
              })
              return edits
            }
            if (ctx.payload.enabled !== undefined) {
              edits.push({
                path: VsWorkerConfigEdit.togglePath("plugins", id, parsed),
                value: ctx.payload.enabled,
              })
            }
            return edits
          },
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const pluginAdd = Effect.fn("VsWorkerHttpApi.pluginAdd")(function* (ctx: {
      payload: typeof PluginAddPayload.Type
    }) {
      const spec = ctx.payload.spec.trim()
      if (!spec) return yield* new VsWorkerInvalidError({ message: "spec is required", field: "spec" })
      const file = yield* target(ctx.payload.scope)
      const tui = yield* Effect.promise(() => VsWorkerPluginEdit.tuiFile(file))
      yield* write(() =>
        VsWorkerPluginEdit.add({ spec, file, tuiFile: tui, expectedRevision: ctx.payload.expectedRevision }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const pluginRemove = Effect.fn("VsWorkerHttpApi.pluginRemove")(function* (ctx: {
      payload: typeof PluginRemovePayload.Type
    }) {
      const file = yield* target(ctx.payload.scope)
      const tui = yield* Effect.promise(() => VsWorkerPluginEdit.tuiFile(file))
      yield* write(() =>
        VsWorkerPluginEdit.remove({
          spec: ctx.payload.spec,
          file,
          tuiFile: tui,
          expectedRevision: ctx.payload.expectedRevision,
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const skillList = Effect.fn("VsWorkerHttpApi.skillList")(function* () {
      return yield* provide(VsWorkerDescribe.skills(yield* VsWorkerDescribe.files()))
    })

    const skillContent = Effect.fn("VsWorkerHttpApi.skillContent")(function* (ctx: { params: { name: string } }) {
      const found = yield* provide(VsWorkerDescribe.locate(ctx.params.name))
      if (!found) {
        return yield* new VsWorkerNotFoundError({ id: ctx.params.name, message: `no skill named ${ctx.params.name}` })
      }
      const parsed = yield* Effect.promise(() => VsWorkerSkillFiles.read(found.location))
      return {
        name: parsed.name,
        description: parsed.description,
        location: found.location,
        content: parsed.content,
        editable: found.editable,
      }
    })

    const skillToggle = Effect.fn("VsWorkerHttpApi.skillToggle")(function* (ctx: {
      params: { name: string }
      payload: typeof SkillTogglePayload.Type
    }) {
      const name = ctx.params.name
      if (!VsWorkerDescribe.isBundledSkill(name)) {
        return yield* new VsWorkerNotFoundError({ id: name, message: `${name} is not bundled into this build` })
      }
      const file = yield* target(ctx.payload.scope)
      yield* write(() =>
        VsWorkerConfigEdit.toggle({
          kind: "skills",
          id: name,
          enabled: ctx.payload.enabled,
          file,
          expectedRevision: ctx.payload.expectedRevision,
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const skillWrite = Effect.fn("VsWorkerHttpApi.skillWrite")(function* (ctx: {
      payload: typeof SkillWritePayload.Type
    }) {
      const roots = yield* VsWorkerDescribe.skillRoots()
      const root = VsWorkerDescribe.skillDir(ctx.payload.scope, roots)
      if (!root) return yield* new VsWorkerInvalidError({ message: "no project is open", field: "scope" })
      if (!VsWorkerSkillFiles.validName(ctx.payload.name)) {
        return yield* new VsWorkerInvalidError({
          message: `invalid skill name: ${ctx.payload.name}`,
          field: "name",
        })
      }
      const file = VsWorkerSkillFiles.location(root, ctx.payload.name)
      const exists = yield* Effect.promise(() => Filesystem.exists(file))
      yield* write(() =>
        exists
          ? VsWorkerSkillFiles.update({
              root,
              name: ctx.payload.name,
              description: ctx.payload.description,
              content: ctx.payload.content,
            })
          : VsWorkerSkillFiles.create({
              root,
              name: ctx.payload.name,
              description: ctx.payload.description,
              content: ctx.payload.content,
            }),
      )
      yield* reload(config)
      return {
        name: ctx.payload.name,
        description: ctx.payload.description,
        location: file,
        content: ctx.payload.content,
        editable: true,
      }
    })

    const skillRemove = Effect.fn("VsWorkerHttpApi.skillRemove")(function* (ctx: {
      params: { name: string }
      payload: typeof SkillRemovePayload.Type
    }) {
      const roots = yield* VsWorkerDescribe.skillRoots()
      const root = VsWorkerDescribe.skillDir(ctx.payload.scope, roots)
      if (!root) return yield* new VsWorkerInvalidError({ message: "no project is open", field: "scope" })
      yield* write(() => VsWorkerSkillFiles.remove({ root, name: ctx.params.name }))
      yield* reload(config)
      return true
    })

    const skillSources = Effect.fn("VsWorkerHttpApi.skillSources")(function* (ctx: {
      payload: typeof SkillSourcesPayload.Type
    }) {
      const file = yield* target(ctx.payload.scope)
      const paths = ctx.payload.paths.filter((item) => item.trim().length > 0)
      const urls = ctx.payload.urls.filter((item) => item.trim().length > 0)
      yield* write(() =>
        VsWorkerConfigEdit.patch({
          file,
          expectedRevision: ctx.payload.expectedRevision,
          edits: [
            { path: ["skills", "paths"], value: paths.length ? paths : undefined },
            { path: ["skills", "urls"], value: urls.length ? urls : undefined },
          ],
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const mcpList = Effect.fn("VsWorkerHttpApi.mcpList")(function* () {
      return yield* provide(VsWorkerDescribe.mcp(yield* VsWorkerDescribe.files()))
    })

    const mcpUpsert = Effect.fn("VsWorkerHttpApi.mcpUpsert")(function* (ctx: {
      params: { name: string }
      payload: typeof McpUpsertPayload.Type
    }) {
      const name = ctx.params.name.trim()
      if (!name) return yield* new VsWorkerInvalidError({ message: "name is required", field: "name" })
      const file = yield* target(ctx.payload.scope)
      yield* write(() =>
        VsWorkerConfigEdit.patch({
          file,
          expectedRevision: ctx.payload.expectedRevision,
          edits: [{ path: ["mcp", name], value: ctx.payload.config }],
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const mcpToggle = Effect.fn("VsWorkerHttpApi.mcpToggle")(function* (ctx: {
      params: { name: string }
      payload: typeof McpTogglePayload.Type
    }) {
      const file = yield* target(ctx.payload.scope)
      yield* write(() =>
        VsWorkerConfigEdit.toggle({
          kind: "mcp",
          id: ctx.params.name,
          enabled: ctx.payload.enabled,
          file,
          expectedRevision: ctx.payload.expectedRevision,
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    const mcpRemove = Effect.fn("VsWorkerHttpApi.mcpRemove")(function* (ctx: {
      params: { name: string }
      payload: typeof McpRemovePayload.Type
    }) {
      const file = yield* target(ctx.payload.scope)
      yield* write(() =>
        VsWorkerConfigEdit.patch({
          file,
          expectedRevision: ctx.payload.expectedRevision,
          edits: [{ path: ["mcp", ctx.params.name], value: undefined }],
        }),
      )
      yield* reload(config)
      return yield* revisionsAfter()
    })

    return handlers
      .handle("pluginList", pluginList)
      .handle("pluginUpdate", pluginUpdate)
      .handle("pluginAdd", pluginAdd)
      .handle("pluginRemove", pluginRemove)
      .handle("skillList", skillList)
      .handle("skillContent", skillContent)
      .handle("skillToggle", skillToggle)
      .handle("skillWrite", skillWrite)
      .handle("skillRemove", skillRemove)
      .handle("skillSources", skillSources)
      .handle("mcpList", mcpList)
      .handle("mcpUpsert", mcpUpsert)
      .handle("mcpToggle", mcpToggle)
      .handle("mcpRemove", mcpRemove)
  }),
)
