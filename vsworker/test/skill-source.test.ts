import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import zlib from "zlib"
import { SkillSource } from "../script/skill-source"

// Fixtures are assembled byte by byte rather than with a zip library or the `zip` CLI, because every writer
// worth using refuses to produce the cases that matter here: zip.js rejects a `../` name as unsafe and a
// repeated name as a duplicate, and Info-ZIP will not write a symlink entry on a filesystem that has none.
// Writing the bytes also keeps the suite off a host tool that is absent from bare container images, which is
// the same reason the reader itself does not shell out to `unzip`.
type Fixture = {
  name: string
  data?: string | Uint8Array
  // Unix st_mode including the file-type bits. Omitted writes the entry MS-DOS style, carrying no mode at all,
  // which is what an archive made on Windows looks like.
  mode?: number
  // Leave the UTF-8 name flag clear even though the name needs it, to test the ambiguity guard.
  hideUtf8?: boolean
  // Stored instead of deflated.
  stored?: boolean
}

function bytes(data: string | Uint8Array | undefined) {
  if (data === undefined) return Buffer.alloc(0)
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
}

function archive(entries: Fixture[]) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const utf8 = !entry.hideUtf8 && name.some((byte) => byte > 0x7f)
    const raw = bytes(entry.data)
    const deflated = entry.stored ? raw : zlib.deflateRawSync(raw)
    const crc = zlib.crc32(raw)
    const flags = utf8 ? 0x0800 : 0
    const method = entry.stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.byteLength, 18)
    local.writeUInt32LE(raw.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    // "Version made by": high byte 3 is Unix, 0 is MS-DOS. Only the Unix form carries an st_mode.
    record.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(deflated.byteLength, 20)
    record.writeUInt32LE(raw.byteLength, 24)
    record.writeUInt16LE(name.byteLength, 28)
    record.writeUInt32LE(entry.mode === undefined ? 0 : ((entry.mode >>> 0) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)

    locals.push(local, name, deflated)
    central.push(record, name)
    offset += local.byteLength + name.byteLength + deflated.byteLength
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const dirs: string[] = []
async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsworker-source-"))
  dirs.push(dir)
  return dir
}

// A root with vsworker/-relative layout: skills/<id> or skills/<id>.zip.
async function root(build: (skills: string) => Promise<void>) {
  const dir = await tmpdir()
  const skills = path.join(dir, "skills")
  await fs.mkdir(skills, { recursive: true })
  await build(skills)
  return dir
}

async function writeArchive(skills: string, id: string, entries: Fixture[]) {
  await fs.writeFile(path.join(skills, `${id}.zip`), archive(entries))
}

async function writeTree(skills: string, id: string, files: Record<string, string | Uint8Array>) {
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(skills, id, ...name.split("/"))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes(data))
  }
}

async function read(dir: string, id: string, entry: SkillSource.Entry = { id }) {
  return SkillSource.read(SkillSource.locate(dir, entry), id)
}

