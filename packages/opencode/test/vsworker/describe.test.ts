import { describe, expect, test } from "bun:test"
import path from "path"
import { VsWorkerDescribe } from "@/vsworker/describe"

const roots = {
  globalDir: path.join("/home", "u", ".config", "opencode", "skills"),
  projectDir: path.join("/work", "proj", ".opencode", "skills"),
  home: path.join("/home", "u"),
  cache: path.join("/home", "u", ".cache", "opencode"),
}

describe("VsWorkerDescribe.placement", () => {
  test("a skill under the project directory is editable at project scope", () => {
    expect(VsWorkerDescribe.placement({ ...roots, location: path.join(roots.projectDir, "demo", "SKILL.md") })).toEqual(
      { origin: "project", scope: "project", editable: true },
    )
  })

  test("a skill under the global directory is editable at global scope", () => {
    expect(VsWorkerDescribe.placement({ ...roots, location: path.join(roots.globalDir, "demo", "SKILL.md") })).toEqual({
      origin: "global",
      scope: "global",
      editable: true,
    })
  })

  test("a claude code skill is external and read-only", () => {
    expect(
      VsWorkerDescribe.placement({ ...roots, location: path.join(roots.home, ".claude", "skills", "x", "SKILL.md") }),
    ).toEqual({ origin: "external", editable: false })
  })

  test("an agents skill is external and read-only", () => {
    expect(
      VsWorkerDescribe.placement({ ...roots, location: path.join(roots.home, ".agents", "skills", "x", "SKILL.md") }),
    ).toEqual({ origin: "external", editable: false })
  })

  test("a pulled url skill is read-only", () => {
    expect(
      VsWorkerDescribe.placement({ ...roots, location: path.join(roots.cache, "skills", "x", "SKILL.md") }),
    ).toEqual({ origin: "url", editable: false })
  })

  test("anything else is read-only", () => {
    expect(VsWorkerDescribe.placement({ ...roots, location: "/opt/team/skills/x/SKILL.md" })).toEqual({
      origin: "other",
      editable: false,
    })
  })

  test("a sibling directory with a shared prefix is not inside the root", () => {
    expect(VsWorkerDescribe.placement({ ...roots, location: `${roots.globalDir}-backup/demo/SKILL.md` })).toEqual({
      origin: "other",
      editable: false,
    })
  })

  test("project wins when both roots would match", () => {
    const nested = { ...roots, globalDir: path.join("/work", "proj") }
    expect(
      VsWorkerDescribe.placement({ ...nested, location: path.join(roots.projectDir, "demo", "SKILL.md") }),
    ).toEqual({ origin: "project", scope: "project", editable: true })
  })
})

describe("VsWorkerDescribe.pluginEnabled", () => {
  test("reads a bare boolean", () => {
    expect(VsWorkerDescribe.pluginEnabled({ vsworker: { plugins: { a: false } } }, "a")).toBe(false)
  })

  test("reads the object form", () => {
    expect(VsWorkerDescribe.pluginEnabled({ vsworker: { plugins: { a: { enabled: true } } } }, "a")).toBe(true)
  })

  test("returns undefined when the file says nothing", () => {
    expect(VsWorkerDescribe.pluginEnabled({ vsworker: { plugins: { a: { options: {} } } } }, "a")).toBeUndefined()
    expect(VsWorkerDescribe.pluginEnabled({}, "a")).toBeUndefined()
  })
})

describe("VsWorkerDescribe.skillDir", () => {
  test("project scope needs a project directory", () => {
    expect(VsWorkerDescribe.skillDir("project", { globalDir: "/g" })).toBeUndefined()
    expect(VsWorkerDescribe.skillDir("project", { globalDir: "/g", projectDir: "/p" })).toBe("/p")
    expect(VsWorkerDescribe.skillDir("global", { globalDir: "/g", projectDir: "/p" })).toBe("/g")
  })
})

describe("VsWorkerDescribe bundle lookups", () => {
  test("the hello entries this build bundles are recognised", () => {
    expect(VsWorkerDescribe.isBundledPlugin("hello")).toBe(true)
    expect(VsWorkerDescribe.isBundledSkill("hello")).toBe(true)
    expect(VsWorkerDescribe.isBundledPlugin("nope")).toBe(false)
    expect(VsWorkerDescribe.isBundledSkill("nope")).toBe(false)
    expect(VsWorkerDescribe.isBundledMcp("nope")).toBe(false)
  })

  test("the bundled hello plugin is off by default", () => {
    expect(VsWorkerDescribe.pluginDefault("hello")).toBe(false)
    expect(VsWorkerDescribe.pluginDefault("nope")).toBe(false)
  })
})
