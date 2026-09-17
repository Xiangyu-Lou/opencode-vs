import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { VsWorkerEnv } from "../src/env"

const roots: string[] = []
afterEach(async () => {
  VsWorkerEnv.forget()
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

async function skillDir(contents?: string, name = "skill") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsworker-env-"))
  roots.push(root)
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  if (contents !== undefined) await fs.writeFile(path.join(dir, VsWorkerEnv.FILE), contents)
  return { root, dir }
}

describe("parse", () => {
  test("coerces every value the platform accepts", () => {
    const parsed = VsWorkerEnv.parse(
      JSON.stringify({ TEXT: "x", COUNT: 3, RATIO: 0.69, ON: true, OFF: false, EMPTY: null, _NOTE: "kept" }),
      "env.json",
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.values).toEqual({
      TEXT: "x",
      COUNT: "3",
      RATIO: "0.69",
      ON: "1",
      OFF: "0",
      EMPTY: "",
      _NOTE: "kept",
    })
  })

  test("tolerates a byte order mark", () => {
    expect(VsWorkerEnv.parse('﻿{"A":"1"}', "env.json").values).toEqual({ A: "1" })
  })

  test("rejects a nested value and exports nothing", () => {
    const parsed = VsWorkerEnv.parse(JSON.stringify({ GOOD: "1", BAD: { nested: true } }), "env.json")
    expect(parsed.values).toEqual({})
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]).toContain("BAD")
  })

  test("rejects an array top level, a bad key, and invalid JSON", () => {
    expect(VsWorkerEnv.parse("[1,2]", "env.json").problems[0]).toContain("flat JSON object")
    expect(VsWorkerEnv.parse(JSON.stringify({ "2BAD": "x" }), "env.json").problems[0]).toContain("2BAD")
    expect(VsWorkerEnv.parse("not json", "env.json").problems[0]).toContain("not valid JSON")
  })
})

describe("load", () => {
  test("reports a missing file as absent, not as a problem", async () => {
    const { dir } = await skillDir()
    const loaded = await VsWorkerEnv.load({ dir })
    expect(loaded).toEqual({ present: false, values: {}, problems: [] })
  })

  test("substitutes placeholders before parsing", async () => {
    const { dir } = await skillDir(JSON.stringify({ TOKEN: "{env:PROBE}" }))
    const loaded = await VsWorkerEnv.load({
      dir,
      substitute: async (text) => text.replaceAll("{env:PROBE}", "resolved"),
    })
    expect(loaded.values).toEqual({ TOKEN: "resolved" })
  })

  test("turns a failing substitution into a problem instead of throwing", async () => {
    const { dir } = await skillDir(JSON.stringify({ TOKEN: "{file:missing}" }))
    const loaded = await VsWorkerEnv.load({
      dir,
      substitute: async () => {
        throw new Error("bad file reference")
      },
    })
    expect(loaded.values).toEqual({})
    expect(loaded.problems[0]).toContain("bad file reference")
  })

  test("caches by mtime, and reports problems only on a fresh parse", async () => {
    const { dir } = await skillDir(JSON.stringify({ BAD: [] }))
    expect((await VsWorkerEnv.load({ dir })).problems).toHaveLength(1)
    expect((await VsWorkerEnv.load({ dir })).problems).toEqual([])

    const file = path.join(dir, VsWorkerEnv.FILE)
    await fs.writeFile(file, JSON.stringify({ FIXED: "yes" }))
    const later = new Date(Date.now() + 2000)
    await fs.utimes(file, later, later)
    expect((await VsWorkerEnv.load({ dir })).values).toEqual({ FIXED: "yes" })
  })

  test("a raw read does not serve its placeholders to a substituted one", async () => {
    const { dir } = await skillDir(JSON.stringify({ TOKEN: "{env:PROBE}" }))
    expect((await VsWorkerEnv.load({ dir })).values).toEqual({ TOKEN: "{env:PROBE}" })
    const loaded = await VsWorkerEnv.load({
      dir,
      substitute: async (text) => text.replaceAll("{env:PROBE}", "resolved"),
    })
    expect(loaded.values).toEqual({ TOKEN: "resolved" })
  })
})

