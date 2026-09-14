import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { VsWorkerRelease } from "@vsworker/bundle/release"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "@/installation"
import { testEffect } from "../lib/effect"

// Same doubles as test/installation/installation.test.ts, which does not export them. Both record what they were
// asked for, because the point of the guard is that a VsWorker build asks for nothing at all.
function mockHttpClient(requests: string[]) {
  const client = HttpClient.make((request) => {
    requests.push(request.url)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ version: "99.0.0", tag_name: "v99.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  })
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(commands: string[]) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    commands.push(std?.command ?? "")
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: Stream.make(new TextEncoder().encode("opencode-ai@1.18.30")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function testLayer(requests: string[], commands: string[]) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(commands),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(requests)],
    [CrossSpawnSpawner.node, spawnerNode],
    [VsWorkerRelease.node, VsWorkerRelease.layer({ active: true })],
  ])
}

describe("installation in a VsWorker build", () => {
  const methodRequests: string[] = []
  const methodCommands: string[] = []
  testEffect(testLayer(methodRequests, methodCommands)).effect(
    "reports no installation method, and probes for none",
    () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.method()).toBe("unknown")
        expect(methodCommands).toEqual([])
        expect(methodRequests).toEqual([])
      }),
  )

  const latestRequests: string[] = []
  const latestCommands: string[] = []
  testEffect(testLayer(latestRequests, latestCommands)).effect("reports the running version as the latest one", () =>
    Effect.gen(function* () {
      expect(yield* Installation.use.latest("npm")).toBe(InstallationVersion)
      expect(latestRequests).toEqual([])
      expect(latestCommands).toEqual([])
    }),
  )

  const upgradeRequests: string[] = []
  const upgradeCommands: string[] = []
  testEffect(testLayer(upgradeRequests, upgradeCommands)).effect("refuses to upgrade, even with a forced method", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("npm", "99.0.0"))
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toBe(VsWorkerRelease.UPGRADE_MESSAGE)
      expect(upgradeCommands).toEqual([])
    }),
  )
})
