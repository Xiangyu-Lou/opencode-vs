import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { VsWorkerConfigEdit } from "@/vsworker/config-edit"

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vsworker-config-edit-"))
}

describe("VsWorkerConfigEdit.togglePath", () => {
  test("mcp uses the stock enabled key", () => {
    expect(VsWorkerConfigEdit.togglePath("mcp", "docs", {})).toEqual(["mcp", "docs", "enabled"])
  })

  test("skills live under vsworker.skills", () => {
    expect(VsWorkerConfigEdit.togglePath("skills", "report", {})).toEqual(["vsworker", "skills", "report"])
  })

  test("a plugin with no entry is written as a bare boolean", () => {
    expect(VsWorkerConfigEdit.togglePath("plugins", "hello", {})).toEqual(["vsworker", "plugins", "hello"])
  })

  test("a plugin with an options object keeps it", () => {
    const parsed = { vsworker: { plugins: { hello: { options: { url: "http://x" } } } } }
    expect(VsWorkerConfigEdit.togglePath("plugins", "hello", parsed)).toEqual([
      "vsworker",
      "plugins",
      "hello",
      "enabled",
    ])
  })
})

describe("VsWorkerConfigEdit.patch", () => {
  test("creates a missing file", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.json")
    const result = await VsWorkerConfigEdit.patch({ file, edits: [{ path: ["username"], value: "lou" }] })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ username: "lou" })
    expect(result.revision).not.toBe("")
  })

  test("preserves comments and unrelated keys", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.jsonc")
    await fs.writeFile(file, '{\n  // keep me\n  "username": "lou",\n  "mcp": { "docs": { "enabled": true } }\n}\n')
    await VsWorkerConfigEdit.toggle({ kind: "mcp", id: "docs", enabled: false, file })
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// keep me")
    expect(text).toContain('"username": "lou"')
    expect(text).toContain('"enabled": false')
  })

  test("refuses a write pinned to a stale revision", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.json")
    await fs.writeFile(file, '{"username":"lou"}')
    const stale = VsWorkerConfigEdit.revision('{"username":"someone else"}')
    await expect(
      VsWorkerConfigEdit.patch({ file, expectedRevision: stale, edits: [{ path: ["username"], value: "x" }] }),
    ).rejects.toBeInstanceOf(VsWorkerConfigEdit.ConflictError)
    expect(await fs.readFile(file, "utf8")).toBe('{"username":"lou"}')
  })

  test("accepts a write pinned to the current revision", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.json")
    await fs.writeFile(file, '{"username":"lou"}')
    const current = await VsWorkerConfigEdit.read(file)
    const next = await VsWorkerConfigEdit.patch({
      file,
      expectedRevision: current.revision,
      edits: [{ path: ["username"], value: "x" }],
    })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ username: "x" })
    expect(next.revision).not.toBe(current.revision)
  })

  test("an empty expected revision matches a file that does not exist", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.json")
    await VsWorkerConfigEdit.patch({ file, expectedRevision: "", edits: [{ path: ["username"], value: "lou" }] })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ username: "lou" })
  })

  test("undefined removes a key", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.json")
    await fs.writeFile(file, '{"mcp":{"a":{"type":"local","command":["x"]},"b":{"type":"local","command":["y"]}}}')
    await VsWorkerConfigEdit.patch({ file, edits: [{ path: ["mcp", "a"], value: undefined }] })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ mcp: { b: { type: "local", command: ["y"] } } })
  })

  test("insert appends to an array", async () => {
    const dir = await tmp()
    const file = path.join(dir, "opencode.json")
    await fs.writeFile(file, '{"plugin":["a"]}')
    await VsWorkerConfigEdit.patch({ file, edits: [{ path: ["plugin", 1], value: "b", insert: true }] })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ plugin: ["a", "b"] })
  })
})

describe("VsWorkerConfigEdit.resolveFile", () => {
  test("prefers an existing file over the fallback", async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, "opencode.jsonc"), "{}")
    expect(await VsWorkerConfigEdit.resolveFile(dir, "global")).toBe(path.join(dir, "opencode.jsonc"))
  })

  test("falls back to opencode.json", async () => {
    const dir = await tmp()
    expect(await VsWorkerConfigEdit.resolveFile(dir, "project")).toBe(path.join(dir, "opencode.json"))
  })

  test("project scope also looks inside .opencode", async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(dir, ".opencode", "opencode.json"), "{}")
    expect(await VsWorkerConfigEdit.resolveFile(dir, "project")).toBe(path.join(dir, ".opencode", "opencode.json"))
  })

  test("global scope never looks inside .opencode", async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
    await fs.writeFile(path.join(dir, ".opencode", "opencode.json"), "{}")
    expect(await VsWorkerConfigEdit.resolveFile(dir, "global")).toBe(path.join(dir, "opencode.json"))
  })
})
