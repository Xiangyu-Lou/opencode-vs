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

const noHttp = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
)

export function configLayer(overrides: Parameters<typeof LayerNode.compile>[1] = []) {
  return LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, noHttp)],
    ...overrides,
  ])
}

export const write = (dir: string, config: object, name = "opencode.json") =>
  FSUtil.use.writeWithDirs(
    path.join(dir, name),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )

const reset = (layer: Layer.Layer<never>) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())),
    )

/**
 * Swaps the global config dir the same way test/config/config.test.ts does, so a "global" layer can be written,
 * and runs `effect` against a project directory underneath it.
 */
export const withTree = <A, E, R>(
  input: { global?: object; project?: object; layer: Layer.Layer<never> },
  effect: Effect.Effect<A, E, R>,
) =>
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
        yield* reset(input.layer)
        return { previous, globalDir }
      }),
      () =>
        effect.pipe(
          provideInstanceEffect(directory),
          Effect.provide(testInstanceStoreLayer),
          Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
        ),
      ({ previous }) =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* reset(input.layer)
        }),
    )
  })
