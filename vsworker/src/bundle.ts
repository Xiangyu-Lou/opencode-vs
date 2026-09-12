export * as VsWorkerBundle from "./bundle"

import { truthy } from "@opencode-ai/core/flag/flag"

export type Source = "npm" | "github" | "local"
export type Kind = "server" | "tui"

// The shape emitted into src/*.gen.ts. `mod` is the raw imported namespace, still un-normalized.
export type Raw = {
  id: string
  source: Source
  spec: string
  pkg: { name: string; version: string }
  options: Record<string, unknown> | undefined
  defaultEnabled: boolean
  mod: unknown
}

// A bundle entry after its module namespace has been normalized once at startup.
export type Entry = Omit<Raw, "mod"> & { mod: Record<string, unknown> }

// Structural twin of PluginLoader.Loaded (packages/opencode/src/plugin/loader.ts). Bundled plugins never touch
// disk, so target/entry carry the spec and pkg is synthetic; applyPlugin only reads mod/spec/source/pkg/options.
export type Loaded = {
  spec: string
  options: Record<string, unknown> | undefined
  deprecated: false
  source: "npm"
  target: string
  entry: string
  pkg: { dir: string; pkg: string; json: Record<string, unknown> }
  mod: Record<string, unknown>
}

export type UserPlugin = boolean | { enabled?: boolean; options?: Record<string, unknown> }
export type UserPlugins = Record<string, UserPlugin | undefined>

export const DISABLE_ENV = "VSWORKER_DISABLE_BUNDLED_PLUGINS"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasPluginShape(value: Record<string, unknown>) {
  return "id" in value || "server" in value || "tui" in value
}

// Bundlers and runtime `import()` both expose a CJS module as `{ default: module.exports, ...namedGetters }`.
// Two consequences the plugin host cannot handle on its own:
//   - a transpiled ES module is reachable only at `default.default` (the `__esModule` marker says so)
//   - a plain CJS module's `default` duplicates the named exports, and getLegacyPlugins() throws on the extra
//     non-function value
// Normalizing here keeps bundled plugins working regardless of how they were published.
export function normalize(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  let mod: Record<string, unknown> = { ...value }

  const inner = mod["default"]
  if (isRecord(inner) && inner["__esModule"] === true && "default" in inner) {
    mod = { ...inner }
    delete mod["__esModule"]
  }

  const fallback = mod["default"]
  if (isRecord(fallback) && !hasPluginShape(fallback)) {
    const named = Object.keys(mod).filter((key) => key !== "default")
    const mirrors = named.length > 0 && named.every((key) => Object.is(mod[key], fallback[key]))
    if (mirrors) delete mod["default"]
  }

  return mod
}

export function prepare(bundle: readonly Raw[]): Entry[] {
  return bundle.map((entry) => ({ ...entry, mod: normalize(entry.mod) }))
}

export type SelectInput = {
  bundle: readonly Entry[]
  user?: UserPlugins
  // Package names declared by the user in `plugin`. A user declaration of the same package always wins so
  // someone can pin their own version of a bundled plugin.
  external?: ReadonlySet<string>
  // OPENCODE_PURE / OPENCODE_DISABLE_DEFAULT_PLUGINS, resolved by the caller.
  disabled?: boolean
}

export type State = "enabled" | "disabled-by-config" | "disabled-by-default" | "shadowed" | "killed"

export type Described = {
  id: string
  source: Source
  spec: string
  version: string
  state: State
  shadowedBy?: string
}

function killed(input: SelectInput) {
  // Read at call time, not module load, so tests can set and restore the env var (matches the Flag getters).
  return Boolean(input.disabled) || truthy(DISABLE_ENV)
}

function resolve(entry: Entry, input: SelectInput): { state: State; options: Record<string, unknown> | undefined } {
  const user = input.user?.[entry.id]
  const enabled = typeof user === "boolean" ? user : (user?.enabled ?? entry.defaultEnabled)
  const overrides = typeof user === "object" && user ? user.options : undefined
  const merged = entry.options || overrides ? { ...entry.options, ...overrides } : undefined

  if (input.external?.has(entry.pkg.name)) return { state: "shadowed", options: merged }
  if (!enabled) {
    return { state: user === undefined ? "disabled-by-default" : "disabled-by-config", options: merged }
  }
  return { state: "enabled", options: merged }
}

export function select(input: SelectInput): Loaded[] {
  if (killed(input)) return []
  const result: Loaded[] = []
  for (const entry of input.bundle) {
    const hit = resolve(entry, input)
    if (hit.state !== "enabled") continue
    result.push({
      spec: entry.spec,
      options: hit.options,
      deprecated: false,
      source: "npm",
      target: entry.spec,
      entry: entry.spec,
      pkg: { dir: "", pkg: "", json: { name: entry.pkg.name, version: entry.pkg.version } },
      mod: entry.mod,
    })
  }
  return result
}

// A bundled TUI plugin, minus the host-specific wrapping. The TUI runtime owns the PluginLoad/PluginEntry
// shapes, so the seam there builds those from this; keeping them out of here means this package never has to
// depend on the TUI surface.
export type TuiSelected = {
  id: string
  spec: string
  options: Record<string, unknown> | undefined
  enabled: boolean
  mod: Record<string, unknown>
}

export function selectTui(input: SelectInput): TuiSelected[] {
  if (killed(input)) return []
  const result: TuiSelected[] = []
  for (const entry of input.bundle) {
    const hit = resolve(entry, input)
    // The TUI persists its own per-plugin enabled state in tui.json and KV, so a plugin the user turned off
    // is still registered here and simply starts inactive.
    if (hit.state === "shadowed") continue
    result.push({
      id: entry.id,
      spec: entry.spec,
      options: hit.options,
      enabled: hit.state === "enabled",
      mod: entry.mod,
    })
  }
  return result
}

export function describe(input: SelectInput): Described[] {
  const dead = killed(input)
  return input.bundle.map((entry) => {
    const hit = resolve(entry, input)
    return {
      id: entry.id,
      source: entry.source,
      spec: entry.spec,
      version: entry.pkg.version,
      state: dead ? ("killed" as const) : hit.state,
      ...(hit.state === "shadowed" ? { shadowedBy: entry.pkg.name } : {}),
    }
  })
}
