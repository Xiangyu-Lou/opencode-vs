import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Effect } from "effect"
import { VsWorkerSkills } from "../src/skills"

function entry(input: Partial<VsWorkerSkills.Raw> & { id: string }): VsWorkerSkills.Raw {
  return {
    id: input.id,
    defaultEnabled: input.defaultEnabled ?? true,
    description: input.description,
    files: input.files ?? [
      { path: "SKILL.md", encoding: "utf8", executable: false, data: `---\nname: ${input.id}\n---\n` },
    ],
  }
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

const roots: string[] = []
async function tmproot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsworker-skills-"))
  roots.push(dir)
  return path.join(dir, "skills")
}

const kill = process.env[VsWorkerSkills.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerSkills.DISABLE_ENV]
})
afterEach(async () => {
  if (kill === undefined) delete process.env[VsWorkerSkills.DISABLE_ENV]
  else process.env[VsWorkerSkills.DISABLE_ENV] = kill
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe("select", () => {
  test("takes the manifest default", () => {
    const bundle = [entry({ id: "on" }), entry({ id: "off", defaultEnabled: false })]
    expect(VsWorkerSkills.select({ bundle }).map((item) => item.id)).toEqual(["on"])
  })

  test("user config wins in both directions", () => {
    const bundle = [entry({ id: "on" }), entry({ id: "off", defaultEnabled: false })]
    const selected = VsWorkerSkills.select({ bundle, user: { on: false, off: true } })
    expect(selected.map((item) => item.id)).toEqual(["off"])
  })

  test("selects nothing when disabled", () => {
    const bundle = [entry({ id: "on" })]
    expect(VsWorkerSkills.select({ bundle, disabled: true })).toEqual([])
    process.env[VsWorkerSkills.DISABLE_ENV] = "1"
    expect(VsWorkerSkills.select({ bundle })).toEqual([])
  })
})

describe("materialize", () => {
  test("writes text, binary, and executable files", async () => {
    const root = await tmproot()
    const bundle = [
      entry({
        id: "probe",
        files: [
          { path: "SKILL.md", encoding: "utf8", executable: false, data: "# probe\n" },
          { path: "references/blob.bin", encoding: "base64", executable: false, data: "AAECYmluYXJ5//4=" },
          { path: "scripts/run.sh", encoding: "utf8", executable: true, data: "#!/bin/sh\necho hi\n" },
        ],
      }),
    ]
    await VsWorkerSkills.materialize({ root, hash: "h1", bundle })

    expect(await fs.readFile(VsWorkerSkills.location(root, "probe"), "utf8")).toBe("# probe\n")
    const blob = await fs.readFile(path.join(root, "probe", "references", "blob.bin"))
    expect([...blob]).toEqual([0, 1, 2, 98, 105, 110, 97, 114, 121, 255, 254])
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(root, "probe", "scripts", "run.sh"))
      expect(stat.mode & 0o777).toBe(0o755)
    }
    expect(await VsWorkerSkills.current(root, "h1")).toBe(true)
  })

  test("a second run with the same hash leaves the files alone", async () => {
    const root = await tmproot()
    const bundle = [entry({ id: "probe" })]
    await VsWorkerSkills.materialize({ root, hash: "h1", bundle })
    const before = await fs.stat(VsWorkerSkills.location(root, "probe"))
    await VsWorkerSkills.materialize({ root, hash: "h1", bundle })
    const after = await fs.stat(VsWorkerSkills.location(root, "probe"))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test("a new hash replaces the tree and drops removed skills", async () => {
    const root = await tmproot()
    await VsWorkerSkills.materialize({ root, hash: "h1", bundle: [entry({ id: "old" }), entry({ id: "kept" })] })
    await VsWorkerSkills.materialize({ root, hash: "h2", bundle: [entry({ id: "kept" })] })
    expect(await exists(VsWorkerSkills.dir(root, "old"))).toBe(false)
    expect(await exists(VsWorkerSkills.location(root, "kept"))).toBe(true)
    expect(await VsWorkerSkills.current(root, "h1")).toBe(false)
  })

  test("recovers when the root is an ordinary file", async () => {
    const root = await tmproot()
    await fs.mkdir(path.dirname(root), { recursive: true })
    await fs.writeFile(root, "not a directory")
    await VsWorkerSkills.materialize({ root, hash: "h1", bundle: [entry({ id: "probe" })] })
    expect(await exists(VsWorkerSkills.location(root, "probe"))).toBe(true)
  })
})

describe("ensure", () => {
  test("returns the selected skills and writes them once", async () => {
    const root = await tmproot()
    const service = VsWorkerSkills.make({ root, hash: "h1", bundle: [entry({ id: "probe" })] })
    const first = await Effect.runPromise(service.ensure([entry({ id: "probe" })]))
    expect(first).toEqual([
      { id: "probe", dir: VsWorkerSkills.dir(root, "probe"), location: VsWorkerSkills.location(root, "probe") },
    ])

    // A second call must not rewrite the tree, even after the stamp is removed: materialization is memoized.
    await fs.rm(path.join(root, VsWorkerSkills.STAMP))
    await Effect.runPromise(service.ensure([entry({ id: "probe" })]))
    expect(await exists(path.join(root, VsWorkerSkills.STAMP))).toBe(false)
  })

  test("never touches disk when nothing is selected", async () => {
    const root = await tmproot()
    const service = VsWorkerSkills.make({ root, hash: "h1", bundle: [entry({ id: "probe" })] })
    expect(await Effect.runPromise(service.ensure([]))).toEqual([])
    expect(await exists(root)).toBe(false)
  })

  test("degrades to no skills when the cache cannot be written", async () => {
    const root = await tmproot()
    const parent = path.dirname(root)
    await fs.chmod(parent, 0o500)
    const service = VsWorkerSkills.make({ root, hash: "h1", bundle: [entry({ id: "probe" })] })
    try {
      expect(await Effect.runPromise(service.ensure([entry({ id: "probe" })]))).toEqual([])
    } finally {
      await fs.chmod(parent, 0o700)
    }
  })
})

describe("describe", () => {
  test("reports every state", () => {
    const bundle = [entry({ id: "on" }), entry({ id: "off", defaultEnabled: false }), entry({ id: "shadowed" })]
    const rows = VsWorkerSkills.describe({
      bundle,
      root: "/cache",
      user: { on: true },
      shadowed: new Map([["shadowed", "/project/.opencode/skill/shadowed/SKILL.md"]]),
    })
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["on", "enabled"],
      ["off", "disabled-by-default"],
      ["shadowed", "shadowed"],
    ])
    expect(rows[2]!.shadowedBy).toBe("/project/.opencode/skill/shadowed/SKILL.md")
  })

  test("separates a user disable from a manifest default", () => {
    const bundle = [entry({ id: "a" }), entry({ id: "b", defaultEnabled: false })]
    const rows = VsWorkerSkills.describe({ bundle, root: "/cache", user: { a: false } })
    expect(rows.map((row) => row.state)).toEqual(["disabled-by-config", "disabled-by-default"])
  })

  test("reports killed for everything when the kill switch is set", () => {
    process.env[VsWorkerSkills.DISABLE_ENV] = "1"
    const rows = VsWorkerSkills.describe({ bundle: [entry({ id: "a" })], root: "/cache" })
    expect(rows[0]).toMatchObject({ state: "killed" })
  })
})
