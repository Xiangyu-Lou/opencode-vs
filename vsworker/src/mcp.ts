export * as VsWorkerMcp from "./mcp"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { truthy } from "@opencode-ai/core/flag/flag"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Context, Layer } from "effect"
import { mcp } from "./mcp.gen"

// A full server definition, exactly as it would appear under `mcp.<id>` in opencode.json.
export type Server = ConfigMCPV1.Info

// The other arm of the `mcp` config field: a user entry with no `type` can only toggle a server defined
// elsewhere. Config decoding drops every other key from that shape, so `enabled` is all a user can override
// without restating the whole definition.
export type Override = { enabled: boolean }

export type Mcp = { [name: string]: Server | Override }
export type UserMcp = { readonly [name: string]: Server | Override } | undefined

// The shape emitted into src/mcp.gen.ts.
export type Raw = {
  id: string
  defaultEnabled: boolean
  description: string | undefined
  config: Server
}

export type Entry = Raw

export const DISABLE_ENV = "VSWORKER_DISABLE_BUNDLED_MCP"

// Stands in for a config file path when a substitution fails, so the error names something a user can find.
export const SOURCE = "vsworker/bundle.jsonc"

export const bundle: readonly Entry[] = mcp

function isServer(value: Server | Override): value is Server {
  return "type" in value
}

export function killed(input: { disabled?: boolean }) {
  // Read at call time, not module load, so tests can set and restore the env var (matches the Flag getters).
  return Boolean(input.disabled) || truthy(DISABLE_ENV)
}

export type ApplyInput = {
  bundle: readonly Entry[]
  user: UserMcp
  disabled?: boolean
}

// Bundled servers join the merged config beneath whatever the user wrote. Precedence, highest first:
// a user definition with a `type` (the bundled one is ignored entirely), a bare `{ enabled }` override, then
// the manifest's defaultEnabled.
export function apply(input: ApplyInput): Mcp | undefined {
  if (killed(input)) return input.user as Mcp | undefined
  if (!input.bundle.length) return input.user as Mcp | undefined

  const result: Mcp = { ...input.user }
  for (const entry of input.bundle) {
    const user = result[entry.id]
    if (user && isServer(user)) continue
    result[entry.id] = { ...entry.config, enabled: user ? user.enabled : entry.defaultEnabled }
  }
  return result
}

export type Substitute = (text: string) => Promise<string>

// {env:VAR} and {file:path} normally run over raw config text before it is parsed, so a bundled definition has
// to make its own pass. Substituting the whole JSON document rather than each value is deliberate: {file:}
// splices JSON-escaped content, which is only valid inside a JSON string.
export async function substitute(entries: readonly Entry[], fn: Substitute) {
  const warnings: string[] = []
  const result: Entry[] = []
  for (const entry of entries) {
    const text = JSON.stringify(entry.config)
    if (!text.includes("{env:") && !text.includes("{file:")) {
      result.push(entry)
      continue
    }
    try {
      result.push({ ...entry, config: JSON.parse(await fn(text)) as Server })
    } catch (error) {
      // A substituted value containing a quote breaks the JSON just as it would in a real config file. Keep the
      // unsubstituted definition so one bad variable cannot take config loading down with it.
      warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
      result.push(entry)
    }
  }
  return { bundle: result, warnings }
}

export type ResolveInput = {
  bundle?: readonly Entry[]
  user: UserMcp
  disabled?: boolean
  substitute: Substitute
}

export async function resolve(input: ResolveInput) {
  const entries = input.bundle ?? bundle
  if (killed(input) || !entries.length) {
    return { mcp: input.user as Mcp | undefined, warnings: [] as string[] }
  }
  const substituted = await substitute(entries, input.substitute)
  return {
    mcp: apply({ bundle: substituted.bundle, user: input.user, disabled: input.disabled }),
    warnings: substituted.warnings,
  }
}

export type State = "enabled" | "disabled-by-config" | "disabled-by-default" | "shadowed" | "killed"

export type Described = {
  id: string
  type: "local" | "remote"
  target: string
  description: string | undefined
  state: State
}

export function target(config: Server) {
  return config.type === "remote" ? config.url : config.command.join(" ")
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]),
  )
}

function sameServer(a: Server, b: Server) {
  const strip = ({ enabled: _, ...rest }: Server) => canonical(rest)
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

// Describes the bundle against the *merged* config, which is what a CLI sees. A user entry that carries a `type`
// and differs from the bundled definition is the user's own server, not ours.
export function describe(input: { bundle: readonly Entry[]; config: UserMcp; disabled?: boolean }): Described[] {
  const dead = killed(input)
  return input.bundle.map((entry) => {
    const row = {
      id: entry.id,
      type: entry.config.type,
      target: target(entry.config),
      description: entry.description,
    }
    if (dead) return { ...row, state: "killed" as const }

    const current = input.config?.[entry.id]
    if (current && isServer(current) && !sameServer(current, entry.config)) {
      return { ...row, state: "shadowed" as const, target: target(current), type: current.type }
    }
    const enabled = current ? current.enabled !== false : entry.defaultEnabled
    if (enabled) return { ...row, state: "enabled" as const }
    return { ...row, state: entry.defaultEnabled ? ("disabled-by-config" as const) : ("disabled-by-default" as const) }
  })
}

export interface Interface {
  readonly bundle: readonly Entry[]
}

export class Service extends Context.Service<Service, Interface>()("@vsworker/Mcp") {}

export function layer(entries: readonly Entry[] = []) {
  return Layer.succeed(Service, Service.of({ bundle: entries }))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer(bundle),
  deps: [],
})
