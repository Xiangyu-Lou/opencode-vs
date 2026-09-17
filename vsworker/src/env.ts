export * as VsWorkerEnv from "./env"

import fs from "fs/promises"
import path from "path"

// A skill directory may carry a flat `env.json` whose pairs become environment variables for the bash commands
// that run inside it. The shape is dictated by the 识油 platform, which parses the same file when a skill is
// registered and writes every key straight into the process environment: a flat {"NAME": "value"} object, no
// comments, no grouping, no nesting. Vendored skills read the same file themselves when they run outside the
// platform, so the two have to agree byte for byte.
export const FILE = "env.json"

// Every key is exported, including one starting with an underscore: the platform does the same, and a skill that
// documents `_` keys as comments still gets them in its environment.
export const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export type Values = Record<string, string>

export type Parsed = {
  values: Values
  problems: string[]
}

export type Substitute = (text: string) => Promise<string>

function label(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

// The value coercion env.json uses, shared with the config overrides so both spell a boolean and a null the same
// way. Anything else is not an environment variable value.
export function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "1" : "0"
  if (value === null) return ""
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

// All or nothing, like the skill's own Python parser: a file with any problem exports nothing rather than half a
// configuration, because a half-applied environment is harder to diagnose than an absent one.
export function parse(text: string, source: string): Parsed {
  const problems: string[] = []
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  let data: unknown
  try {
    data = JSON.parse(stripped)
  } catch (error) {
    return { values: {}, problems: [`${source} is not valid JSON: ${error instanceof Error ? error.message : error}`] }
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { values: {}, problems: [`${source} must be a flat JSON object, got ${label(data)}`] }
  }

  const values: Values = {}
  for (const [key, value] of Object.entries(data)) {
    if (!KEY.test(key)) {
      problems.push(`${source}: ${JSON.stringify(key)} is not a usable environment variable name`)
      continue
    }
    const text = scalar(value)
    if (text === undefined) {
      problems.push(
        `${source}: ${key} is ${label(value)} — an environment variable can only be a string, number, boolean, or null`,
      )
      continue
    }
    values[key] = text
  }

  if (problems.length) return { values: {}, problems }
  return { values, problems }
}

export async function read(dir: string) {
  try {
    return await fs.readFile(path.join(dir, FILE), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export type Loaded = Parsed & { present: boolean }

type CacheEntry = { mtimeMs: number; size: number; parsed: Parsed }

// Keyed by file and by whether placeholders were substituted, so a skill's env.json is parsed once per change, not
// once per bash call, and the skill tool's raw read (names only) never hands the shell a cached copy with the
// placeholders still in it. `problems` are reported only on a fresh parse, which is what keeps an invalid file
// from warning on every single command.
const cache = new Map<string, CacheEntry>()

function cacheKey(file: string, substituted: boolean) {
  return `${substituted ? "s" : "r"}:${file}`
}

export function forget() {
  cache.clear()
}

export async function load(input: { dir: string; substitute?: Substitute }): Promise<Loaded> {
  const file = path.join(input.dir, FILE)
  const key = cacheKey(file, Boolean(input.substitute))

  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    cache.delete(key)
    return { present: false, values: {}, problems: [] }
  }
  if (!stat.isFile()) {
    cache.delete(key)
    return { present: false, values: {}, problems: [] }
  }

  const hit = cache.get(key)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return { present: true, values: hit.parsed.values, problems: [] }
  }

  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    return { present: true, values: {}, problems: [`${file} could not be read: ${String(error)}`] }
  }

  // Same placeholders as a bundled MCP definition, so a value that must differ per machine can be written as
  // {env:VAR} or {file:path} instead of being compiled in. Guarded by a cheap check, like vsworker/src/mcp.ts.
  if (input.substitute && (text.includes("{env:") || text.includes("{file:"))) {
    try {
      text = await input.substitute(text)
    } catch (error) {
      return {
        present: true,
        values: {},
        problems: [`${file}: substitution failed: ${error instanceof Error ? error.message : String(error)}`],
      }
    }
  }

  const parsed = parse(text, file)
  cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
  return { present: true, values: parsed.values, problems: parsed.problems }
}

export async function describe(dir: string) {
  const loaded = await load({ dir })
  const keys = Object.keys(loaded.values)
  if (!keys.length) return undefined
  return { keys: keys.sort() }
}

const SEPARATORS = new Set([";", "|", "&", "(", ")", "<", ">"])

// Enough of a shell tokenizer to find the paths in a command. It does not try to be a shell: it only has to
// surface the arguments that look like paths so `matches` can compare them against a skill directory.
export function tokens(command: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaped = false
  let seen = false

  const push = () => {
    if (seen) result.push(current)
    current = ""
    seen = false
  }

  for (const char of command) {
    if (escaped) {
      current += char
      seen = true
      escaped = false
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      seen = true
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      seen = true
      continue
    }
    if (/\s/.test(char) || SEPARATORS.has(char)) {
      push()
      continue
    }
    current += char
    seen = true
  }
  push()

  // `KEY=path` prefixes and assignments carry a path in their value half.
  return result.flatMap((token) => {
    const eq = token.indexOf("=")
    if (eq > 0 && KEY.test(token.slice(0, eq))) return [token, token.slice(eq + 1)]
    return [token]
  })
}

function normalize(value: string) {
  const resolved = path.resolve(value)
  if (process.platform !== "win32") return resolved
  return resolved.replaceAll("\\", "/").toLowerCase()
}

function inside(child: string, parent: string) {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/")
}

// A path stops where a shell argument stops. Without this, a command naming `<dir>-other` would match `<dir>`,
// because one directory name is a prefix of the other.
const BOUNDARY = /[\s"'`=:,;|&()<>]/

function mentions(command: string, dir: string) {
  for (let index = command.indexOf(dir); index !== -1; index = command.indexOf(dir, index + 1)) {
    const before = index === 0 ? "" : command[index - 1]!
    const after = command[index + dir.length] ?? ""
    if (before && !BOUNDARY.test(before)) continue
    if (after && after !== "/" && !BOUNDARY.test(after)) continue
    return true
  }
  return false
}

export type MatchInput = {
  command: string
  cwd: string
  dir: string
  home?: string
}

// A skill's variables reach a command when the command actually runs in that skill: either its working directory
// is the skill directory, or it names a path inside it. A bare word never matches, so an unrelated command that
// happens to share a name with a skill directory stays untouched.
export function matches(input: MatchInput): boolean {
  const dir = normalize(input.dir)
  const cwd = normalize(input.cwd)
  if (inside(cwd, dir)) return true

  const command = process.platform === "win32" ? input.command.replaceAll("\\", "/").toLowerCase() : input.command
  if (mentions(command, dir)) return true

  for (const token of tokens(input.command)) {
    if (!token) continue
    let candidate = token
    if (candidate.startsWith("~")) {
      if (!input.home) continue
      if (candidate !== "~" && !candidate.startsWith("~/")) continue
      candidate = path.join(input.home, candidate.slice(1))
    } else if (!path.isAbsolute(candidate) && !candidate.includes("/") && !candidate.includes(path.sep)) {
      continue
    }
    if (inside(normalize(path.resolve(input.cwd, candidate)), dir)) return true
  }

  return false
}

export type SkillRef = {
  name: string
  location: string
}

export type ResolveInput = {
  command: string
  cwd: string
  home?: string
  skills: readonly SkillRef[]
  substitute?: Substitute
  // Per-skill overrides from config, keyed by skill name. They are layered over the skill's env.json for the same
  // commands, and they reach a skill that ships no env.json at all.
  overrides?: ReadonlyMap<string, Values>
}

// Built-in skills have no directory on disk, so they are skipped rather than resolved against the cwd.
const BUILT_IN = "<built-in>"

export async function resolve(input: ResolveInput): Promise<{ env: Values; warnings: string[] }> {
  const env: Values = {}
  const warnings: string[] = []

  const ordered = [...input.skills]
    .filter((skill) => skill.location && skill.location !== BUILT_IN)
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const skill of ordered) {
    const dir = path.dirname(skill.location)
    if (!matches({ command: input.command, cwd: input.cwd, dir, home: input.home })) continue
    const extra = input.overrides?.get(skill.name)
    const loaded = await load({ dir, substitute: input.substitute })
    if (!loaded.present && !extra) continue
    for (const problem of loaded.problems) warnings.push(problem)
    Object.assign(env, loaded.values)
    // Config values were already substituted and schema-checked when the config loaded; only a key can still be
    // wrong, and a bad one is dropped rather than exported under a name no shell could read.
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (!KEY.test(key)) {
        warnings.push(`skill_env for ${skill.name}: ${JSON.stringify(key)} is not a usable environment variable name`)
        continue
      }
      env[key] = value
    }
  }

  return { env, warnings }
}
