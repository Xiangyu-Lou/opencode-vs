import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { configLayer, withTree } from "./tree"
import { testEffect } from "../lib/effect"

const layer = configLayer()
const it = testEffect(layer)
const tree = <A, E, R>(input: { global?: object; project?: object }, effect: Effect.Effect<A, E, R>) =>
  withTree({ ...input, layer }, effect)

describe("config.vsworker", () => {
  it.live("keeps the vsworker.plugins block through decoding", () =>
    tree(
      { project: { vsworker: { plugins: { a: false, b: { enabled: true, options: { url: "http://x" } } } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.plugins).toEqual({ a: false, b: { enabled: true, options: { url: "http://x" } } })
      }),
    ),
  )

  it.live("merges global and project overrides per plugin id", () =>
    tree(
      { global: { vsworker: { plugins: { a: false } } }, project: { vsworker: { plugins: { b: false } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.plugins).toEqual({ a: false, b: false })
      }),
    ),
  )

  it.live("lets project config override a global decision for the same plugin", () =>
    tree(
      { global: { vsworker: { plugins: { a: false } } }, project: { vsworker: { plugins: { a: true } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.plugins?.a).toBe(true)
      }),
    ),
  )

  it.live("keeps the vsworker.skills block through decoding", () =>
    tree(
      { project: { vsworker: { skills: { a: false, b: true } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.skills).toEqual({ a: false, b: true })
      }),
    ),
  )

  it.live("lets project config override a global decision for the same skill", () =>
    tree(
      { global: { vsworker: { skills: { a: false } } }, project: { vsworker: { skills: { a: true } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.skills?.a).toBe(true)
      }),
    ),
  )

  it.live("keeps the vsworker.skill_env block through decoding", () =>
    tree(
      { project: { vsworker: { skill_env: { a: { URL: "http://x", COUNT: 3, ON: true, EMPTY: null } } } } },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.skill_env?.a).toEqual({ URL: "http://x", COUNT: 3, ON: true, EMPTY: null })
      }),
    ),
  )

  // The reason skill_env is its own key rather than a widened vsworker.skills entry: the config merge is a deep
  // merge, so two objects combine per variable, while an object meeting a boolean would drop one of them.
  it.live("merges skill_env per variable and leaves the on/off decision alone", () =>
    tree(
      {
        global: { vsworker: { skills: { a: false }, skill_env: { a: { KEPT: "global", REPLACED: "global" } } } },
        project: { vsworker: { skill_env: { a: { REPLACED: "project", ADDED: "project" } } } },
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.vsworker?.skill_env?.a).toEqual({
          KEPT: "global",
          REPLACED: "project",
          ADDED: "project",
        })
        expect(config.vsworker?.skills?.a).toBe(false)
      }),
    ),
  )
})
