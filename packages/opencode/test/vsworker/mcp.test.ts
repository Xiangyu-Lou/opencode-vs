import { afterEach, beforeEach, describe, expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { VsWorkerMcp } from "@vsworker/bundle/mcp"
import { Effect } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { configLayer, withTree } from "./tree"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// preload.ts disables bundled MCP servers for every other suite; this one is about the bundle itself.
const kill = process.env[VsWorkerMcp.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerMcp.DISABLE_ENV]
})
afterEach(async () => {
  if (kill === undefined) delete process.env[VsWorkerMcp.DISABLE_ENV]
  else process.env[VsWorkerMcp.DISABLE_ENV] = kill
  await disposeAllInstances()
})

function stub(config?: VsWorkerMcp.Server, defaultEnabled = true): VsWorkerMcp.Raw {
  return {
    id: "stub",
    defaultEnabled,
    description: "bundled stub",
    config: config ?? { type: "remote", url: "http://bundled" },
  }
}

const mcp = () => Config.use.get().pipe(Effect.map((config) => config.mcp))

// One layer per test, because the bundle a test injects is part of that layer.
function scenario<A, E>(
  name: string,
  input: { bundle: VsWorkerMcp.Raw[]; global?: object; project?: object },
  body: () => Effect.Effect<A, E, Config.Service | FSUtil.Service>,
) {
  const layer = configLayer([[VsWorkerMcp.node, VsWorkerMcp.layer(input.bundle)]])
  testEffect(layer).live(name, () =>
    withTree({ global: input.global, project: input.project, layer }, Effect.suspend(body)),
  )
}

describe("vsworker.mcp", () => {
  scenario("injects a bundled server the user never mentioned", { bundle: [stub()] }, () =>
    Effect.gen(function* () {
      expect(yield* mcp()).toMatchObject({ stub: { type: "remote", url: "http://bundled", enabled: true } })
    }),
  )

  scenario("honours defaultEnabled false", { bundle: [stub(undefined, false)] }, () =>
    Effect.gen(function* () {
      expect(yield* mcp()).toMatchObject({ stub: { enabled: false } })
    }),
  )

  scenario(
    "lets project config turn a bundled server off",
    { bundle: [stub()], project: { mcp: { stub: { enabled: false } } } },
    () =>
      Effect.gen(function* () {
        expect(yield* mcp()).toMatchObject({ stub: { type: "remote", url: "http://bundled", enabled: false } })
      }),
  )

  scenario(
    "lets global config turn a bundled server off",
    { bundle: [stub()], global: { mcp: { stub: { enabled: false } } } },
    () =>
      Effect.gen(function* () {
        expect(yield* mcp()).toMatchObject({ stub: { enabled: false } })
      }),
  )

  scenario(
    "yields to a user definition of the same name",
    { bundle: [stub()], project: { mcp: { stub: { type: "local", command: ["mine"] } } } },
    () =>
      Effect.gen(function* () {
        expect(yield* mcp()).toMatchObject({ stub: { type: "local", command: ["mine"] } })
      }),
  )

  scenario(
    "keeps the user's own servers alongside the bundled ones",
    { bundle: [stub()], project: { mcp: { other: { type: "remote", url: "http://other" } } } },
    () =>
      Effect.gen(function* () {
        expect(Object.keys((yield* mcp()) ?? {}).toSorted()).toEqual(["other", "stub"])
      }),
  )

  scenario(
    "substitutes {env:} in a bundled definition",
    { bundle: [stub({ type: "remote", url: "http://bundled", headers: { Token: "{env:VSWORKER_TEST_TOKEN}" } })] },
    () =>
      Effect.gen(function* () {
        process.env["VSWORKER_TEST_TOKEN"] = "from-env"
        expect((yield* mcp())?.stub).toMatchObject({ headers: { Token: "from-env" } })
      }).pipe(Effect.ensuring(Effect.sync(() => delete process.env["VSWORKER_TEST_TOKEN"]))),
  )

  scenario(
    "resolves {file:} against the global config directory",
    {
      bundle: [stub({ type: "remote", url: "http://bundled", headers: { Token: "{file:token.txt}" } })],
      global: {},
    },
    () =>
      Effect.gen(function* () {
        // Global.Path.config is the swapped tmpdir for the duration of withTree.
        yield* FSUtil.use.writeWithDirs(path.join(Global.Path.config, "token.txt"), "from-file")
        yield* Config.use.invalidate()
        expect((yield* mcp())?.stub).toMatchObject({ headers: { Token: "from-file" } })
      }),
  )

  scenario("injects nothing when the kill switch is set", { bundle: [stub()] }, () =>
    Effect.gen(function* () {
      process.env[VsWorkerMcp.DISABLE_ENV] = "1"
      yield* Config.use.invalidate()
      expect(yield* mcp()).toBeUndefined()
    }),
  )

  scenario("injects nothing under OPENCODE_PURE", { bundle: [stub()] }, () =>
    Effect.gen(function* () {
      process.env["OPENCODE_PURE"] = "1"
      yield* Config.use.invalidate()
      expect(yield* mcp()).toBeUndefined()
    }).pipe(Effect.ensuring(Effect.sync(() => delete process.env["OPENCODE_PURE"]))),
  )
})