async function paths(dir: string, id: string) {
  return (await read(dir, id)).files.map((file) => file.path)
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

const SKILL = "---\nname: demo\ndescription: demo\n---\n"

describe("locate", () => {
  test("finds a directory, an archive, or an explicit path", async () => {
    const dir = await root(async (skills) => {
      await writeTree(skills, "tree", { "SKILL.md": SKILL })
      await writeArchive(skills, "zipped", [{ name: "zipped/SKILL.md", data: SKILL }])
      await fs.writeFile(path.join(skills, "elsewhere.zip"), archive([{ name: "SKILL.md", data: SKILL }]))
    })
    expect(SkillSource.locate(dir, { id: "tree" })).toMatchObject({ kind: "directory", relative: "skills/tree" })
    expect(SkillSource.locate(dir, { id: "zipped" })).toMatchObject({
      kind: "archive",
      relative: "skills/zipped.zip",
    })
    expect(SkillSource.locate(dir, { id: "any", path: "skills/elsewhere.zip" })).toMatchObject({ kind: "archive" })
  })

  test("refuses to guess when a skill exists in both forms", async () => {
    const dir = await root(async (skills) => {
      await writeTree(skills, "both", { "SKILL.md": SKILL })
      await writeArchive(skills, "both", [{ name: "both/SKILL.md", data: SKILL }])
    })
    expect(() => SkillSource.locate(dir, { id: "both" })).toThrow(/both .*skills\/both and .*skills\/both\.zip/)
  })

  test("reports a skill that exists in neither form", async () => {
    const dir = await root(async () => {})
    expect(() => SkillSource.locate(dir, { id: "gone" })).toThrow(/none of .*skills\/gone, .*skills\/gone\.zip/)
  })

  test("requires the kind on disk to match the name", async () => {
    const dir = await root(async (skills) => {
      await fs.mkdir(path.join(skills, "odd.zip"))
    })
    expect(() => SkillSource.locate(dir, { id: "odd" })).toThrow(/is not a file/)
  })
})

describe("read", () => {
  test("an archive and the equivalent directory produce the same files and the same hash", async () => {
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe])
    const files = {
      "SKILL.md": SKILL,
      "env.json": '{ "A": "1" }\n',
      "references/notes.md": "notes\n",
      "scripts/run.py": "print(1)\n",
    }
    const dir = await root(async (skills) => {
      await writeTree(skills, "demo", { ...files, "scripts/blob.bin": binary })
      await writeArchive(skills, "zipped", [
        ...Object.entries(files).map(([name, data]) => ({ name: `demo/${name}`, data, mode: 0o100644 })),
        { name: "demo/scripts/blob.bin", data: binary, mode: 0o100644 },
      ])
    })

    const tree = await read(dir, "demo")
    const zipped = await read(dir, "zipped")
    expect(zipped.files).toEqual(tree.files)

    const encode = (contents: SkillSource.Contents) => contents.files.map(SkillSource.encode)
    expect(SkillSource.hashSkills([{ id: "x", files: encode(zipped) }])).toBe(
      SkillSource.hashSkills([{ id: "x", files: encode(tree) }]),
    )
  })

  test("carries text as utf8 and anything else as base64", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: "SKILL.md", data: SKILL },
        { name: "nul.bin", data: new Uint8Array([0x61, 0x00, 0x62]) },
        { name: "invalid.bin", data: new Uint8Array([0xff, 0xfe]) },
      ])
    })
    const encoded = (await read(dir, "demo")).files.map(SkillSource.encode)
    expect(encoded.map((file) => [file.path, file.encoding])).toEqual([
      ["SKILL.md", "utf8"],
      ["invalid.bin", "base64"],
      ["nul.bin", "base64"],
    ])
  })

  test("strips a single wrapping directory, and only that", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "wrapped", [
        { name: "wrapped/SKILL.md", data: SKILL },
        { name: "wrapped/scripts/run.py", data: "x" },
      ])
      await writeArchive(skills, "flat", [
        { name: "SKILL.md", data: SKILL },
        { name: "scripts/run.py", data: "x" },
      ])
      await writeArchive(skills, "single", [{ name: "SKILL.md", data: SKILL }])
      await writeArchive(skills, "two", [
        { name: "a/SKILL.md", data: SKILL },
        { name: "b/run.py", data: "x" },
      ])
    })
    expect(await paths(dir, "wrapped")).toEqual(["SKILL.md", "scripts/run.py"])
    expect(await paths(dir, "flat")).toEqual(["SKILL.md", "scripts/run.py"])
    expect(await paths(dir, "single")).toEqual(["SKILL.md"])
    expect(await paths(dir, "two")).toEqual(["a/SKILL.md", "b/run.py"])
  })

  test("warns when the wrapping directory is not the skill id", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: "demo (1)/SKILL.md", data: SKILL },
        { name: "demo (1)/run.py", data: "x" },
      ])
    })
    const contents = await read(dir, "demo")
    expect(contents.files.map((file) => file.path)).toEqual(["SKILL.md", "run.py"])
    expect(contents.warnings.join("\n")).toMatch(/wraps its files in demo \(1\)\//)
  })

  test("drops editor and interpreter droppings, and does so before stripping the prefix", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: "demo/SKILL.md", data: SKILL },
        { name: "demo/.DS_Store", data: "x" },
        { name: "demo/__pycache__/run.cpython-312.pyc", data: "x" },
        { name: "demo/scripts/run.pyo", data: "x" },
        { name: "demo/scripts/._run.py", data: "x" },
        { name: "__MACOSX/demo/._SKILL.md", data: "x" },
      ])
    })
    const contents = await read(dir, "demo")
    // __MACOSX/ is a second top-level segment. Dropped first, the wrapper is still unambiguous and stripped;
    // dropped after, every path would come out one level too deep.
    expect(contents.files.map((file) => file.path)).toEqual(["SKILL.md"])
    expect(contents.warnings.join("\n")).toMatch(/skipped 5 file\(s\)/)
  })

  test("round-trips a non-ASCII filename", async () => {
    const name = "references/查询改写.md"
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: `demo/${name}`, data: "内容\n" },
        { name: "demo/SKILL.md", data: SKILL },
      ])
    })
    const contents = await read(dir, "demo")
    expect(contents.files.map((file) => file.path)).toEqual(["SKILL.md", name])
    expect(contents.files[1].data.toString("utf8")).toBe("内容\n")
  })

  test("takes the executable bit from the archive, never from the host", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: "SKILL.md", data: SKILL, mode: 0o100644 },
        { name: "run.sh", data: "x", mode: 0o100755 },
        { name: "plain.txt", data: "x" },
      ])
    })
    const contents = await read(dir, "demo")
    expect(contents.files.map((file) => [file.path, file.executable])).toEqual([
      ["SKILL.md", false],
      // No mode bits at all, as a Windows-made archive has: not executable, and not host-dependent either.
      ["plain.txt", false],
      ["run.sh", true],
    ])
  })

  test("rejects an entry that escapes the skill", async () => {
    for (const name of ["../escape.md", "demo/../../escape.md", "/abs.md"]) {
      const dir = await root(async (skills) => {
        await writeArchive(skills, "demo", [
          { name: "demo/SKILL.md", data: SKILL },
          { name, data: "x" },
        ])
      })
      await expect(read(dir, "demo")).rejects.toThrow(/not a safe relative path/)
    }
  })

  test("rejects a symlink entry", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: "demo/SKILL.md", data: SKILL },
        { name: "demo/link", data: "/etc/passwd", mode: 0o120777 },
      ])
    })
    await expect(read(dir, "demo")).rejects.toThrow(/is a symlink\. A bundled skill has to be self-contained\./)
  })

  test("rejects two entries that land on the same path", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [
        { name: "demo/SKILL.md", data: SKILL },
        { name: "demo/dup.md", data: "one" },
        { name: "demo/dup.md", data: "two" },
      ])
    })
    await expect(read(dir, "demo")).rejects.toThrow(/two entries named dup\.md/)
  })

  test("rejects an archive with nothing in it", async () => {
    const dir = await root(async (skills) => {
      await writeArchive(skills, "demo", [{ name: "demo/.DS_Store", data: "x" }])
    })
    await expect(read(dir, "demo")).rejects.toThrow(/contains no skill files/)
  })

  test("refuses to walk a symlink in a vendored directory", async () => {
    const dir = await root(async (skills) => {
      await writeTree(skills, "demo", { "SKILL.md": SKILL })
      await fs.symlink("/etc/passwd", path.join(skills, "demo", "link"))
    })
    await expect(read(dir, "demo")).rejects.toThrow(/is a symlink\. A bundled skill has to be self-contained\./)
  })
})

describe("readAll", () => {
  test("carries a source failure instead of throwing it", async () => {
    const dir = await root(async (skills) => {
      await writeTree(skills, "good", { "SKILL.md": SKILL })
    })
    const results = await SkillSource.readAll(dir, [{ id: "good" }, { id: "missing" }])
    expect(results.get("good")).toMatchObject({ kind: "directory" })
    expect(results.get("missing")).toMatchObject({ error: expect.stringContaining("skills/missing") })
  })
})

describe("hashSkills", () => {
  test("a chmod alone invalidates", () => {
    const file = { path: "run.sh", encoding: "utf8" as const, data: "x" }
    expect(SkillSource.hashSkills([{ id: "a", files: [{ ...file, executable: false }] }])).not.toBe(
      SkillSource.hashSkills([{ id: "a", files: [{ ...file, executable: true }] }]),
    )
  })
})
