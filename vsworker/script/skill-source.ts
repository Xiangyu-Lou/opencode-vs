export * as SkillSource from "./skill-source"

import path from "path"
import fs from "fs/promises"
import { existsSync, statSync } from "fs"
import { createHash } from "crypto"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from "@zip.js/zip.js"

// zip.js inflates in a pool of web workers by default and keeps them warm afterwards, which leaves a one-shot
// `bundle generate` hanging once its work is done. A bundled skill is under a megabyte, so inflate right here.
configure({ useWebWorkers: false })

// Editor and interpreter droppings that appear inside a skill but are not part of it. They are skipped rather
// than inlined: they differ per machine, so bundling them would make the skills hash -- and with it
// `bundle check` -- disagree between the machine that ran `generate` and the machine that runs CI. An archive
// needs this more than a directory does: vsworker/.gitignore keeps `__pycache__` out of a vendored directory,
// but a .zip is one opaque blob to git, so this filter is the only thing standing between junk inside it and
// every build.
const SKIP_DIRS = new Set(["__pycache__", ".git", ".DS_Store", "__MACOSX"])
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"])
const SKIP_EXTENSIONS = new Set([".pyc", ".pyo"])

export const ARCHIVE_EXTENSION = ".zip"

// The file-type bits of a Unix st_mode, and their value for a symlink.
const UNIX_TYPE_MASK = 0o170000
const UNIX_TYPE_LINK = 0o120000

// "Version made by" high byte 3 means the archive was written on Unix, which is the only case where the
// external attributes hold an st_mode rather than DOS attribute flags. This is the same test zip.js itself
// applies to derive `entry.executable`.
const UNIX_MADE_BY = 3

// One file of a skill as it sits in its source, before the build decides how to carry it.
export type SourceFile = {
  path: string
  data: Buffer
  executable: boolean
}

// The same file as it is written into skills.gen.ts. Binary payloads are base64 so the generated module stays a
// plain TypeScript source file.
export type BundleFile = {
  path: string
  encoding: "utf8" | "base64"
  executable: boolean
  data: string
}

export type Kind = "directory" | "archive"

export type Source = {
  kind: Kind
  // Relative to vsworker/, which is how every problem message names it: "skills/foo" or "skills/foo.zip".
  relative: string
  absolute: string
}

export type Contents = {
  files: SourceFile[]
  warnings: string[]
}

export type Entry = {
  id: string
  path?: string | undefined
}

// Copy of isSafeRelativePath in packages/core/src/skill/discovery.ts. The runtime applies it to skills pulled
// from a URL; a vendored skill gets the same treatment so a path that cannot be materialized is caught here.
export function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  )
}

// AppleDouble sidecars carry extended attributes, Finder labels and quarantine flags, so they differ per
// machine. Finder writes them into an archive under __MACOSX/, every other tool leaves a ._name next to the
// file itself, which is why the directory name alone is not enough.
function skipFile(name: string) {
  return SKIP_FILES.has(name) || SKIP_EXTENSIONS.has(path.extname(name)) || name.startsWith("._")
}

function skipPath(name: string) {
  const segments = name.split("/")
  const base = segments.pop() ?? ""
  return segments.some((segment) => SKIP_DIRS.has(segment)) || skipFile(base)
}

// Where a manifest entry's files come from. A skill is vendored either as a directory or as a .zip holding one;
// `path` may name either, and without it both default names are probed.
export function locate(root: string, entry: Entry): Source {
  const candidates = entry.path
    ? [entry.path]
    : [path.posix.join("skills", entry.id), path.posix.join("skills", entry.id + ARCHIVE_EXTENSION)]
  const found = candidates.filter((relative) => existsSync(path.join(root, relative)))

  // Both forms existing is fatal rather than a precedence rule. The skills hash feeds `bundle check`, so if
  // precedence quietly picked one, a machine where the other is absent would produce a different hash with
  // nothing on screen to explain it.
  if (found.length > 1) {
    throw new Error(
      `skill ${entry.id} has both ${found.map((relative) => `vsworker/${relative}`).join(" and ")}. Delete one.`,
    )
  }
  const relative = found[0]
  if (!relative) {
    throw new Error(`skill ${entry.id}: none of ${candidates.map((item) => `vsworker/${item}`).join(", ")} exists`)
  }

  const absolute = path.join(root, ...relative.split("/"))
  // The extension decides the kind and the filesystem has to agree, so `path` pointing at a directory named
  // foo.zip, or at an archive without the extension, is an error rather than a surprise.
  const kind: Kind = relative.endsWith(ARCHIVE_EXTENSION) ? "archive" : "directory"
  const stat = statSync(absolute)
  if (kind === "archive" && !stat.isFile()) throw new Error(`vsworker/${relative} is not a file`)
  if (kind === "directory" && !stat.isDirectory()) {
    throw new Error(`vsworker/${relative} is not a directory. A skill archive has to be named <id>.zip.`)
  }
  return { kind, relative, absolute }
}

