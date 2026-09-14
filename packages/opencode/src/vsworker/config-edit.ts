export * as VsWorkerConfigEdit from "./config-edit"

import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { applyEdits, modify } from "jsonc-parser"
import { ConfigParse } from "@/config/parse"
import { Filesystem } from "@/util/filesystem"

export type Scope = "global" | "project"

// The revision of a config file as the UI last saw it. An absent file has revision "" so that creating it
// races the same way editing it does.
export type Revision = string

export class ConflictError extends Error {
  readonly file: string
  readonly expected: Revision
  readonly actual: Revision
  constructor(input: { file: string; expected: Revision; actual: Revision }) {
    super(`${input.file} changed on disk since it was read`)
    this.file = input.file
    this.expected = input.expected
    this.actual = input.actual
  }
}

export function revision(text: string | undefined): Revision {
  if (text === undefined) return ""
  return Hash.sha256(text)
}

// Same resolution as `opencode mcp add` and the vsworker CLI: prefer a config file that already exists, in
// the base directory first and then under .opencode/, and fall back to opencode.json.
export async function resolveFile(baseDir: string, scope: Scope): Promise<string> {
  const fallback = path.join(baseDir, "opencode.json")
  const candidates = [fallback, path.join(baseDir, "opencode.jsonc")]
  if (scope === "project") {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
  return fallback
}

// The directory a project-scoped write targets. A non-git project reports "/" as its worktree, which is never
// a place to write, so fall back to the working directory the same way the plugin installer does.
export function projectDir(ctx: { directory: string; worktree?: string } | undefined): string | undefined {
  if (!ctx) return undefined
  if (ctx.worktree && ctx.worktree !== "/") return ctx.worktree
  return ctx.directory
}

export function baseDir(scope: Scope, ctx: { directory: string; worktree?: string } | undefined): string {
  if (scope === "global") return Global.Path.config
  return projectDir(ctx) ?? process.cwd()
}

export async function read(file: string): Promise<{ file: string; text: string; revision: Revision; parsed: unknown }> {
  const exists = await Filesystem.exists(file)
  const text = exists ? await Filesystem.readText(file) : undefined
  return {
    file,
    text: text ?? "{}",
    revision: revision(text),
    parsed: ConfigParse.jsonc(text ?? "{}", file),
  }
}

export type Edit = {
  path: (string | number)[]
  // `undefined` deletes the key, which is what jsonc-parser's modify() does with an undefined value.
  value: unknown
  // Insert into an array at the index named by the last path segment instead of replacing that element.
  insert?: boolean
}

export type PatchInput = {
  file: string
  // Edits may be computed from the freshly re-read document, so callers that need the current contents
  // (appending to an array, preserving a sibling key) pass a function instead of a literal list.
  edits: Edit[] | ((parsed: unknown, text: string) => Edit[])
  expectedRevision?: Revision
}

const FORMATTING = { insertSpaces: true, tabSize: 2 } as const

// Every write re-reads under the lock, checks the revision the caller last saw, then applies one surgical
// jsonc-parser edit per leaf. Comments, key order and formatting in the rest of the file survive untouched.
export async function patch(input: PatchInput): Promise<{ revision: Revision; text: string }> {
  return Flock.withLock(`vsworker-config:${input.file}`, async () => {
    const exists = await Filesystem.exists(input.file)
    const before = exists ? await Filesystem.readText(input.file) : undefined
    const current = revision(before)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current) {
      throw new ConflictError({ file: input.file, expected: input.expectedRevision, actual: current })
    }

    let text = before ?? "{}"
    const parsed = ConfigParse.jsonc(text, input.file)
    const edits = typeof input.edits === "function" ? input.edits(parsed, text) : input.edits
    for (const edit of edits) {
      text = applyEdits(
        text,
        modify(text, edit.path, edit.value, { formattingOptions: FORMATTING, isArrayInsertion: edit.insert }),
      )
    }
    if (text !== before) await Filesystem.write(input.file, text)
    return { revision: revision(text), text }
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type Kind = "plugins" | "mcp" | "skills"

// Where each kind's on/off switch lives in opencode.json. MCP servers use the stock `mcp.<id>.enabled` key
// rather than anything fork-specific, so the same edit works on a server the user later redefines themselves.
export function togglePath(kind: Kind, id: string, parsed: unknown): (string | number)[] {
  if (kind === "mcp") return ["mcp", id, "enabled"]
  if (kind === "skills") return ["vsworker", "skills", id]
  const vsworker = isRecord(parsed) && isRecord(parsed.vsworker) ? parsed.vsworker : {}
  const plugins = isRecord(vsworker.plugins) ? vsworker.plugins : {}
  // Preserve an existing options object by writing to vsworker.plugins.<id>.enabled instead of replacing it.
  return isRecord(plugins[id]) ? ["vsworker", "plugins", id, "enabled"] : ["vsworker", "plugins", id]
}

export async function toggle(input: {
  kind: Kind
  id: string
  enabled: boolean
  file: string
  expectedRevision?: Revision
}) {
  return patch({
    file: input.file,
    expectedRevision: input.expectedRevision,
    edits: (parsed) => [{ path: togglePath(input.kind, input.id, parsed), value: input.enabled }],
  })
}
