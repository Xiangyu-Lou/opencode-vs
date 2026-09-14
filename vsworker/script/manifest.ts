import path from "path"
import { existsSync, readFileSync, statSync } from "fs"
import { Schema } from "effect"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { VsWorkerEnv } from "../src/env"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import semver from "semver"

export const ROOT = path.resolve(import.meta.dirname, "..")
export const REPO = path.resolve(ROOT, "..")
export const MANIFEST_FILE = path.join(ROOT, "bundle.jsonc")
export const SCHEMA_FILE = path.join(ROOT, "bundle.schema.json")

export const Source = Schema.Literals(["npm", "github", "local"])
export type Source = Schema.Schema.Type<typeof Source>

export const Kind = Schema.Literals(["server", "tui"])
export type Kind = Schema.Schema.Type<typeof Kind>

const Enabled = Schema.optional(Schema.Boolean).annotate({
  description: "Include this entry in the build. Defaults to true. False removes it from the bundle entirely",
})
const DefaultEnabled = Schema.optional(Schema.Boolean).annotate({
  description: "Use this entry unless a user turns it off. Defaults to true",
})

export const PluginEntry = Schema.Struct({
  id: Schema.String.annotate({
    description: "Stable identity used in opencode.json under vsworker.plugins, and in the CLI",
  }),
  source: Source.annotate({
    description: "npm registry package, GitHub repository, or a plugin vendored under vsworker/plugins",
  }),
  package: Schema.optional(Schema.String).annotate({
    description: "npm package name, required for npm and github sources",
  }),
  version: Schema.optional(Schema.String).annotate({
    description: "Exact version to pin, required for npm sources",
  }),
  repo: Schema.optional(Schema.String).annotate({ description: "owner/repo, required for github sources" }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Full 40 character commit sha to pin, required for github sources",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Entrypoint relative to vsworker/, for local sources. Defaults to plugins/<id>/index.ts",
  }),
  kind: Schema.optional(Kind).annotate({
    description: "Force the plugin kind instead of detecting it from the package exports",
  }),
  enabled: Enabled,
  defaultEnabled: DefaultEnabled,
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Options passed to the plugin, overridable per user in opencode.json",
  }),
  description: Schema.optional(Schema.String).annotate({ description: "Why this plugin is bundled" }),
})
export type PluginEntry = Schema.Schema.Type<typeof PluginEntry>

export const McpEntry = Schema.Struct({
  id: Schema.String.annotate({
    description: "Server name. Users see it as the mcp.<id> key in opencode.json, and its tools are prefixed with it",
  }),
  config: ConfigMCPV1.Info.annotate({
    description:
      "The mcp.<id> value exactly as it would appear in opencode.json. {env:VAR} and {file:path} are substituted at runtime, relative to the global config directory",
  }),
  enabled: Enabled,
  defaultEnabled: DefaultEnabled,
  description: Schema.optional(Schema.String).annotate({ description: "Why this server is bundled" }),
})
export type McpEntry = Schema.Schema.Type<typeof McpEntry>

export const SkillEntry = Schema.Struct({
  id: Schema.String.annotate({
    description: "Skill name. Must match the name in the skill's SKILL.md frontmatter",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Skill directory relative to vsworker/. Defaults to skills/<id>",
  }),
  enabled: Enabled,
  defaultEnabled: DefaultEnabled,
  description: Schema.optional(Schema.String).annotate({ description: "Why this skill is bundled" }),
})
export type SkillEntry = Schema.Schema.Type<typeof SkillEntry>

const ManifestSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  plugins: Schema.optional(Schema.mutable(Schema.Array(PluginEntry))).annotate({
    description: "Plugins bundled into VsWorker builds",
  }),
  mcp: Schema.optional(Schema.mutable(Schema.Array(McpEntry))).annotate({
    description: "MCP servers bundled into VsWorker builds",
  }),
  skills: Schema.optional(Schema.mutable(Schema.Array(SkillEntry))).annotate({
    description: "Skills bundled into VsWorker builds, vendored under vsworker/skills",
  }),
}).annotate({ identifier: "VsWorkerBundle" })

