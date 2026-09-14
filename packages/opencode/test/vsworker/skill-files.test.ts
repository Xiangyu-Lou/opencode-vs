import { describe, expect, test } from "bun:test"
import fs from "fs/promises"

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )
import os from "os"
import path from "path"
import { VsWorkerSkillFiles } from "@/vsworker/skill-files"

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vsworker-skill-files-"))
}

describe("VsWorkerSkillFiles.validName", () => {
  test.each([
    ["report-review", true],
    ["pg17", true],
    ["a", true],
    ["Report", false],
    ["report_review", false],
    ["report--review", false],
    ["-report", false],
    ["report-", false],
    ["", false],
    [" report", false],
    ["../escape", false],
    ["a/b", false],
    ["a\\b", false],
    [".", false],
    ["..", false],
  ])("%s -> %s", (name, expected) => {
    expect(VsWorkerSkillFiles.validName(name)).toBe(expected)
  })

  test("rejects a name longer than the limit", () => {
    expect(VsWorkerSkillFiles.validName("a".repeat(VsWorkerSkillFiles.MAX_NAME + 1))).toBe(false)
    expect(VsWorkerSkillFiles.validName("a".repeat(VsWorkerSkillFiles.MAX_NAME))).toBe(true)
  })
})

describe("VsWorkerSkillFiles.render", () => {
  test("writes frontmatter the skill loader can read back", () => {
    const text = VsWorkerSkillFiles.render({ name: "demo", description: "Does a thing", content: "# Body\n" })
    expect(text.startsWith('---\nname: "demo"\ndescription: "Does a thing"\n---\n')).toBe(true)
    expect(text.endsWith("# Body\n")).toBe(true)
  })

  test("escapes quotes in the description", () => {
    const text = VsWorkerSkillFiles.render({ name: "demo", description: 'say "hi"', content: "x" })
    expect(text).toContain('description: "say \\"hi\\""')
  })

  test("omits an absent description", () => {
    expect(VsWorkerSkillFiles.render({ name: "demo", content: "x" })).not.toContain("description")
  })
})

describe("VsWorkerSkillFiles round trip", () => {
  test("create then read", async () => {
    const root = await tmp()
    const file = await VsWorkerSkillFiles.create({ root, name: "demo", description: "d", content: "hello\n" })
    expect(file).toBe(path.join(root, "demo", "SKILL.md"))
    const parsed = await VsWorkerSkillFiles.read(file)
    expect(parsed).toMatchObject({ name: "demo", description: "d" })
    expect(parsed.content.trim()).toBe("hello")
  })

  test("create uses the template when no content is given", async () => {
    const root = await tmp()
    const file = await VsWorkerSkillFiles.create({ root, name: "demo" })
    expect(await fs.readFile(file, "utf8")).toContain("## When to use")
  })

  test("create refuses to overwrite", async () => {
    const root = await tmp()
    await VsWorkerSkillFiles.create({ root, name: "demo", content: "a" })
    await expect(VsWorkerSkillFiles.create({ root, name: "demo", content: "b" })).rejects.toBeInstanceOf(
      VsWorkerSkillFiles.ExistsError,
    )
  })

  test("update rewrites an existing skill", async () => {
    const root = await tmp()
    await VsWorkerSkillFiles.create({ root, name: "demo", description: "old", content: "a" })
    const file = await VsWorkerSkillFiles.update({ root, name: "demo", description: "new", content: "b\n" })
    const parsed = await VsWorkerSkillFiles.read(file)
    expect(parsed.description).toBe("new")
    expect(parsed.content.trim()).toBe("b")
  })

  test("update refuses a skill that does not exist", async () => {
    const root = await tmp()
    await expect(VsWorkerSkillFiles.update({ root, name: "demo", content: "b" })).rejects.toBeInstanceOf(
      VsWorkerSkillFiles.MissingError,
    )
  })

  test("remove deletes the directory", async () => {
    const root = await tmp()
    await VsWorkerSkillFiles.create({ root, name: "demo", content: "a" })
    await VsWorkerSkillFiles.remove({ root, name: "demo" })
    expect(await exists(path.join(root, "demo"))).toBe(false)
  })

  test("a traversing name never escapes the root", async () => {
    const root = await tmp()
    await expect(VsWorkerSkillFiles.create({ root, name: "../escape", content: "a" })).rejects.toBeInstanceOf(
      VsWorkerSkillFiles.InvalidNameError,
    )
    expect(await exists(path.join(path.dirname(root), "escape"))).toBe(false)
  })
})
