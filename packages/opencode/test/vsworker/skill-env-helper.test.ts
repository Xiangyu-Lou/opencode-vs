import { describe, expect, test } from "bun:test"
import { VsWorkerEnv } from "@vsworker/bundle/env"
import { VsWorkerSkills } from "@vsworker/bundle/skills"
import { VsWorkerSkillEnv } from "@/vsworker/skill-env"

// Whatever this build bundles; the ids come from vsworker/bundle.jsonc and change with the manifest.
const withEnv = VsWorkerSkills.bundle.find((entry) => entry.files.some((file) => file.path === VsWorkerEnv.FILE))

describe("VsWorkerSkillEnv.defaults", () => {
  test("reads the packaged env.json out of the build constant", () => {
    if (!withEnv) return
    const packaged = VsWorkerSkillEnv.defaults(withEnv.id)
    const file = withEnv.files.find((item) => item.path === VsWorkerEnv.FILE)!
    expect(packaged.present).toBe(true)
    expect(packaged.problems).toEqual([])
    expect(packaged.values).toEqual(VsWorkerEnv.parse(file.data, "probe").values)
  })

  test("a skill this build does not bundle has no packaged file", () => {
    expect(VsWorkerSkillEnv.defaults("vsworker-missing")).toEqual({ present: false, values: {}, problems: [] })
  })
})

describe("VsWorkerSkillEnv.overrides", () => {
  test("coerces every value env.json would accept and drops the rest", () => {
    const map = VsWorkerSkillEnv.overrides({
      vsworker: { skill_env: { a: { URL: "http://x", COUNT: 3, ON: true, OFF: false, EMPTY: null } } },
    })
    expect(map.get("a")).toEqual({ URL: "http://x", COUNT: "3", ON: "1", OFF: "0", EMPTY: "" })
  })

  test("is empty when the config says nothing", () => {
    expect(VsWorkerSkillEnv.overrides({}).size).toBe(0)
    expect(VsWorkerSkillEnv.overrides({ vsworker: { skills: { a: false } } }).size).toBe(0)
  })
})

describe("VsWorkerSkillEnv.scoped", () => {
  test("reads one file's overrides for one skill", () => {
    const parsed = { vsworker: { skill_env: { a: { X: "1" }, b: { Y: "2" } } } }
    expect(VsWorkerSkillEnv.scoped(parsed, "a")).toEqual({ X: "1" })
    expect(VsWorkerSkillEnv.scoped(parsed, "missing")).toBeUndefined()
    expect(VsWorkerSkillEnv.scoped({}, "a")).toBeUndefined()
    expect(VsWorkerSkillEnv.scoped({ vsworker: { skill_env: { a: "nonsense" } } }, "a")).toBeUndefined()
  })
})

describe("VsWorkerSkillEnv.invalidKeys", () => {
  test("names the keys no shell could export", () => {
    expect(VsWorkerSkillEnv.invalidKeys({ GOOD: "1", _ALSO_GOOD: "1" })).toEqual([])
    expect(VsWorkerSkillEnv.invalidKeys({ "not a name": "1", "1LEADING": "2" })).toEqual(["not a name", "1LEADING"])
  })
})