describe("tokens", () => {
  test("splits on shell separators and keeps quoted paths whole", () => {
    expect(VsWorkerEnv.tokens(`cd /a/b && sh "with space/run.sh"`)).toEqual(["cd", "/a/b", "sh", "with space/run.sh"])
  })

  test("yields both halves of a KEY=path assignment", () => {
    expect(VsWorkerEnv.tokens("WIR_ENV_FILE=/tmp/x.json python3 run.py")).toEqual([
      "WIR_ENV_FILE=/tmp/x.json",
      "/tmp/x.json",
      "python3",
      "run.py",
    ])
  })
})

describe("matches", () => {
  const dir = path.resolve("/tmp/cache/skills/probe")

  test("matches a cwd inside the skill directory", () => {
    expect(VsWorkerEnv.matches({ command: "printenv A", cwd: path.join(dir, "scripts"), dir })).toBe(true)
  })

  test("matches an absolute path in the command", () => {
    expect(VsWorkerEnv.matches({ command: `sh ${dir}/scripts/run.sh`, cwd: "/project", dir })).toBe(true)
  })

  test("matches a relative path from the working directory", () => {
    expect(
      VsWorkerEnv.matches({ command: "sh skills/probe/scripts/run.sh", cwd: path.resolve("/tmp/cache"), dir }),
    ).toBe(true)
  })

  test("matches a ~ path when a home directory is known", () => {
    const home = path.resolve("/home/u")
    const inHome = path.join(home, ".config/vsworker/skills/probe")
    expect(
      VsWorkerEnv.matches({ command: "sh ~/.config/vsworker/skills/probe/run.sh", cwd: "/x", dir: inHome, home }),
    ).toBe(true)
  })

  test("does not match an unrelated command or a bare name", () => {
    expect(VsWorkerEnv.matches({ command: "echo $A", cwd: "/project", dir })).toBe(false)
    expect(VsWorkerEnv.matches({ command: "probe --help", cwd: path.dirname(dir), dir })).toBe(false)
  })

  test("does not match a sibling directory that shares a prefix", () => {
    expect(VsWorkerEnv.matches({ command: `sh ${dir}-other/run.sh`, cwd: "/project", dir })).toBe(false)
  })
})

