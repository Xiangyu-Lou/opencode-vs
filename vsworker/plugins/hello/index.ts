import type { PluginModule } from "@opencode-ai/plugin"

// Template + smoke test for the bundling pipeline. It is bundled into every build but is off by default
// (see defaultEnabled in vsworker/plugins.jsonc), so a release is unaffected until someone turns it on with
// `opencode vsworker plugins enable hello`. Copy this directory as the starting point for a real in-house
// plugin, and read vsworker/README.md for the constraints a bundled plugin has to satisfy.
export default {
  id: "hello",
  async server(input, options) {
    process.stderr.write(`[vsworker] bundled plugin hello loaded for ${input.directory}\n`)
    if (options && Object.keys(options).length) {
      process.stderr.write(`[vsworker] hello options: ${JSON.stringify(options)}\n`)
    }
    return {}
  },
} satisfies PluginModule
