import path from "path"
import { existsSync } from "fs"
import { Schema } from "effect"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import semver from "semver"

export const ROOT = path.resolve(import.meta.dirname, "..")
export const REPO = path.resolve(ROOT, "..")
export const MANIFEST_FILE = path.join(ROOT, "plugins.jsonc")
export const SCHEMA_FILE = path.join(ROOT, "plugins.schema.json")

export const Source = Schema.Literals(["npm", "github", "local"])
export type Source = Schema.Schema.Type<typeof Source>

export const Kind = Schema.Literals(["server", "tui"])
export type Kind = Schema.Schema.Type<typeof Kind>

export const Entry = Schema.Struct({
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
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Include this plugin in the build. Defaults to true. False removes it from the bundle entirely",
  }),
  defaultEnabled: Schema.optional(Schema.Boolean).annotate({
    description: "Run this plugin unless a user turns it off. Defaults to true",
  }),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Options passed to the plugin, overridable per user in opencode.json",
  }),
  description: Schema.optional(Schema.String).annotate({ description: "Why this plugin is bundled" }),
})
export type Entry = Schema.Schema.Type<typeof Entry>

export const Manifest = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  plugins: Schema.mutable(Schema.Array(Entry)).annotate({ description: "Plugins bundled into VsWorker builds" }),
}).annotate({ identifier: "VsWorkerPlugins" })
export type Manifest = Schema.Schema.Type<typeof Manifest>

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const SHA_PATTERN = /^[0-9a-f]{40}$/

// Entries are validated beyond the schema because the required fields depend on `source`, and because
// a bad pin only shows up much later as a confusing install or bundling failure.
export function validate(manifest: Manifest) {
  const problems: string[] = []
  const ids = new Set<string>()
  const packages = new Map<string, string>()

  for (const [index, entry] of manifest.plugins.entries()) {
    const at = `plugins[${index}] (${entry.id || "missing id"})`

    if (!ID_PATTERN.test(entry.id)) problems.push(`${at}: id must match ${ID_PATTERN}`)
    if (entry.id.startsWith("internal:"))
      problems.push(`${at}: id must not start with "internal:", that prefix is reserved for built-in TUI plugins`)
    if (ids.has(entry.id)) problems.push(`${at}: duplicate id`)
    ids.add(entry.id)

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

  if (problems.length)
    throw new Error(["Invalid vsworker/plugins.jsonc:", ...problems.map((item) => `  - ${item}`)].join("\n"))
  return manifest
}

export function entryPath(entry: Entry) {
  return entry.path ?? path.posix.join("plugins", entry.id, "index.ts")
}

export function included(manifest: Manifest) {
  return manifest.plugins.filter((entry) => entry.enabled !== false)
}

export async function load(file = MANIFEST_FILE): Promise<Manifest> {
  const text = await Bun.file(file).text()
  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`${file} is not valid JSONC (${errors.length} parse error(s))`)
  // onExcessProperty "error" turns a typo like "verison" into a loud failure instead of a silently ignored pin.
  const manifest = Schema.decodeUnknownSync(Manifest)(data, { errors: "all", onExcessProperty: "error" })
  return validate(manifest)
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
  const document = Schema.toJsonSchemaDocument(Manifest)
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