// Every section is optional in the file but always present after load(), so nothing downstream branches on a
// missing array.
export type Manifest = {
  $schema?: string
  plugins: PluginEntry[]
  mcp: McpEntry[]
  skills: SkillEntry[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const SHA_PATTERN = /^[0-9a-f]{40}$/

// Entries are validated beyond the schema because the required fields depend on `source`, because a bad pin only
// shows up much later as a confusing install or bundling failure, and because a vendored skill has to satisfy the
// rules the runtime skill loader applies.
export function validate(manifest: Manifest) {
  const problems: string[] = []

  const identity = (section: string, entries: readonly { id: string }[]) => {
    const ids = new Set<string>()
    for (const [index, entry] of entries.entries()) {
      const at = `${section}[${index}] (${entry.id || "missing id"})`
      if (!ID_PATTERN.test(entry.id)) problems.push(`${at}: id must match ${ID_PATTERN}`)
      if (ids.has(entry.id)) problems.push(`${at}: duplicate id`)
      ids.add(entry.id)
    }
  }

  identity("plugins", manifest.plugins)
  identity("mcp", manifest.mcp)
  identity("skills", manifest.skills)

  const packages = new Map<string, string>()
  for (const [index, entry] of manifest.plugins.entries()) {
    const at = `plugins[${index}] (${entry.id || "missing id"})`

    if (entry.id.startsWith("internal:"))
      problems.push(`${at}: id must not start with "internal:", that prefix is reserved for built-in TUI plugins`)

    if (entry.source === "npm" || entry.source === "github") {
      if (!entry.package) problems.push(`${at}: ${entry.source} sources require "package"`)
      if (entry.package) {
        const seen = packages.get(entry.package)
        if (seen) problems.push(`${at}: package ${entry.package} is already bundled by ${seen}`)
        packages.set(entry.package, entry.id)
      }
      if (entry.path) problems.push(`${at}: "path" only applies to local sources`)
    }

    if (entry.source === "npm") {
      if (!entry.version) problems.push(`${at}: npm sources require an exact "version"`)
      else if (!semver.valid(entry.version))
        problems.push(`${at}: version ${entry.version} must be an exact semver, not a range`)
      if (entry.repo || entry.ref) problems.push(`${at}: "repo"/"ref" only apply to github sources`)
    }

    if (entry.source === "github") {
      if (!entry.repo) problems.push(`${at}: github sources require "repo" as owner/repo`)
      else if (!REPO_PATTERN.test(entry.repo)) problems.push(`${at}: repo ${entry.repo} must be owner/repo`)
      if (!entry.ref) problems.push(`${at}: github sources require "ref" as a full commit sha`)
      else if (!SHA_PATTERN.test(entry.ref))
        problems.push(`${at}: ref ${entry.ref} must be a full 40 character commit sha`)
      if (entry.version) problems.push(`${at}: "version" only applies to npm sources`)
    }

    if (entry.source === "local") {
      const file = entryPath(entry)
      if (!existsSync(path.join(ROOT, file))) problems.push(`${at}: local entrypoint vsworker/${file} does not exist`)
      if (entry.package || entry.version || entry.repo || entry.ref) {
        problems.push(`${at}: local sources only take "path"`)
      }
    }
  }

  for (const [index, entry] of manifest.mcp.entries()) {
    const at = `mcp[${index}] (${entry.id || "missing id"})`
    // `enabled` inside the definition would fight the per-user override that lives at the same key.
    if ("enabled" in entry.config) problems.push(`${at}: config.enabled is not allowed, set defaultEnabled instead`)
  }

  for (const [index, entry] of manifest.skills.entries()) {
    const at = `skills[${index}] (${entry.id || "missing id"})`
    const dir = skillDir(entry)
    const absolute = path.join(ROOT, dir)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      problems.push(`${at}: skill directory vsworker/${dir} does not exist`)
      continue
    }
    const file = path.join(absolute, "SKILL.md")
    if (!existsSync(file)) {
      problems.push(`${at}: vsworker/${dir}/SKILL.md does not exist`)
      continue
    }
    // The same parser the runtime uses, so a file that loads here loads there.
    const data = (() => {
      try {
        return ConfigMarkdown.parse(readFileSync(file, "utf8")).data as Record<string, unknown>
      } catch (error) {
        problems.push(`${at}: vsworker/${dir}/SKILL.md has invalid frontmatter (${String(error)})`)
        return undefined
      }
    })()
    if (!data) continue
    if (data.name !== entry.id) {
      problems.push(`${at}: SKILL.md frontmatter name is ${JSON.stringify(data.name)}, expected ${entry.id}`)
    }
    if (typeof data.description !== "string" || !data.description.trim()) {
      problems.push(`${at}: SKILL.md frontmatter needs a description, the model picks skills by it`)
    }

    // env.json is optional, but a malformed one exports nothing at runtime and would fail silently. The runtime
    // parser is used here so a file that loads at build time loads in the product too.
    const envFile = path.join(absolute, VsWorkerEnv.FILE)
    if (existsSync(envFile)) {
      const source = `vsworker/${dir}/${VsWorkerEnv.FILE}`
      for (const problem of VsWorkerEnv.parse(readFileSync(envFile, "utf8"), source).problems) {
        problems.push(`${at}: ${problem}`)
      }
    }
  }

  if (problems.length)
    throw new Error(["Invalid vsworker/bundle.jsonc:", ...problems.map((item) => `  - ${item}`)].join("\n"))
  return manifest
}

export function entryPath(entry: PluginEntry) {
  return entry.path ?? path.posix.join("plugins", entry.id, "index.ts")
}

export function skillDir(entry: SkillEntry) {
  return entry.path ?? path.posix.join("skills", entry.id)
}

export function included<T extends { enabled?: boolean }>(entries: readonly T[]) {
  return entries.filter((entry) => entry.enabled !== false)
}

export async function load(file = MANIFEST_FILE): Promise<Manifest> {
  const text = await Bun.file(file).text()
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`${file} is not valid JSONC (${errors.length} parse error(s))`)
  // onExcessProperty "error" turns a typo like "verison" into a loud failure instead of a silently ignored pin.
  const decoded = Schema.decodeUnknownSync(ManifestSchema)(data, { errors: "all", onExcessProperty: "error" })
  return validate({
    ...decoded,
    plugins: decoded.plugins ?? [],
    mcp: decoded.mcp ?? [],
    skills: decoded.skills ?? [],
  })
}

type JsonSchema = Record<string, unknown>

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Mirrors packages/opencode/script/schema.ts so the manifest schema reads the same way as the config schema.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value

  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))

  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (anyOf.length !== schema.anyOf.length) {
      const { anyOf: _, ...rest } = schema
      if (anyOf.length === 1 && isRecord(anyOf[0])) return normalize({ ...anyOf[0], ...rest })
      return { ...rest, anyOf }
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && isRecord(schema.allOf[0])) {
    const { allOf: _, ...rest } = schema
    return normalize({ ...schema.allOf[0], ...rest })
  }

  if (schema.type === "integer" && schema.maximum === undefined) {
    return { ...schema, maximum: Number.MAX_SAFE_INTEGER }
  }

  return schema
}

export function jsonSchema() {
  const document = Schema.toJsonSchemaDocument(ManifestSchema)
  const result = normalize({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  })
  if (!isRecord(result)) throw new Error("manifest schema generator produced a non-object schema")
  result.allowComments = true
  result.allowTrailingCommas = true
  return result
}
