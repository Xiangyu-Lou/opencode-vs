// The package root is the plugin bundle only. MCP servers and skills live behind "@vsworker/bundle/mcp" and
// "@vsworker/bundle/skills" so the config and skill hosts never pull the plugin modules, and with them every
// bundled plugin, into their import graph.
export * as VsWorkerPlugins from "./index"

export { Service, bundle, layer, node, type Interface } from "./service"
export {
  describe,
  normalize,
  prepare,
  select,
  selectTui,
  DISABLE_ENV,
  type Described,
  type Entry,
  type Kind,
  type Loaded,
  type Raw,
  type SelectInput,
  type Source,
  type State,
  type TuiSelected,
  type UserPlugin,
  type UserPlugins,
} from "./plugins"
