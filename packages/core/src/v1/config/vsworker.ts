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

export const Info = Schema.Struct({
  plugins: Schema.optional(Schema.Record(Schema.String, Plugin)).annotate({
    description:
      "Overrides for plugins bundled with VsWorker, keyed by plugin id. Set an id to false to turn that plugin off",
  }),
  skills: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "Overrides for skills bundled with VsWorker, keyed by skill name. Set a name to false to turn that skill off",
  }),
}).annotate({ identifier: "VsWorker" })
export type Info = Schema.Schema.Type<typeof Info>
