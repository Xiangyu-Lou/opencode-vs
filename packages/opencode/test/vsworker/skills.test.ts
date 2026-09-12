import { afterEach, beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { VsWorkerSkills } from "@vsworker/bundle/skills"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// preload.ts disables bundled skills for every other suite; this one is about the bundle itself.
const kill = process.env[VsWorkerSkills.DISABLE_ENV]
const roots: string[] = []
beforeEach(() => {
  delete process.env[VsWorkerSkills.DISABLE_ENV]
})
afterEach(async () => {
  if (kill === undefined) delete process.env[VsWorkerSkills.DISABLE_ENV]
  else process.env[VsWorkerSkills.DISABLE_ENV] = kill
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function testRoot() {
  const dir = path.join(os.tmpdir(), "vsworker-skills-" + Math.random().toString(36).slice(2))
  roots.push(dir)
  return path.join(dir, "skills")
}

const body = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

function stub(input: { id?: string; defaultEnabled?: boolean } = {}): VsWorkerSkills.Raw {
  const id = input.id ?? "bundled"
  return {
    id,
    defaultEnabled: input.defaultEnabled ?? true,
    description: "bundled",
    files: [
      { path: "SKILL.md", encoding: "utf8", executable: false, data: body(id, `Bundled ${id} skill.`) },
      { path: "scripts/run.sh", encoding: "utf8", executable: true, data: "#!/bin/sh\necho hi\n" },
    ],
  }
}

// One layer per test: the bundle and the cache root a test injects are part of it.
function scenario<A, E>(
  name: string,
  input: {
    bundle: VsWorkerSkills.Raw[]
    config?: Partial<ConfigV1.Info>
    flags?: Parameters<typeof RuntimeFlags.layer>[0]
  },
  test: (input: { root: string; directory: string }) => Effect.Effect<A, E, Skill.Service>,
) {
  const root = testRoot()
  const bundled = VsWorkerSkills.layer({ root, hash: "test-hash", bundle: input.bundle })
  const skill = input.flags
    ? LayerNode.compile(Skill.node, [
        [VsWorkerSkills.node, bundled],
        [RuntimeFlags.node, RuntimeFlags.layer(input.flags)],
      ])
    : LayerNode.compile(Skill.node, [[VsWorkerSkills.node, bundled]])
  const layer = Layer.mergeAll(skill, LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer)
  testEffect(layer).live(name, () =>
    provideTmpdirInstance((directory) => test({ root, directory }), { git: true, config: input.config ?? {} }),
  )
}

const bundledSkills = () =>
  Skill.Service.use((skill) => skill.all()).pipe(
    Effect.map((list) => list.filter((item) => item.location !== "<built-in>")),
  )

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

describe("vsworker.skills", () => {
  scenario("materializes a bundled skill and hands it to the model", { bundle: [stub()] }, ({ root }) =>
    Effect.gen(function* () {
      const list = yield* bundledSkills()
      expect(list.map((item) => item.name)).toEqual(["bundled"])
      expect(list[0]!.location).toBe(VsWorkerSkills.location(root, "bundled"))
      expect(list[0]!.description).toBe("Bundled bundled skill.")

      const script = path.join(root, "bundled", "scripts", "run.sh")
      expect(yield* Effect.promise(() => exists(script))).toBe(true)
      if (process.platform !== "win32") {
        const mode = yield* Effect.promise(() => fs.stat(script).then((stat) => stat.mode & 0o777))
        expect(mode.toString(8)).toBe("755")
      }
    }),
  )

  scenario("adds the bundled directory to the allowlisted skill dirs", { bundle: [stub()] }, ({ root }) =>
    Effect.gen(function* () {
      const dirs = yield* Skill.Service.use((skill) => skill.dirs())
      expect(dirs).toContain(VsWorkerSkills.dir(root, "bundled"))
    }),
  )

  scenario(
    "skips a skill the user turned off, and never writes the cache",
    { bundle: [stub()], config: { vsworker: { skills: { bundled: false } } } },
    ({ root }) =>
      Effect.gen(function* () {
        expect(yield* bundledSkills()).toEqual([])
        expect(yield* Effect.promise(() => exists(root))).toBe(false)
      }),
  )

  scenario(
    "keeps a defaultEnabled false skill out until it is turned on",
    { bundle: [stub({ defaultEnabled: false })] },
    () =>
      Effect.gen(function* () {
        expect(yield* bundledSkills()).toEqual([])
      }),
  )

  scenario(
    "loads a defaultEnabled false skill once config turns it on",
    { bundle: [stub({ defaultEnabled: false })], config: { vsworker: { skills: { bundled: true } } } },
    () =>
      Effect.gen(function* () {
        expect((yield* bundledSkills()).map((item) => item.name)).toEqual(["bundled"])
      }),
  )

  scenario("lets a skill of the same name on disk win", { bundle: [stub()] }, ({ root, directory }) =>
    Effect.gen(function* () {
      const instance = yield* Skill.Service
      const onDisk = path.join(directory, ".opencode", "skill", "bundled", "SKILL.md")
      yield* Effect.promise(() => fs.mkdir(path.dirname(onDisk), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(onDisk, body("bundled", "The project's own version.")))

      const hit = yield* instance.get("bundled")
      expect(hit?.location).toBe(onDisk)
      expect(hit?.description).toBe("The project's own version.")
      // The bundled copy is still materialized and still allowlisted, it just lost the name.
      expect(yield* instance.dirs()).toContain(VsWorkerSkills.dir(root, "bundled"))
    }),
  )

  scenario("loads nothing when the kill switch is set", { bundle: [stub()] }, ({ root }) =>
    Effect.gen(function* () {
      process.env[VsWorkerSkills.DISABLE_ENV] = "1"
      expect(yield* bundledSkills()).toEqual([])
      expect(yield* Effect.promise(() => exists(root))).toBe(false)
    }),
  )

  scenario("loads nothing under OPENCODE_PURE", { bundle: [stub()], flags: { pure: true } }, ({ root }) =>
    Effect.gen(function* () {
      expect(yield* bundledSkills()).toEqual([])
      expect(yield* Effect.promise(() => exists(root))).toBe(false)
    }),
  )
})
