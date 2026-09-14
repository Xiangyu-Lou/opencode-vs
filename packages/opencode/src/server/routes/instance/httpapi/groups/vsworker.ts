// vsworker-seam: fork-owned route group. Upstream never touches this file; it is registered from api.ts and
// server.ts, which are the two marked seams.
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { VsWorkerSchema } from "@/vsworker/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// A write always names the file it believes it is editing. `expectedRevision` is what the client last read;
// if the file changed since, the write is refused rather than silently overwriting a hand edit.
const Write = {
  scope: VsWorkerSchema.Scope,
  expectedRevision: Schema.optional(Schema.String),
}

export class VsWorkerConflictError extends Schema.ErrorClass<VsWorkerConflictError>("VsWorkerConflictError")(
  {
    file: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class VsWorkerNotFoundError extends Schema.ErrorClass<VsWorkerNotFoundError>("VsWorkerNotFoundError")(
  { id: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class VsWorkerInvalidError extends Schema.ErrorClass<VsWorkerInvalidError>("VsWorkerInvalidError")(
  { message: Schema.String, field: Schema.optional(Schema.String) },
  { httpApiStatus: 400 },
) {}

const errors = [VsWorkerConflictError, VsWorkerNotFoundError, VsWorkerInvalidError] as const

export const PluginUpdatePayload = Schema.Struct({
  ...Write,
  enabled: Schema.optional(Schema.Boolean),
  // An empty object clears the options key rather than writing an empty record.
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const PluginAddPayload = Schema.Struct({ ...Write, spec: Schema.String })
export const PluginRemovePayload = Schema.Struct({ ...Write, spec: Schema.String })

export const SkillTogglePayload = Schema.Struct({ ...Write, enabled: Schema.Boolean })
export const SkillWritePayload = Schema.Struct({
  scope: VsWorkerSchema.Scope,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  content: Schema.String,
})
export const SkillRemovePayload = Schema.Struct({ scope: VsWorkerSchema.Scope })
export const SkillSourcesPayload = Schema.Struct({
  ...Write,
  paths: Schema.Array(Schema.String),
  urls: Schema.Array(Schema.String),
})

export const McpUpsertPayload = Schema.Struct({ ...Write, config: ConfigMCPV1.Info })
export const McpTogglePayload = Schema.Struct({ ...Write, enabled: Schema.Boolean })
export const McpRemovePayload = Schema.Struct(Write)

export const VsWorkerPaths = {
  plugin: "/vsworker/plugin",
  pluginItem: "/vsworker/plugin/:id",
  skill: "/vsworker/skill",
  skillItem: "/vsworker/skill/:name",
  skillContent: "/vsworker/skill/:name/content",
  skillSources: "/vsworker/skill-source",
  mcp: "/vsworker/mcp",
  mcpItem: "/vsworker/mcp/:name",
} as const

const query = { query: WorkspaceRoutingQuery }
const idParam = { params: { id: Schema.String } }
const nameParam = { params: { name: Schema.String } }

export const VsWorkerApi = HttpApi.make("vsworker")
  .add(
    HttpApiGroup.make("vsworker")
      .add(
        HttpApiEndpoint.get("pluginList", VsWorkerPaths.plugin, {
          ...query,
          success: described(VsWorkerSchema.PluginList, "Bundled and user plugins"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.plugin.list",
            summary: "List plugins",
            description: "List the plugins bundled into this build alongside the ones declared in config.",
          }),
        ),
        HttpApiEndpoint.patch("pluginUpdate", VsWorkerPaths.pluginItem, {
          ...query,
          ...idParam,
          payload: PluginUpdatePayload,
          success: described(VsWorkerSchema.Revisions, "Config written"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.plugin.update",
            summary: "Update a bundled plugin",
            description: "Enable, disable, or set the options of a plugin bundled into this build.",
          }),
        ),
        HttpApiEndpoint.post("pluginAdd", VsWorkerPaths.plugin, {
          ...query,
          payload: PluginAddPayload,
          success: described(VsWorkerSchema.Revisions, "Plugin added"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.plugin.add",
            summary: "Add a plugin",
            description: "Install a plugin package and declare it in the chosen config file.",
          }),
        ),
        HttpApiEndpoint.delete("pluginRemove", VsWorkerPaths.pluginItem, {
          ...query,
          ...idParam,
          payload: PluginRemovePayload,
          success: described(VsWorkerSchema.Revisions, "Plugin removed"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.plugin.remove",
            summary: "Remove a plugin",
            description: "Remove a plugin entry from the chosen config file.",
          }),
        ),
        HttpApiEndpoint.get("skillList", VsWorkerPaths.skill, {
          ...query,
          success: described(VsWorkerSchema.SkillList, "Bundled, user, and discovered skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.skill.list",
            summary: "List skills",
            description: "List the skills bundled into this build alongside the ones found on disk.",
          }),
        ),
        HttpApiEndpoint.get("skillContent", VsWorkerPaths.skillContent, {
          ...query,
          ...nameParam,
          success: described(VsWorkerSchema.SkillContent, "Skill body"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.skill.content",
            summary: "Read a skill",
            description: "Read the frontmatter and body of one skill.",
          }),
        ),
        HttpApiEndpoint.patch("skillToggle", VsWorkerPaths.skillItem, {
          ...query,
          ...nameParam,
          payload: SkillTogglePayload,
          success: described(VsWorkerSchema.Revisions, "Config written"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.skill.toggle",
            summary: "Toggle a bundled skill",
            description: "Enable or disable a skill bundled into this build.",
          }),
        ),
        HttpApiEndpoint.post("skillWrite", VsWorkerPaths.skill, {
          ...query,
          payload: SkillWritePayload,
          success: described(VsWorkerSchema.SkillContent, "Skill written"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.skill.write",
            summary: "Create or update a skill",
            description: "Write a SKILL.md into the chosen scope, creating it when it does not exist.",
          }),
        ),
        HttpApiEndpoint.delete("skillRemove", VsWorkerPaths.skillItem, {
          ...query,
          ...nameParam,
          payload: SkillRemovePayload,
          success: described(Schema.Boolean, "Skill removed"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.skill.remove",
            summary: "Remove a skill",
            description: "Delete a skill directory that lives in a scope this build writes to.",
          }),
        ),
        HttpApiEndpoint.put("skillSources", VsWorkerPaths.skillSources, {
          ...query,
          payload: SkillSourcesPayload,
          success: described(VsWorkerSchema.Revisions, "Config written"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.skill.sources",
            summary: "Set skill sources",
            description: "Replace the extra skill paths and urls in the chosen config file.",
          }),
        ),
        HttpApiEndpoint.get("mcpList", VsWorkerPaths.mcp, {
          ...query,
          success: described(VsWorkerSchema.McpList, "Bundled and user MCP servers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.mcp.list",
            summary: "List MCP servers",
            description: "List the MCP servers bundled into this build alongside the ones declared in config.",
          }),
        ),
        HttpApiEndpoint.put("mcpUpsert", VsWorkerPaths.mcpItem, {
          ...query,
          ...nameParam,
          payload: McpUpsertPayload,
          success: described(VsWorkerSchema.Revisions, "Config written"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.mcp.upsert",
            summary: "Add or edit an MCP server",
            description: "Write a full MCP server definition into the chosen config file.",
          }),
        ),
        HttpApiEndpoint.patch("mcpToggle", VsWorkerPaths.mcpItem, {
          ...query,
          ...nameParam,
          payload: McpTogglePayload,
          success: described(VsWorkerSchema.Revisions, "Config written"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.mcp.toggle",
            summary: "Toggle an MCP server",
            description: "Enable or disable an MCP server through the stock mcp.<name>.enabled key.",
          }),
        ),
        HttpApiEndpoint.delete("mcpRemove", VsWorkerPaths.mcpItem, {
          ...query,
          ...nameParam,
          payload: McpRemovePayload,
          success: described(VsWorkerSchema.Revisions, "Server removed"),
          error: errors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vsworker.mcp.remove",
            summary: "Remove an MCP server",
            description: "Remove an MCP server definition from the chosen config file.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "vsworker",
          description: "VsWorker plugin, skill, and MCP management routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "VsWorker HttpApi",
      version: "0.0.1",
      description: "Routes backing the desktop client's plugin, skill, and MCP management UI.",
    }),
  )
