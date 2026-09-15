import { afterEach, beforeEach, describe, expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { VsWorkerProviders } from "@vsworker/bundle/providers"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { configLayer, withTree } from "./tree"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// preload.ts sets this for every other suite, which leaves the hosted providers visible so upstream assertions
// about provider lists keep holding. This one is about the hiding itself.
const kill = process.env[VsWorkerProviders.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerProviders.DISABLE_ENV]
})
afterEach(async () => {
  if (kill === undefined) delete process.env[VsWorkerProviders.DISABLE_ENV]
  else process.env[VsWorkerProviders.DISABLE_ENV] = kill
  await disposeAllInstances()
})

const disabled = () => Config.use.get().pipe(Effect.map((config) => config.disabled_providers))

function scenario<A, E>(
  name: string,
  input: { global?: object; project?: object },
  body: () => Effect.Effect<A, E, Config.Service | FSUtil.Service>,
) {
  const layer = configLayer()
  testEffect(layer).live(name, () =>
    withTree({ global: input.global, project: input.project, layer }, Effect.suspend(body)),
  )
}

describe("vsworker.providers", () => {
  scenario("hides the hosted providers when the user names none", {}, () =>
    Effect.gen(function* () {
      expect(yield* disabled()).toEqual(["opencode", "opencode-go"])
    }),
  )

  scenario("keeps a provider the user disabled themselves", { project: { disabled_providers: ["openai"] } }, () =>
    Effect.gen(function* () {
      expect(yield* disabled()).toEqual(["openai", "opencode", "opencode-go"])
    }),
  )

  scenario("does not repeat an id the user already disabled", { global: { disabled_providers: ["opencode"] } }, () =>
    Effect.gen(function* () {
      expect(yield* disabled()).toEqual(["opencode", "opencode-go"])
    }),
  )
})
