import { afterEach, beforeEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { VsWorkerEnv } from "@vsworker/bundle/env"
import { VsWorkerSkills } from "@vsworker/bundle/skills"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import { ShellTool } from "@/tool/shell"
import { SkillTool } from "@/tool/skill"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// preload.ts disables bundled skills for every other suite; this one is about what they carry.
const kill = process.env[VsWorkerSkills.DISABLE_ENV]
const roots: string[] = []
beforeEach(() => {
  delete process.env[VsWorkerSkills.DISABLE_ENV]
  VsWorkerEnv.forget()
})
afterEach(async () => {
  if (kill === undefined) delete process.env[VsWorkerSkills.DISABLE_ENV]
  else process.env[VsWorkerSkills.DISABLE_ENV] = kill
  VsWorkerEnv.forget()
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function testRoot() {
  const dir = path.join(os.tmpdir(), "vsworker-skill-env-" + Math.random().toString(36).slice(2))
  roots.push(dir)
  return path.join(dir, "skills")
}

const frontmatter = (name: string) => `---\nname: ${name}\ndescription: Bundled ${name} skill.\n---\n\n# ${name}\n`

// Prints both variables in a shape that is unambiguous when one of them is unset.
const RUNNER = '#!/bin/sh\necho "PLATFORM=[$PLATFORM_BASE_URL] TOKEN=[$TOKEN]"\n'

function stub(env: string): VsWorkerSkills.Raw {
  return {
    id: "bundled",
    defaultEnabled: true,
    description: "bundled",
    files: [
      { path: "SKILL.md", encoding: "utf8", executable: false, data: frontmatter("bundled") },
      { path: "env.json", encoding: "utf8", executable: false, data: env },
      { path: "scripts/run.sh", encoding: "utf8", executable: true, data: RUNNER },
    ],
  }
}

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// The tool services ShellTool and SkillTool yield, with the bundled-skill source swapped for the test's own
// bundle. The replacement reaches Skill.node's copy of VsWorkerSkills.node too, because compile rewrites the
// whole tree.
function makeLayer(root: string, bundle: VsWorkerSkills.Raw[]) {
  return Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        Ripgrep.node,
        Skill.node,
      ]),
      [[VsWorkerSkills.node, VsWorkerSkills.layer({ root, hash: "test-hash", bundle })]],
    ),
    testInstanceStoreLayer,
  )
}

type Services =
  | (ReturnType<typeof makeLayer> extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

function scenario<A, E>(
  name: string,
  bundle: VsWorkerSkills.Raw[],
  test: (input: { root: string; directory: string }) => Effect.Effect<A, E, Services>,
) {
  const root = testRoot()
  testEffect(makeLayer(root, bundle)).live(name, () =>
    provideTmpdirInstance((directory) => test({ root, directory }), { git: true, config: {} }),
  )
}

const run = Effect.fn("SkillEnvTest.run")(function* (command: string, workdir?: string) {
  const tool = yield* ShellTool
  const bash = yield* tool.init()
  const result = yield* bash.execute({ command, ...(workdir ? { workdir } : {}) } as never, ctx)
  return result.output
})

// The runner is a POSIX shell script; Windows has no sh to run it with.
const posix = process.platform !== "win32"

describe("skill env.json", () => {
  scenario(
    "reaches a command that names the skill by absolute path",
    [stub('{"PLATFORM_BASE_URL":"http://x"}')],
    ({ root }) =>
      Effect.gen(function* () {
        if (!posix) return
        const output = yield* run(`sh ${path.join(root, "bundled", "scripts", "run.sh")}`)
        expect(output).toContain("PLATFORM=[http://x]")
      }),
  )

  scenario(
    "reaches a command whose working directory is the skill",
    [stub('{"PLATFORM_BASE_URL":"http://x"}')],
    ({ root }) =>
      Effect.gen(function* () {
        if (!posix) return
        const output = yield* run("sh scripts/run.sh", path.join(root, "bundled"))
        expect(output).toContain("PLATFORM=[http://x]")
      }),
  )

  scenario("reaches a skill the user dropped on disk, named by a relative path", [], ({ directory }) =>
    Effect.gen(function* () {
      if (!posix) return
      const dir = path.join(directory, ".opencode", "skill", "disk")
      yield* Effect.promise(() => fs.mkdir(path.join(dir, "scripts"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "SKILL.md"), frontmatter("disk")))
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "env.json"), '{"PLATFORM_BASE_URL":"http://disk"}'))
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "scripts", "run.sh"), RUNNER))

      const output = yield* run("sh .opencode/skill/disk/scripts/run.sh")
      expect(output).toContain("PLATFORM=[http://disk]")
    }),
  )

  scenario("stays out of a command that names no skill", [stub('{"PLATFORM_BASE_URL":"http://x"}')], () =>
    Effect.gen(function* () {
      if (!posix) return
      const output = yield* run(`sh -c 'echo "PLATFORM=[$PLATFORM_BASE_URL]"'`)
      expect(output).toContain("PLATFORM=[]")
    }),
  )

  scenario("lets the command run when env.json is malformed", [stub("not json")], ({ root }) =>
    Effect.gen(function* () {
      if (!posix) return
      const output = yield* run(`sh ${path.join(root, "bundled", "scripts", "run.sh")}`)
      expect(output).toContain("PLATFORM=[] TOKEN=[]")
    }),
  )

  scenario(
    "substitutes {env:VAR} against the real environment",
    [stub('{"TOKEN":"{env:VSWORKER_TEST_TOKEN}"}')],
    ({ root }) =>
      Effect.gen(function* () {
        if (!posix) return
        process.env.VSWORKER_TEST_TOKEN = "from-env"
        const output = yield* run(`sh ${path.join(root, "bundled", "scripts", "run.sh")}`).pipe(
          Effect.ensuring(Effect.sync(() => delete process.env.VSWORKER_TEST_TOKEN)),
        )
        expect(output).toContain("TOKEN=[from-env]")
      }),
  )

  scenario("tells the model the variable names but never the values", [stub('{"PLATFORM_BASE_URL":"http://x"}')], () =>
    Effect.gen(function* () {
      const tool = yield* SkillTool
      const definition = yield* tool.init()
      const result = yield* definition.execute({ name: "bundled" } as never, ctx)
      expect(result.output).toContain("PLATFORM_BASE_URL")
      expect(result.output).toContain("env.json")
      expect(result.output).not.toContain("http://x")
    }),
  )
})
