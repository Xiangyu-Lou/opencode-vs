export * as VsWorkerPluginEdit from "./plugin-edit"

import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { ConfigPaths } from "@/config/paths"
import { installPlugin, readPluginManifest } from "@/plugin/install"
import { isPathPluginSpec, parsePluginSpecifier } from "@/plugin/shared"
import { Filesystem } from "@/util/filesystem"
import { VsWorkerConfigEdit } from "./config-edit"

export class InstallError extends Error {
  constructor(
    readonly spec: string,
    readonly detail: string,
  ) {
    super(`could not install ${spec}: ${detail}`)
  }
}

export class DuplicateError extends Error {
  constructor(readonly spec: string) {
    super(`${spec} is already in this config`)
  }
}

export class MissingError extends Error {
  constructor(readonly spec: string) {
    super(`${spec} is not declared in this config`)
  }
}

function list(parsed: unknown): unknown[] {
  const value = VsWorkerConfigEdit.isRecord(parsed) ? parsed["plugin"] : undefined
  return Array.isArray(value) ? value : []
}

function specOf(item: unknown): string | undefined {
  if (typeof item === "string") return item
  if (Array.isArray(item) && typeof item[0] === "string") return item[0]
  return undefined
}

function toPath(value: string) {
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return undefined
    }
  }
  return value
}

// Whether a spec written in a config file is the one a caller means. Config loading rewrites a path-like spec
// into an absolute file:// URL, and may point it at a package's entry file, so a raw `./demo.ts` and the
// resolved `file:///…/demo.ts` are the same plugin. npm specs compare on package name, so a version bump in
// either place still matches.
export function matches(raw: string, spec: string, configFile: string) {
  if (raw === spec) return true
  const rawIsPath = isPathPluginSpec(raw) || raw.startsWith("file://")
  const specIsPath = isPathPluginSpec(spec) || spec.startsWith("file://")
  if (rawIsPath !== specIsPath) return false
  if (!rawIsPath) return parsePluginSpecifier(raw).pkg === parsePluginSpecifier(spec).pkg

  const target = toPath(spec)
  const declared = toPath(raw)
  if (!target || !declared) return false
  const absolute = path.isAbsolute(declared) ? declared : path.resolve(path.dirname(configFile), declared)
  if (absolute === target) return true
  // A spec naming a directory resolves to an entry file inside it.
  return target.startsWith(absolute + path.sep)
}

export function specs(parsed: unknown): string[] {
  return list(parsed)
    .map(specOf)
    .filter((item): item is string => item !== undefined)
}

export function indexOf(parsed: unknown, spec: string, configFile: string): number {
  return list(parsed).findIndex((item) => {
    const current = specOf(item)
    return current !== undefined && matches(current, spec, configFile)
  })
}

// The spec as it would be written into a config file: a local path becomes an absolute file:// URL so the
// entry does not depend on where the file happens to sit relative to the config.
export function writableSpec(spec: string) {
  if (!isPathPluginSpec(spec) || spec.startsWith("file://")) return spec
  return pathToFileURL(path.resolve(spec)).href
}

// Resolve and install the package so a spec that cannot load never reaches the user's config, and so the
// manifest can say whether it is a server plugin, a TUI plugin, or both.
export async function resolve(spec: string) {
  const target = await installPlugin(spec)
  if (!target.ok) throw new InstallError(spec, String(target.error))
  const manifest = await readPluginManifest(target.target)
  if (!manifest.ok) {
    if (manifest.code === "manifest_no_targets") {
      throw new InstallError(spec, `${manifest.file} declares no server or tui plugin entry`)
    }
    throw new InstallError(spec, String(manifest.error))
  }
  return { target: target.target, targets: manifest.targets }
}

export type AddInput = {
  spec: string
  file: string
  tuiFile: string
  expectedRevision?: string
}

export async function add(input: AddInput) {
  const resolved = await resolve(input.spec)
  const server = resolved.targets.find((item) => item.kind === "server")
  const tui = resolved.targets.find((item) => item.kind === "tui")

  const written = writableSpec(input.spec)

  let revision: string | undefined
  if (server) {
    const entry = server.opts ? [written, server.opts] : written
    const result = await VsWorkerConfigEdit.patch({
      file: input.file,
      expectedRevision: input.expectedRevision,
      edits: (parsed) => {
        if (indexOf(parsed, written, input.file) !== -1) throw new DuplicateError(input.spec)
        return [{ path: ["plugin", list(parsed).length], value: entry, insert: true }]
      },
    })
    revision = result.revision
  }

  if (tui) {
    const entry = tui.opts ? [written, tui.opts] : written
    await VsWorkerConfigEdit.patch({
      file: input.tuiFile,
      edits: (parsed) => {
        if (indexOf(parsed, written, input.tuiFile) !== -1) return []
        return [{ path: ["plugin", list(parsed).length], value: entry, insert: true }]
      },
    })
  }

  return { revision, kinds: resolved.targets.map((item) => item.kind) }
}

export async function remove(input: { spec: string; file: string; tuiFile: string; expectedRevision?: string }) {
  const result = await VsWorkerConfigEdit.patch({
    file: input.file,
    expectedRevision: input.expectedRevision,
    edits: (parsed) => {
      const index = indexOf(parsed, input.spec, input.file)
      if (index === -1) throw new MissingError(input.spec)
      return [{ path: ["plugin", index], value: undefined }]
    },
  })

  if (await Filesystem.exists(input.tuiFile)) {
    await VsWorkerConfigEdit.patch({
      file: input.tuiFile,
      edits: (parsed) => {
        const index = indexOf(parsed, input.spec, input.tuiFile)
        if (index === -1) return []
        return [{ path: ["plugin", index], value: undefined }]
      },
    })
  }

  return result
}

// The tui.json sibling of a resolved opencode config file, preferring one that already exists.
export async function tuiFile(configFile: string) {
  const candidates = ConfigPaths.fileInDirectory(path.dirname(configFile), "tui")
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
  return candidates[0]
}
