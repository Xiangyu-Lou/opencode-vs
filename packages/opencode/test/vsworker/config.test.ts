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
})