// A source that is not vendored yet, which is what `bundle import skill` reads. Its path is shown verbatim in
// messages because it names a place on the user's machine, not something under vsworker/.
export function external(file: string): Source {
  const absolute = path.resolve(file)
  const stat = statSync(absolute)
  if (stat.isDirectory()) return { kind: "directory", relative: file, absolute }
  if (!file.endsWith(ARCHIVE_EXTENSION)) {
    throw new Error(`${file} is neither a skill directory nor a ${ARCHIVE_EXTENSION} archive`)
  }
  return { kind: "archive", relative: file, absolute }
}

async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name
    if (entry.isSymbolicLink()) {
      throw new Error(`${relative} is a symlink. A bundled skill has to be self-contained.`)
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      result.push(...(await walk(root, relative)))
      continue
    }
    if (skipFile(entry.name)) continue
    if (entry.isFile()) result.push(relative)
  }
  return result
}

async function readDirectory(source: Source): Promise<Contents> {
  const files: SourceFile[] = []
  for (const name of await walk(source.absolute)) {
    if (!isSafeRelativePath(name)) throw new Error(`${source.relative}/${name} is not a safe relative path`)
    const file = path.join(source.absolute, ...name.split("/"))
    const stat = await fs.stat(file)
    files.push({
      path: name,
      data: await fs.readFile(file),
      // stat on Windows reports 0o666 for every file, so the bit is only meaningful where it exists. The
      // archive reader has no such problem: it reads the mode out of the archive's own bytes.
      executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0,
    })
  }
  return { files, warnings: [] }
}

// A single wrapping directory is stripped, so `zip -r foo.zip foo/` and `cd foo && zip -r ../foo.zip .` vendor
// the same skill. The `includes("/")` half matters: an archive holding only SKILL.md has one distinct first
// segment too, and stripping it would leave nothing.
function prefixOf(names: string[]) {
  if (!names.length || !names.every((name) => name.includes("/"))) return undefined
  const first = new Set(names.map((name) => name.split("/")[0]))
  return first.size === 1 ? [...first][0] : undefined
}

function unixMode(entry: { versionMadeBy: number; externalFileAttributes: number }) {
  if (entry.versionMadeBy >> 8 !== UNIX_MADE_BY) return undefined
  return (entry.externalFileAttributes >>> 16) & 0o177777
}

