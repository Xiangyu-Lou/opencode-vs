export * as ConfigVsWorkerV1 from "./vsworker"

import { Schema } from "effect"
import { ConfigPluginV1 } from "./plugin"

export const Plugin = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    enabled: Schema.optional(Schema.Boolean).annotate({
      description: "Enable or disable this bundled plugin",
    }),
    options: Schema.optional(ConfigPluginV1.Options).annotate({
      description: "Options merged over the options the plugin was bundled with",
    }),
  }),
])
export type Plugin = Schema.Schema.Type<typeof Plugin>

// The same value types env.json accepts, so a hand-written override coerces the way the file does.
export const SkillEnvValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
export const SkillEnv = Schema.Record(Schema.String, SkillEnvValue)
export type SkillEnv = Schema.Schema.Type<typeof SkillEnv>

export const Info = Schema.Struct({
  plugins: Schema.optional(Schema.Record(Schema.String, Plugin)).annotate({
    description:
      "Overrides for plugins bundled with VsWorker, keyed by plugin id. Set an id to false to turn that plugin off",
  }),
  skills: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "Overrides for skills bundled with VsWorker, keyed by skill name. Set a name to false to turn that skill off",
  }),
  skill_env: Schema.optional(Schema.Record(Schema.String, SkillEnv)).annotate({
    description:
      "Environment overrides for skills bundled with VsWorker, keyed by skill name and layered over the skill's env.json. Global and project values merge per variable",
  }),
}).annotate({ identifier: "VsWorker" })
export type Info = Schema.Schema.Type<typeof Info>
