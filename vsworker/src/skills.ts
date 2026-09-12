export * as VsWorkerSkills from "./skills"

import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { truthy } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Context, Effect, Layer } from "effect"
import { hash as digest, skills } from "./skills.gen"

// One file of a bundled skill, carried as text in the build. Binary payloads are base64 so the generated module
// stays a plain TypeScript source file.
export type RawFile = {
  path: string
  encoding: "utf8" | "base64"
  executable: boolean
  data: string
}

export type Raw = {
  id: string
  defaultEnabled: boolean
  description: string | undefined
  files: readonly RawFile[]
}

export type Entry = Raw

export type UserSkills = { readonly [name: string]: boolean | undefined } | undefined

export const DISABLE_ENV = "VSWORKER_DISABLE_BUNDLED_SKILLS"

// Written after every other file, so an interrupted materialization is redone on the next start rather than
// leaving a half-written skill behind a matching stamp.
export const STAMP = ".bundle.json"

export const bundle: readonly Entry[] = skills
export const hash = digest

export function killed(input: { disabled?: boolean }) {
  // Read at call time, not module load, so tests can set and restore the env var (matches the Flag getters).
  return Boolean(input.disabled) || truthy(DISABLE_ENV)
}

export type SelectInput = {
  bundle: readonly Entry[]
  user?: UserSkills
  disabled?: boolean
}

export function select(input: SelectInput): Entry[] {
  if (killed(input)) return []
  return input.bundle.filter((entry) => input.user?.[entry.id] ?? entry.defaultEnabled)
}

export function root(cache: string) {
  return path.join(cache, "vsworker", "skills")
}

export function dir(root: string, id: string) {
  return path.join(root, id)
}

export function location(root: string, id: string) {
  return path.join(root, id, "SKILL.md")
}

export async function current(root: string, hash: string) {
  try {
    const stamp: unknown = JSON.parse(await fs.readFile(path.join(root, STAMP), "utf8"))
    return typeof stamp === "object" && stamp !== null && (stamp as { hash?: unknown }).hash === hash
  } catch {
    return false
  }
}

export type MaterializeInput = {
  root: string
  hash: string
  bundle: readonly Entry[]
}

// The whole bundle is written, not just the enabled subset, so the stamp means the same thing no matter which
// skills a particular project turned on.
export async function materialize(input: MaterializeInput) {
  if (await current(input.root, input.hash)) return
  await Flock.withLock(`vsworker-skills:${input.root}`, async () => {
    if (await current(input.root, input.hash)) return
    await fs.rm(input.root, { recursive: true, force: true })
    await fs.mkdir(input.root, { recursive: true })
    for (const entry of input.bundle) {
      for (const file of entry.files) {
        const target = path.join(input.root, entry.id, ...file.path.split("/"))
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.encoding === "base64" ? Buffer.from(file.data, "base64") : file.data)
        if (file.executable) await fs.chmod(target, 0o755)
      }
    }
    await fs.writeFile(path.join(input.root, STAMP), JSON.stringify({ hash: input.hash }) + "\n")
  })
}

export type Materialized = {
  id: string
  dir: string
  location: string
}

export type State = "enabled" | "disabled-by-config" | "disabled-by-default" | "shadowed" | "killed"

export type Described = {
  id: string
  description: string | undefined
  location: string
  state: State
  shadowedBy?: string
}

export function describe(input: SelectInput & { root: string; shadowed?: ReadonlyMap<string, string> }): Described[] {
  const dead = killed(input)
  return input.bundle.map((entry) => {
    const row = { id: entry.id, description: entry.description, location: location(input.root, entry.id) }
    if (dead) return { ...row, state: "killed" as const }
    const user = input.user?.[entry.id]
    if (!(user ?? entry.defaultEnabled)) {
      return { ...row, state: user === undefined ? ("disabled-by-default" as const) : ("disabled-by-config" as const) }
    }
    const shadowedBy = input.shadowed?.get(entry.id)
    if (shadowedBy) return { ...row, state: "shadowed" as const, shadowedBy }
    return { ...row, state: "enabled" as const }
  })
}

export interface Interface {
  readonly root: string
  readonly hash: string
  readonly bundle: readonly Entry[]
  readonly ensure: (selected: readonly Entry[]) => Effect.Effect<Materialized[]>
}

export class Service extends Context.Service<Service, Interface>()("@vsworker/Skills") {}

export function make(input: MaterializeInput): Interface {
  // Materialization is per process, not per instance: the files are a build constant. The promise is dropped on
  // failure so a transient filesystem error is retried by the next instance instead of being cached forever.
  let pending: Promise<void> | undefined
  const once = () => {
    pending ??= materialize(input).catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }

  const ensure = Effect.fn("VsWorkerSkills.ensure")(function* (selected: readonly Entry[]) {
    if (!selected.length) return [] as Materialized[]
    return yield* Effect.tryPromise({ try: once, catch: (error) => error }).pipe(
      Effect.as(
        selected.map((entry) => ({
          id: entry.id,
          dir: dir(input.root, entry.id),
          location: location(input.root, entry.id),
        })),
      ),
      // Skills are additive, so a build that cannot write its cache directory keeps working without them.
      Effect.catch((error) =>
        Effect.logError("failed to materialize bundled skills", { root: input.root, error }).pipe(
          Effect.as([] as Materialized[]),
        ),
      ),
    )
  })

  return { root: input.root, hash: input.hash, bundle: input.bundle, ensure }
}

export function layer(input: { root: string; hash?: string; bundle?: readonly Entry[] }) {
  return Layer.succeed(
    Service,
    Service.of(make({ root: input.root, hash: input.hash ?? digest, bundle: input.bundle ?? bundle })),
  )
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      return Service.of(make({ root: root(global.cache), hash: digest, bundle }))
    }),
  ),
  deps: [Global.node],
})
