import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import path from "path"
import { Config } from "@/config/config"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Env } from "@/env"
import { InstanceRuntime } from "@/project/instance-runtime"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noHttp = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
)

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [httpClient, Layer.succeed(HttpClient.HttpClient, noHttp)],
])

const it = testEffect(layer)

const write = (dir: string, config: object, name = "opencode.json") =>
  FSUtil.use.writeWithDirs(
    path.join(dir, name),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )

const reset = () =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())),
    )

// Swaps the global config dir the same way test/config/config.test.ts does, so a "global" layer can be written.
const withTree = <A, E, R>(input: { global?: object; project?: object }, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const globalDir = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    if (input.global) yield* write(globalDir, input.global)
    if (input.project) yield* write(directory, input.project)
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = globalDir
        yield* reset()
        return previous
      }),
      () =>
        effect.pipe(
          provideInstanceEffect(directory),
          Effect.provide(testInstanceStoreLayer),
          Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
        ),
      (previous) =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* reset()
        }),
    )
  })

describe("config.vsworker", () => {
  it.live("keeps the vsworker.plugins block through decoding", () =>
    withTree(
      { project: { vsworker: { plugins: { a: false, b: { enabled: true, options: { url: "http://x" } } } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.plugins).toEqual({ a: false, b: { enabled: true, options: { url: "http://x" } } })
      }),
    ),
  )

  it.live("merges global and project overrides per plugin id", () =>
    withTree(
      { global: { vsworker: { plugins: { a: false } } }, project: { vsworker: { plugins: { b: false } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.plugins).toEqual({ a: false, b: false })
      }),
    ),
  )

  it.live("lets project config override a global decision for the same plugin", () =>
    withTree(
      { global: { vsworker: { plugins: { a: false } } }, project: { vsworker: { plugins: { a: true } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.plugins?.a).toBe(true)
      }),
    ),
  )
})