async function readArchive(source: Source, id: string): Promise<Contents> {
  const warnings: string[] = []
  // fs.readFile hands back a Buffer that is usually a view into a shared pool, and zip.js takes the DataView of
  // its backing ArrayBuffer from offset zero. Copy into a standalone array so what it reads is the archive and
  // not whatever else the pool is holding -- a small archive is the one that lands in the pool, so this fails
  // exactly where it is least likely to be noticed.
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await fs.readFile(source.absolute))))
  try {
    const raw = await reader.getEntries()
    const kept: { name: string; entry: (typeof raw)[number] }[] = []
    const skipped: string[] = []

    for (const entry of raw) {
      if (entry.directory) continue
      if (entry.encrypted) throw new Error(`${source.relative}: ${entry.filename} is encrypted`)
      // zip.js falls back to CP437 when an entry does not flag its name as UTF-8, which silently mojibakes a
      // name written as UTF-8 by a tool that forgot the flag. ASCII is identical under both, so only a
      // high-byte name without the flag is ambiguous, and guessing at it is worse than saying so.
      if (!entry.filenameUTF8 && entry.rawFilename.some((byte) => byte > 0x7f)) {
        throw new Error(
          `${source.relative}: ${entry.filename} has a non-ASCII name that is not flagged UTF-8. Re-zip it with \`zip -r -UN=UTF8\`.`,
        )
      }
      // A zip symlink's payload is the target path, so bundling one would inline a file whose contents are a
      // path. Same rule, and same words, as the directory walk.
      const mode = unixMode(entry)
      if (mode !== undefined && (mode & UNIX_TYPE_MASK) === UNIX_TYPE_LINK) {
        throw new Error(`${entry.filename} is a symlink. A bundled skill has to be self-contained.`)
      }
      // Checked before anything is filtered or stripped, so no later step ever handles a hostile name.
      if (!isSafeRelativePath(entry.filename)) {
        throw new Error(`${source.relative}: ${JSON.stringify(entry.filename)} is not a safe relative path`)
      }
      if (skipPath(entry.filename)) {
        skipped.push(entry.filename)
        continue
      }
      kept.push({ name: entry.filename, entry })
    }

    if (!kept.length) throw new Error(`${source.relative} contains no skill files`)

    // Junk is dropped before the prefix is computed, not after: a __MACOSX/ sibling of the real wrapper makes
    // two distinct first segments, which would silently defeat stripping and leave every file one level deep.
    const prefix = prefixOf(kept.map((item) => item.name))
    if (prefix && prefix !== id) {
      warnings.push(`skill ${id}: ${source.relative} wraps its files in ${prefix}/, which is not the skill id`)
    }
    if (skipped.length) {
      warnings.push(`skill ${id}: ${source.relative} skipped ${skipped.length} file(s): ${skipped.join(", ")}`)
    }

    const files: SourceFile[] = []
    const seen = new Set<string>()
    for (const item of kept) {
      const name = prefix ? item.name.slice(prefix.length + 1) : item.name
      if (!isSafeRelativePath(name)) throw new Error(`${source.relative}: ${name} is not a safe relative path`)
      if (seen.has(name)) throw new Error(`${source.relative} has two entries named ${name}`)
      seen.add(name)
      if (!item.entry.getData) throw new Error(`${source.relative}: ${item.name} carries no data`)
      files.push({
        path: name,
        data: Buffer.from(await item.entry.getData(new Uint8ArrayWriter())),
        // zip.js sets this only for a Unix-made archive with a mode carrying an execute bit, so it comes from
        // the archive's own bytes and never from the machine running the build.
        executable: item.entry.executable,
      })
    }
    // Plain sort, never localeCompare: skills.gen.ts is compared as text by `bundle check`, and a collating
    // locale would reorder a non-ASCII path between a developer's shell and CI.
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files, warnings }
  } finally {
    await reader.close()
  }
}

export async function read(source: Source, id: string): Promise<Contents> {
  if (source.kind === "archive") return readArchive(source, id)
  const contents = await readDirectory(source)
  contents.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return contents
}

// A NUL byte or a failed UTF-8 round trip means the bytes are not text, so carry them as base64.
export function encode(file: SourceFile): BundleFile {
  const text = file.data.toString("utf8")
  const binary = file.data.includes(0) || !Buffer.from(text, "utf8").equals(file.data)
  return {
    path: file.path,
    encoding: binary ? "base64" : "utf8",
    executable: file.executable,
    data: binary ? file.data.toString("base64") : text,
  }
}

// The hash decides whether a running build re-materializes the cache directory. `executable` is part of it so a
// chmod alone still invalidates.
export function hashSkills(rows: readonly { id: string; files: readonly BundleFile[] }[]) {
  const hash = createHash("sha256")
  const lines: string[] = []
  for (const row of rows) {
    for (const file of row.files) {
      lines.push(JSON.stringify([row.id, file.path, file.encoding, file.executable, file.data]))
    }
  }
  for (const line of lines.sort()) hash.update(line + "\n")
  return hash.digest("hex")
}

// One skill's source as load() read it, or the reason it could not be read. Failures are carried rather than
// thrown so validate() can report a corrupt archive alongside every other manifest problem instead of dying on
// the first one.
export type Result = ({ kind: Kind; relative: string } & Contents) | { error: string }

// How a file inside a skill is named in a problem message. A directory has a real path to point at; a file
// inside an archive does not, so it is named as a member of the archive.
export function label(source: { kind: Kind; relative: string }, file: string) {
  if (source.kind === "archive") return `vsworker/${source.relative} (${file})`
  return `vsworker/${source.relative}/${file}`
}

export async function readAll(root: string, entries: readonly Entry[]): Promise<Map<string, Result>> {
  const results = new Map<string, Result>()
  for (const entry of entries) {
    try {
      const source = locate(root, entry)
      results.set(entry.id, { ...source, ...(await read(source, entry.id)) })
    } catch (error) {
      results.set(entry.id, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