describe("resolve", () => {
  test("merges matching skills in name order and skips built-ins", async () => {
    const { root } = await skillDir(undefined, "unused")
    const first = path.join(root, "alpha")
    const second = path.join(root, "beta")
    await fs.mkdir(first, { recursive: true })
    await fs.mkdir(second, { recursive: true })
    await fs.writeFile(path.join(first, VsWorkerEnv.FILE), JSON.stringify({ SHARED: "alpha", ONLY_A: "a" }))
    await fs.writeFile(path.join(second, VsWorkerEnv.FILE), JSON.stringify({ SHARED: "beta" }))

    const resolved = await VsWorkerEnv.resolve({
      command: `sh ${first}/run.sh ${second}/run.sh`,
      cwd: root,
      skills: [
        { name: "beta", location: path.join(second, "SKILL.md") },
        { name: "alpha", location: path.join(first, "SKILL.md") },
        { name: "builtin", location: "<built-in>" },
      ],
    })
    expect(resolved.env).toEqual({ SHARED: "beta", ONLY_A: "a" })
    expect(resolved.warnings).toEqual([])
  })

  test("returns nothing for a command that names no skill", async () => {
    const { dir } = await skillDir(JSON.stringify({ A: "1" }))
    const resolved = await VsWorkerEnv.resolve({
      command: "echo hi",
      cwd: "/project",
      skills: [{ name: "probe", location: path.join(dir, "SKILL.md") }],
    })
    expect(resolved.env).toEqual({})
  })

  test("warns once about an invalid file and still returns an environment", async () => {
    const { dir } = await skillDir("not json")
    const input = {
      command: `sh ${dir}/run.sh`,
      cwd: "/project",
      skills: [{ name: "probe", location: path.join(dir, "SKILL.md") }],
    }
    expect((await VsWorkerEnv.resolve(input)).warnings).toHaveLength(1)
    expect((await VsWorkerEnv.resolve(input)).warnings).toEqual([])
  })

  test("a config override wins over the file, key by key", async () => {
    const { dir } = await skillDir(JSON.stringify({ KEPT: "file", REPLACED: "file" }))
    const resolved = await VsWorkerEnv.resolve({
      command: `sh ${dir}/run.sh`,
      cwd: "/project",
      skills: [{ name: "probe", location: path.join(dir, "SKILL.md") }],
      overrides: new Map([["probe", { REPLACED: "config", ADDED: "config" }]]),
    })
    expect(resolved.env).toEqual({ KEPT: "file", REPLACED: "config", ADDED: "config" })
  })

  test("a config override reaches a skill that ships no env.json", async () => {
    const { dir } = await skillDir()
    const resolved = await VsWorkerEnv.resolve({
      command: `sh ${dir}/run.sh`,
      cwd: "/project",
      skills: [{ name: "probe", location: path.join(dir, "SKILL.md") }],
      overrides: new Map([["probe", { ADDED: "config" }]]),
    })
    expect(resolved.env).toEqual({ ADDED: "config" })
  })

  test("an override for another skill, or for a command that matches nothing, stays out", async () => {
    const { dir } = await skillDir(JSON.stringify({ A: "1" }))
    const overrides = new Map([["other", { ADDED: "config" }]])
    const skills = [{ name: "probe", location: path.join(dir, "SKILL.md") }]
    expect((await VsWorkerEnv.resolve({ command: `sh ${dir}/run.sh`, cwd: "/p", skills, overrides })).env).toEqual({
      A: "1",
    })
    expect(
      (
        await VsWorkerEnv.resolve({
          command: "echo hi",
          cwd: "/p",
          skills,
          overrides: new Map([["probe", { ADDED: "config" }]]),
        })
      ).env,
    ).toEqual({})
  })

  test("an override key that is not an environment variable name is dropped with a warning", async () => {
    const { dir } = await skillDir(JSON.stringify({ A: "1" }))
    const resolved = await VsWorkerEnv.resolve({
      command: `sh ${dir}/run.sh`,
      cwd: "/project",
      skills: [{ name: "probe", location: path.join(dir, "SKILL.md") }],
      overrides: new Map([["probe", { "not a name": "x", GOOD: "y" }]]),
    })
    expect(resolved.env).toEqual({ A: "1", GOOD: "y" })
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain("not a name")
  })
})

describe("scalar", () => {
  test("coerces the same values env.json accepts", () => {
    expect(VsWorkerEnv.scalar("text")).toBe("text")
    expect(VsWorkerEnv.scalar(true)).toBe("1")
    expect(VsWorkerEnv.scalar(false)).toBe("0")
    expect(VsWorkerEnv.scalar(null)).toBe("")
    expect(VsWorkerEnv.scalar(12.5)).toBe("12.5")
    expect(VsWorkerEnv.scalar(Number.NaN)).toBeUndefined()
    expect(VsWorkerEnv.scalar({})).toBeUndefined()
    expect(VsWorkerEnv.scalar([])).toBeUndefined()
    expect(VsWorkerEnv.scalar(undefined)).toBeUndefined()
  })
})

describe("describe", () => {
  test("lists sorted key names, and nothing when there is no file", async () => {
    const { dir } = await skillDir(JSON.stringify({ B: "2", A: "1" }))
    expect(await VsWorkerEnv.describe(dir)).toEqual({ keys: ["A", "B"] })
    const empty = await skillDir()
    expect(await VsWorkerEnv.describe(empty.dir)).toBeUndefined()
  })
})
