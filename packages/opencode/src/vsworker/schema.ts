export * as VsWorkerSchema from "./schema"

import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { MCP } from "@/mcp"
import { Schema } from "effect"

export const Scope = Schema.Literals(["global", "project"]).annotate({ identifier: "VsWorkerScope" })
export type Scope = Schema.Schema.Type<typeof Scope>

// Revision of each writable config file as the caller last saw it. A file that does not exist yet has the
// empty string, so creating it races the same way editing it does.
export const Revisions = Schema.Struct({
  global: Schema.String,
  project: Schema.optional(Schema.String),
  globalFile: Schema.String,
  projectFile: Schema.optional(Schema.String),
}).annotate({ identifier: "VsWorkerRevisions" })
export type Revisions = Schema.Schema.Type<typeof Revisions>

// How a bundled entry resolves against the user's config. Mirrors the CLI's state vocabulary.
export const BundledState = Schema.Literals([
  "enabled",
  "disabled-by-config",
  "disabled-by-default",
  "shadowed",
  "killed",
]).annotate({ identifier: "VsWorkerBundledState" })

// Where a user-owned entry was declared.
export const Origin = Schema.Literals([
  "global",
  "project",
  "discovered",
  "external",
  "url",
  "remote",
  "other",
]).annotate({ identifier: "VsWorkerOrigin" })
export type Origin = Schema.Schema.Type<typeof Origin>

export const BundledPlugin = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["npm", "github", "local"]),
  spec: Schema.String,
  version: Schema.String,
  description: Schema.optional(Schema.String),
  state: BundledState,
  shadowedBy: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // Which file currently carries the on/off decision, when there is one.
  decidedIn: Schema.optional(Scope),
}).annotate({ identifier: "VsWorkerBundledPlugin" })

export const UserPlugin = Schema.Struct({
  spec: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["npm", "file"]),
  origin: Origin,
  file: Schema.String,
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // Auto-discovered and remote plugins cannot be removed by editing a config file we own.
  removable: Schema.Boolean,
  scope: Schema.optional(Scope),
}).annotate({ identifier: "VsWorkerUserPlugin" })

export const PluginList = Schema.Struct({
  revisions: Revisions,
  bundled: Schema.Array(BundledPlugin),
  user: Schema.Array(UserPlugin),
}).annotate({ identifier: "VsWorkerPluginList" })

export const BundledSkill = Schema.Struct({
  id: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  state: BundledState,
  shadowedBy: Schema.optional(Schema.String),
  decidedIn: Schema.optional(Scope),
}).annotate({ identifier: "VsWorkerBundledSkill" })

export const UserSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  origin: Origin,
  editable: Schema.Boolean,
  scope: Schema.optional(Scope),
}).annotate({ identifier: "VsWorkerUserSkill" })

export const SkillSources = Schema.Struct({
  paths: Schema.Array(Schema.String),
  urls: Schema.Array(Schema.String),
}).annotate({ identifier: "VsWorkerSkillSources" })

export const SkillList = Schema.Struct({
  revisions: Revisions,
  bundled: Schema.Array(BundledSkill),
  user: Schema.Array(UserSkill),
  sources: SkillSources,
}).annotate({ identifier: "VsWorkerSkillList" })

export const BundledMcp = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["local", "remote"]),
  target: Schema.String,
  description: Schema.optional(Schema.String),
  state: BundledState,
  status: Schema.optional(MCP.Status),
  config: ConfigMCPV1.Info,
  decidedIn: Schema.optional(Scope),
}).annotate({ identifier: "VsWorkerBundledMcp" })

export const UserMcp = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["local", "remote"]),
  target: Schema.String,
  enabled: Schema.Boolean,
  origin: Origin,
  file: Schema.String,
  scope: Schema.optional(Scope),
  editable: Schema.Boolean,
  status: Schema.optional(MCP.Status),
  config: ConfigMCPV1.Info,
}).annotate({ identifier: "VsWorkerUserMcp" })

export const McpList = Schema.Struct({
  revisions: Revisions,
  bundled: Schema.Array(BundledMcp),
  user: Schema.Array(UserMcp),
}).annotate({ identifier: "VsWorkerMcpList" })

export const SkillContent = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
  editable: Schema.Boolean,
}).annotate({ identifier: "VsWorkerSkillContent" })

// A bundled skill's packaged env.json next to the overrides each writable config file carries for it. Values are
// the raw text of each source, placeholders intact, because that is what the editor edits.
export const SkillEnv = Schema.Struct({
  name: Schema.String,
  location: Schema.String,
  present: Schema.Boolean,
  defaults: Schema.Record(Schema.String, Schema.String),
  problems: Schema.Array(Schema.String),
  // Both scopes are always present; an empty record means the file carries no override for this skill.
  overrides: Schema.Struct({
    global: Schema.Record(Schema.String, Schema.String),
    project: Schema.Record(Schema.String, Schema.String),
  }),
}).annotate({ identifier: "VsWorkerSkillEnv" })
