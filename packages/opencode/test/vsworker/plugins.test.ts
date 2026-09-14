import { afterEach, beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { VsWorkerPlugins } from "@vsworker/bundle"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Config } from "@/config/config"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const { Plugin } = await import("../../src/plugin/index")
const { TestConfig } = await import("../fixture/config")
const { RuntimeFlags } = await import("../../src/effect/runtime-flags")

// preload.ts disables bundled plugins for every other suite; this one is about the bundle itself.
const kill = process.env[VsWorkerPlugins.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerPlugins.DISABLE_ENV]
})
afterEach(async () => {
  if (kill === undefined) delete process.env[VsWorkerPlugins.DISABLE_ENV]
  else process.env[VsWorkerPlugins.DISABLE_ENV] = kill
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])), testInstanceStoreLayer),
)

type StubInput = {
  id?: string
  pkg?: string
  marker: string
  defaultEnabled?: boolean
  options?: Record<string, unknown>
  throws?: boolean
}

// A stub bundle entry whose server() records that it ran, plus the options it was handed.
function stub(input: StubInput): VsWorkerPlugins.Raw {
  const id = input.id ?? "stub"
  const name = input.pkg ?? `opencode-${id}`
  return {
    id,
    source: "npm",
    spec: `${name}@1.0.0`,
    pkg: { name, version: "1.0.0" },
    options: input.options,
    description: undefined,
    defaultEnabled: input.defaultEnabled ?? true,
    mod: {
      default: {
        id,
        server: async (_: unknown, options: Record<string, unknown> | undefined) => {
          if (input.throws) throw new Error("stub plugin exploded")
          await Bun.write(input.marker, JSON.stringify(options ?? null))
          return {}
        },
      },
    },
  }
}

type ConfigInput = {
  plugin?: string[]
  vsworker?: { plugins?: Record<string, boolean | { enabled?: boolean; options?: Record<string, unknown> }> }
}

function load(
  dir: string,
  bundle: VsWorkerPlugins.Raw[],
  config: ConfigInput = {},
  flags?: Parameters<typeof RuntimeFlags.layer>[0],
) {
  return Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    yield* plugin.list()
  }).pipe(
    Effect.provide(
      LayerNode.compile(Plugin.node, [
        [
          Config.node,
          TestConfig.layer({
            // plugin_origins stays empty so the external loader never tries to install anything.
            get: () => Effect.succeed({ ...config, plugin_origins: [] }),
            directories: () => Effect.succeed([dir]),
          }),
        ],
        [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: false, ...flags })],
        [VsWorkerPlugins.node, VsWorkerPlugins.layer({ server: VsWorkerPlugins.prepare(bundle) })],
      ]),
    ),
    provideInstance(dir),
  )
}

function ran(marker: string) {
  return fs.readFile(marker, "utf8").then(
    (text) => ({ ran: true, options: JSON.parse(text) as unknown }),
    () => ({ ran: false, options: null }),
  )
}

describe("vsworker.plugins", () => {
  it.live("loads a bundled plugin", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [stub({ marker })])
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: true })
    }),
  )

  it.live("passes the bundled options through, with user options layered on top", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [stub({ marker, options: { url: "http://bundled", keep: 1 } })], {
        vsworker: { plugins: { stub: { options: { url: "http://user" } } } },
      })
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({
        ran: true,
        options: { url: "http://user", keep: 1 },
      })
    }),
  )

  it.live("skips a plugin the user disabled", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [stub({ marker })], { vsworker: { plugins: { stub: false } } })
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: false })
    }),
  )

  it.live("yields to a plugin the user declared themselves", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [stub({ marker, pkg: "opencode-stub" })], { plugin: ["opencode-stub@9.9.9"] })
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: false })
    }),
  )

  it.live("skips everything when the kill switch is set", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      process.env[VsWorkerPlugins.DISABLE_ENV] = "1"
      yield* load(dir, [stub({ marker })])
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: false })
    }),
  )

  it.live("skips everything under OPENCODE_PURE", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [stub({ marker })], {}, { pure: true })
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: false })
    }),
  )

  it.live("skips everything under OPENCODE_DISABLE_DEFAULT_PLUGINS", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [stub({ marker })], {}, { disableDefaultPlugins: true })
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: false })
    }),
  )

  it.live("keeps loading after one bundled plugin throws", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const marker = path.join(dir, "stub.json")
      yield* load(dir, [
        stub({ id: "bad", marker: path.join(dir, "bad.json"), throws: true }),
        stub({ id: "stub", marker }),
      ])
      expect(yield* Effect.promise(() => ran(marker))).toMatchObject({ ran: true })
    }),
  )
})
