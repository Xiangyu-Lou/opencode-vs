#!/usr/bin/env bun

import path from "path"
import os from "os"
import { existsSync } from "fs"
import fs from "fs/promises"
import { createHash } from "crypto"
import prettier from "prettier"
import semver from "semver"
import { Schema } from "effect"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { VsWorkerEnv } from "../src/env"
import {
  MANIFEST_FILE,
  REPO,
  ROOT,
  SCHEMA_FILE,
  entryPath,
  included,
  jsonSchema,
  load,
  skillDir,
  type Kind,
  type Manifest,
  type McpEntry,
  type PluginEntry,
  type SkillEntry,
} from "./manifest"

const SERVER_GEN = path.join(ROOT, "src", "server.gen.ts")
const TUI_GEN = path.join(ROOT, "src", "tui.gen.ts")
const MCP_GEN = path.join(ROOT, "src", "mcp.gen.ts")
const SKILLS_GEN = path.join(ROOT, "src", "skills.gen.ts")
const PACKAGE_FILE = path.join(ROOT, "package.json")

// Dependencies the workspace always needs. Everything else in `dependencies` is owned by this generator.
const FIXED_DEPS = ["@opencode-ai/core", "@opencode-ai/plugin", "effect", "jsonc-parser", "semver"]

// A bundled skill is carried in the binary as inlined text, so a big file costs startup memory in every session.
const FILE_WARN_BYTES = 256 * 1024
const SKILL_WARN_BYTES = 1024 * 1024

// Editor and interpreter droppings that appear inside a skill directory but are not part of the skill. They are
// skipped rather than inlined: they differ per machine, so bundling them would make the skills hash -- and with
// it `bundle check` -- disagree between the machine that ran `generate` and the machine that runs CI.
const SKIP_DIRS = new Set(["__pycache__", ".git", ".DS_Store"])
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"])
const SKIP_EXTENSIONS = new Set([".pyc", ".pyo"])

const SECRET_KEY = /(token|secret|key|password|passwd|credential|auth)/i

type Pkg = Record<string, unknown>

type Resolved = {
  entry: PluginEntry
  kind: Kind
  // Module specifier the generated file imports, e.g. "opencode-foo/server" or "../plugins/hello/index.ts"
  specifier: string
  // Human-facing pin, e.g. "opencode-foo@1.2.3" or "vsworker/plugins/hello"
  spec: string
  name: string
  version: string
  warnings: string[]
}

type ResolvedMcp = {
  entry: McpEntry
  warnings: string[]
}

type SkillFile = {
  path: string
  encoding: "utf8" | "base64"
  executable: boolean
  data: string
}

type ResolvedSkill = {
  entry: SkillEntry
  files: SkillFile[]
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Same rules as resolvePackageEntrypoint in packages/opencode/src/plugin/shared.ts: a subpath export can be a
// string or an object whose "import"/"default" condition is one.
function exportValue(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined
  for (const key of ["import", "default"]) {
    const nested = value[key]
    if (typeof nested === "string") return nested
  }
  return undefined
}

function dependencySpec(entry: PluginEntry) {
  if (entry.source === "npm") return entry.version!
  return `github:${entry.repo}#${entry.ref}`
}

async function readJson(file: string): Promise<Pkg> {
  const data: unknown = await Bun.file(file).json()
  if (!isRecord(data)) throw new Error(`${file} is not a JSON object`)
  return data
}

async function latestVersion(pkg: string) {
  const response = await fetch(`https://registry.npmjs.org/${pkg}`)
  if (!response.ok) throw new Error(`npm registry lookup for ${pkg} failed with ${response.status}`)
  const data: unknown = await response.json()
  if (!isRecord(data)) return undefined
  const tags = data["dist-tags"]
  if (!isRecord(tags)) return undefined
  const latest = tags["latest"]
  return typeof latest === "string" ? latest : undefined
}

async function remoteHead(repo: string) {
  const proc = Bun.spawn(["git", "ls-remote", `https://github.com/${repo}`, "HEAD"], { stdout: "pipe" })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text.trim().split(/\s+/)[0]
}

async function writeDependencies(manifest: Manifest) {
  const pkg = await readJson(PACKAGE_FILE)
  const current = isRecord(pkg.dependencies) ? pkg.dependencies : {}
  const next: Record<string, string> = {}
  for (const name of FIXED_DEPS) {
    const value = current[name]
    if (typeof value !== "string") throw new Error(`vsworker/package.json is missing the fixed dependency ${name}`)
    next[name] = value
  }
  for (const entry of included(manifest.plugins)) {
    if (entry.source === "local") continue
    next[entry.package!] = dependencySpec(entry)
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
  const changed = JSON.stringify(current) !== JSON.stringify(sorted)
  pkg.dependencies = sorted
  return { text: JSON.stringify(pkg, null, 2) + "\n", changed }
}

async function resolveEntry(entry: PluginEntry, hostVersion: string): Promise<Resolved> {
  const warnings: string[] = []

  if (entry.source === "local") {
    const file = entryPath(entry)
    const specifier = path.posix.join("..", file.split(path.sep).join("/"))
    return {
      entry,
      kind: entry.kind ?? "server",
      specifier,
      spec: `vsworker/${file}`,
      name: entry.id,
      version: "0.0.0",
      warnings,
    }
  }

  const name = entry.package!
  const dir = path.join(ROOT, "node_modules", name)
  const manifestFile = path.join(dir, "package.json")
  if (!existsSync(manifestFile)) {
    throw new Error(`${name} is not installed in vsworker/node_modules. Run bun install and try again.`)
  }
  const pkg = await readJson(manifestFile)
  if (pkg.name !== name) throw new Error(`${manifestFile} declares name ${String(pkg.name)}, expected ${name}`)
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0"

  if (entry.source === "npm" && entry.version && version !== entry.version) {
    throw new Error(`${name} resolved to ${version} but the manifest pins ${entry.version}. Run bun install.`)
  }

  const exports = isRecord(pkg.exports) ? pkg.exports : undefined
  const serverExport = exports ? exportValue(exports["./server"]) : undefined
  const tuiExport = exports ? exportValue(exports["./tui"]) : undefined
  const main = typeof pkg.main === "string" && pkg.main.trim() ? pkg.main.trim() : undefined

  const detected: Kind | undefined = serverExport ? "server" : tuiExport ? "tui" : main ? "server" : undefined
  const kind = entry.kind ?? detected
  if (!kind) {
    throw new Error(
      `${name} exposes no plugin entrypoint. Expected exports["./server"], exports["./tui"], or a package.json main.`,
    )
  }

  const specifier = (() => {
    if (kind === "tui") {
      if (!tuiExport) throw new Error(`${name} has no exports["./tui"] entrypoint`)
      return `${name}/tui`
    }
    if (serverExport) return `${name}/server`
    if (!main) throw new Error(`${name} has no exports["./server"] entrypoint and no package.json main`)
    if (exports && !exports["."]) {
      throw new Error(`${name} defines an exports map without "." so its main field is not importable`)
    }
    return name
  })()

  // Same gate as checkPluginCompatibility in packages/opencode/src/plugin/shared.ts, downgraded to a warning:
  // the fork controls the pin, so a mismatch is a decision for a human, not a build failure.
  const engines = isRecord(pkg.engines) ? pkg.engines : undefined
  const range = engines && typeof engines.opencode === "string" ? engines.opencode : undefined
  if (range && semver.valid(hostVersion) && !semver.satisfies(hostVersion, range)) {
    warnings.push(`${name} declares engines.opencode ${range} but the host is ${hostVersion}`)
  }
  if (existsSync(path.join(dir, "node_modules", "@opencode-ai", "plugin"))) {
    warnings.push(`${name} pulls its own copy of @opencode-ai/plugin, so the SDK is duplicated in the bundle`)
  }

  return { entry, kind, specifier, spec: `${name}@${version}`, name, version, warnings }
}

function placeheld(value: string) {
  return value.includes("{env:") || value.includes("{file:")
}

// A bundled definition is compiled into every copy of the build, so a literal credential here is shipped to
// everyone who installs it. Placeholders are resolved per machine at config load instead.
function resolveMcp(entry: McpEntry): ResolvedMcp {
  const warnings: string[] = []
  const at = `mcp ${entry.id}`

  if (entry.config.type === "remote") {
    for (const [key, value] of Object.entries(entry.config.headers ?? {})) {
      if (!placeheld(value)) warnings.push(`${at}: header ${key} is a literal value compiled into every build`)
    }
    const oauth = entry.config.oauth
    if (oauth && oauth.clientSecret && !placeheld(oauth.clientSecret)) {
      warnings.push(`${at}: oauth.clientSecret is a literal value compiled into every build`)
    }
  }

  if (entry.config.type === "local") {
    for (const [key, value] of Object.entries(entry.config.environment ?? {})) {
      if (SECRET_KEY.test(key) && !placeheld(value)) {
        warnings.push(`${at}: environment.${key} looks like a secret and is compiled into every build`)
      }
    }
    warnings.push(`${at}: local server, ${entry.config.command[0]} has to exist on every user's machine`)
  }

  return { entry, warnings }
}

// Copy of isSafeRelativePath in packages/core/src/skill/discovery.ts. The runtime applies it to skills pulled
// from a URL; a vendored skill gets the same treatment so a path that cannot be materialized is caught here.
function isSafeRelativePath(value: string) {
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
    if (SKIP_FILES.has(entry.name) || SKIP_EXTENSIONS.has(path.extname(entry.name))) continue
    if (entry.isFile()) result.push(relative)
  }
  return result
}

async function resolveSkill(entry: SkillEntry): Promise<ResolvedSkill> {
  const warnings: string[] = []
  const dir = skillDir(entry)
  const absolute = path.join(ROOT, dir)
  const names = (await walk(absolute)).sort()

  const files: SkillFile[] = []
  let total = 0
  for (const name of names) {
    if (!isSafeRelativePath(name)) throw new Error(`${dir}/${name} is not a safe relative path`)
    const file = path.join(absolute, ...name.split("/"))
    const buffer = await fs.readFile(file)
    const stat = await fs.stat(file)
    // A NUL byte or a failed UTF-8 round trip means the bytes are not text, so carry them as base64.
    const text = buffer.toString("utf8")
    const binary = buffer.includes(0) || !Buffer.from(text, "utf8").equals(buffer)
    total += buffer.byteLength
    if (buffer.byteLength > FILE_WARN_BYTES) {
      warnings.push(`skill ${entry.id}: ${name} is ${Math.round(buffer.byteLength / 1024)} KiB, inlined into the build`)
    }
    files.push({
      path: name,
      encoding: binary ? "base64" : "utf8",
      executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0,
      data: binary ? buffer.toString("base64") : text,
    })
  }

  if (total > SKILL_WARN_BYTES) {
    warnings.push(`skill ${entry.id}: ${Math.round(total / 1024)} KiB total, inlined into the build`)
  }

  // env.json is compiled into every copy of the build, exactly like an MCP `environment` block, so a literal
  // credential in it ships to everyone. {env:VAR} and {file:path} are substituted per machine at load time.
  const env = files.find((file) => file.path === VsWorkerEnv.FILE)
  if (env && env.encoding === "utf8") {
    for (const [key, value] of Object.entries(VsWorkerEnv.parse(env.data, `${dir}/${VsWorkerEnv.FILE}`).values)) {
      if (SECRET_KEY.test(key) && value && !placeheld(value)) {
        warnings.push(`skill ${entry.id}: env.json ${key} looks like a secret and is compiled into every build`)
      }
    }
  }

  return { entry, files, warnings }
}

// The hash decides whether a running build re-materializes the cache directory. `executable` is part of it so a
// chmod alone still invalidates.
function hashSkills(rows: ResolvedSkill[]) {
  const hash = createHash("sha256")
  const lines: string[] = []
  for (const row of rows) {
    for (const file of row.files) {
      lines.push(JSON.stringify([row.entry.id, file.path, file.encoding, file.executable, file.data]))
    }
  }
  for (const line of lines.sort()) hash.update(line + "\n")
  return hash.digest("hex")
}

function literal(value: unknown) {
  return JSON.stringify(value)
}

const HEADER = "// GENERATED by `bun run --cwd vsworker bundle generate` — edit vsworker/bundle.jsonc instead."

async function renderBundle(kind: Kind, rows: Resolved[]) {
  const imports = rows.map((row, index) => `import * as m${index} from ${literal(row.specifier)}`)
  const entries = rows.map((row, index) => {
    const fields = [
      `id: ${literal(row.entry.id)}`,
      `source: ${literal(row.entry.source)}`,
      `spec: ${literal(row.spec)}`,
      `pkg: { name: ${literal(row.name)}, version: ${literal(row.version)} }`,
      `options: ${row.entry.options ? literal(row.entry.options) : "undefined"}`,
      `defaultEnabled: ${row.entry.defaultEnabled !== false}`,
      `description: ${row.entry.description ? literal(row.entry.description) : "undefined"}`,
      `mod: m${index}`,
    ]
    return `  { ${fields.join(", ")} },`
  })

  const code = [
    HEADER,
    "// Star imports are deliberate: they capture both ESM and CJS namespaces uniformly, which the runtime",
    "// then normalizes in src/plugins.ts.",
    'import type { Raw } from "./plugins"',
    ...imports,
    "",
    `export const ${kind}: readonly Raw[] = [`,
    ...entries,
    "]",
    "",
  ].join("\n")

  return format(code, path.join(ROOT, "src", `${kind}.gen.ts`))
}

async function renderMcp(rows: ResolvedMcp[]) {
  const entries = rows.map((row) => {
    const fields = [
      `id: ${literal(row.entry.id)}`,
      `defaultEnabled: ${row.entry.defaultEnabled !== false}`,
      `description: ${row.entry.description ? literal(row.entry.description) : "undefined"}`,
      `config: ${literal(row.entry.config)}`,
    ]
    return `  { ${fields.join(", ")} },`
  })

  const code = [
    HEADER,
    'import type { Raw } from "./mcp"',
    "",
    "export const mcp: readonly Raw[] = [",
    ...entries,
    "]",
    "",
  ].join("\n")

  return format(code, MCP_GEN)
}

async function renderSkills(rows: ResolvedSkill[], hash: string) {
  const entries = rows.flatMap((row) => {
    const files = row.files.map((file) => {
      const fields = [
        `path: ${literal(file.path)}`,
        `encoding: ${literal(file.encoding)}`,
        `executable: ${file.executable}`,
        `data: ${literal(file.data)}`,
      ]
      return `      { ${fields.join(", ")} },`
    })
    return [
      "  {",
      `    id: ${literal(row.entry.id)},`,
      `    defaultEnabled: ${row.entry.defaultEnabled !== false},`,
      `    description: ${row.entry.description ? literal(row.entry.description) : "undefined"},`,
      "    files: [",
      ...files,
      "    ],",
      "  },",
    ]
  })

  const code = [
    HEADER,
    "// Skill files are inlined rather than imported as assets so the same module works under `bun dev`, inside the",
    "// compiled binary, and inside the Node desktop bundle. The runtime writes them to the cache dir on first use.",
    'import type { Raw } from "./skills"',
    "",
    `export const hash = ${literal(hash)}`,
    "",
    "export const skills: readonly Raw[] = [",
    ...entries,
    "]",
    "",
  ].join("\n")

  return format(code, SKILLS_GEN)
}

// The repo formatter (script/format.ts) runs over everything this generator writes, so format identically
// here or `bundle check` reports drift the moment someone formats the repo.
async function format(text: string, file: string) {
  const options = await prettier.resolveConfig(file)
  return prettier.format(text, { ...options, filepath: file })
}

async function build() {
  const manifest = await load()
  const hostPkg = await readJson(path.join(REPO, "packages", "opencode", "package.json"))
  const hostVersion = typeof hostPkg.version === "string" ? hostPkg.version : "0.0.0"

  const rows: Resolved[] = []
  for (const entry of included(manifest.plugins)) rows.push(await resolveEntry(entry, hostVersion))

  const mcpRows = included(manifest.mcp).map(resolveMcp)

  const skillRows: ResolvedSkill[] = []
  for (const entry of included(manifest.skills)) skillRows.push(await resolveSkill(entry))
  const hash = hashSkills(skillRows)

  const server = rows.filter((row) => row.kind === "server")
  const tui = rows.filter((row) => row.kind === "tui")

  return {
    manifest,
    warnings: [...rows, ...mcpRows, ...skillRows].flatMap((row) => row.warnings),
    counts: { plugins: rows.length, mcp: mcpRows.length, skills: skillRows.length },
    files: {
      [SERVER_GEN]: await renderBundle("server", server),
      [TUI_GEN]: await renderBundle("tui", tui),
      [MCP_GEN]: await renderMcp(mcpRows),
      [SKILLS_GEN]: await renderSkills(skillRows, hash),
      [SCHEMA_FILE]: await format(JSON.stringify(jsonSchema(), null, 2), SCHEMA_FILE),
    } as Record<string, string>,
  }
}

function summary(counts: { plugins: number; mcp: number; skills: number }) {
  return `${counts.plugins} plugin(s), ${counts.mcp} MCP server(s), ${counts.skills} skill(s)`
}

async function install() {
  const proc = Bun.spawn(["bun", "install"], { cwd: REPO, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`bun install failed with exit code ${code}`)
}

async function changed(file: string, text: string) {
  if (!existsSync(file)) return true
  return (await Bun.file(file).text()) !== text
}

async function generate() {
  const manifest = await load()
  const deps = await writeDependencies(manifest)
  if (deps.changed) {
    await Bun.write(PACKAGE_FILE, deps.text)
    console.log("updated vsworker/package.json dependencies")
  }
  if (included(manifest.plugins).some((entry) => entry.source !== "local")) await install()

  const result = await build()
  for (const [file, text] of Object.entries(result.files)) {
    if (!(await changed(file, text))) continue
    await Bun.write(file, text)
    console.log(`wrote ${path.relative(REPO, file)}`)
  }
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  console.log(`bundled ${summary(result.counts)}`)
}

async function check() {
  const manifest = await load()
  const deps = await writeDependencies(manifest)
  const result = await build()
  const drift: string[] = []
  if (deps.changed) drift.push("vsworker/package.json dependencies")
  for (const [file, text] of Object.entries(result.files)) {
    if (await changed(file, text)) drift.push(path.relative(REPO, file))
  }
  if (drift.length) {
    console.error("Generated output is stale. Run: bun run --cwd vsworker bundle generate")
    for (const item of drift) console.error(`  - ${item}`)
    process.exitCode = 1
    return
  }
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  console.log(`bundle is up to date (${summary(result.counts)})`)
}

async function outdated() {
  const manifest = await load()
  const rows: string[] = []
  for (const entry of manifest.plugins) {
    if (entry.source === "npm") {
      const latest = await latestVersion(entry.package!).catch(() => undefined)
      const stale = latest && entry.version && semver.valid(latest) && semver.gt(latest, entry.version)
      const status = !latest ? "lookup failed" : stale ? `${latest} available` : "up to date"
      rows.push(`${entry.id}\tnpm\t${entry.version}\t${status}`)
      continue
    }
    if (entry.source === "github") {
      const head = await remoteHead(entry.repo!).catch(() => undefined)
      const status = !head ? "lookup failed" : head === entry.ref ? "up to date" : `${head.slice(0, 12)} available`
      rows.push(`${entry.id}\tgithub\t${entry.ref?.slice(0, 12)}\t${status}`)
    }
  }
  console.log(rows.length ? rows.join("\n") : "no npm or github plugins to check")
}

const FORMATTING = { insertSpaces: true, tabSize: 2 }

async function patchManifest(path: (string | number)[], value: unknown) {
  const original = await Bun.file(MANIFEST_FILE).text()
  const edits = modify(original, path, value, { isArrayInsertion: true, formattingOptions: FORMATTING })
  await Bun.write(MANIFEST_FILE, await format(applyEdits(original, edits), MANIFEST_FILE))
}

async function bump(id: string, target: string | undefined) {
  const manifest = await load()
  const index = manifest.plugins.findIndex((entry) => entry.id === id)
  if (index === -1) throw new Error(`no plugin with id ${id} in vsworker/bundle.jsonc`)
  const entry = manifest.plugins[index]
  if (!entry) throw new Error(`no plugin with id ${id} in vsworker/bundle.jsonc`)
  if (entry.source === "local") throw new Error(`${id} is a local plugin, there is nothing to bump`)

  const value = await (async () => {
    if (target) return target
    if (entry.source === "npm") {
      const latest = await latestVersion(entry.package!)
      if (!latest) throw new Error(`could not read the latest version of ${entry.package}`)
      return latest
    }
    const head = await remoteHead(entry.repo!)
    if (!head) throw new Error(`could not read HEAD of ${entry.repo}`)
    return head
  })()

  const key = entry.source === "npm" ? "version" : "ref"
  const original = await Bun.file(MANIFEST_FILE).text()
  const edits = modify(original, ["plugins", index, key], value, { formattingOptions: FORMATTING })
  await Bun.write(MANIFEST_FILE, applyEdits(original, edits))
  console.log(`${id}: ${key} -> ${value}`)
  await generate()
}

// Resolved the same way xdg-basedir does it, rather than by importing @opencode-ai/core/global, which creates
// directories as a side effect of being imported. Keep the directory name in step with `app` in
// packages/core/src/global.ts.
function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "vsworker")
}

function configFile(from: string | undefined) {
  if (from) {
    if (!existsSync(from)) throw new Error(`${from} does not exist`)
    return from
  }
  const dir = configDir()
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no opencode config file found in ${dir}. Pass --from <file>.`)
}

function flag(rest: string[], name: string) {
  const index = rest.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = rest[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`)
  return value
}

// Accepts either the flat V1 shape (mcp.<name>) or the V2 envelope (mcp.servers.<name>), the same two shapes the
// config loader accepts, and lowers V2 to V1 the way packages/opencode/src/config/v2-compat.ts does.
function readMcpServer(text: string, name: string) {
  const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true })
  const mcp = isRecord(parsed) && isRecord(parsed.mcp) ? parsed.mcp : undefined
  if (!mcp) throw new Error(`no "mcp" block in the config file`)
  const direct = mcp[name]
  if (isRecord(direct) && "type" in direct) return { raw: direct, v2: false }
  const servers = mcp.servers
  // A server literally named "servers" is legal V1, so only treat it as the V2 envelope when it is not one.
  const nested = isRecord(servers) && !("type" in servers) ? servers[name] : undefined
  if (isRecord(nested)) return { raw: nested, v2: true }
  throw new Error(`no MCP server named ${name} in the config file`)
}

function lowerMcpServer(raw: Record<string, unknown>, warnings: string[]) {
  const result: Record<string, unknown> = { ...raw }

  if ("disabled" in result) {
    result.enabled = result.disabled !== true
    delete result.disabled
  }
  if ("codemode" in result) {
    warnings.push("codemode has no V1 equivalent and was dropped")
    delete result.codemode
  }
  if (isRecord(result.timeout)) {
    const timeout = result.timeout
    if (timeout.startup !== undefined) warnings.push("timeout.startup has no V1 equivalent and was dropped")
    result.timeout = typeof timeout.request === "number" ? timeout.request : undefined
    if (result.timeout === undefined) delete result.timeout
  }
  if (isRecord(result.oauth)) {
    const oauth = result.oauth
    const renames: Record<string, string> = {
      client_id: "clientId",
      client_secret: "clientSecret",
      callback_port: "callbackPort",
      redirect_uri: "redirectUri",
    }
    const lowered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(oauth)) lowered[renames[key] ?? key] = value
    result.oauth = lowered
  }

  return result
}

async function importMcp(name: string, rest: string[]) {
  const manifest = await load()
  const id = flag(rest, "id") ?? name
  if (manifest.mcp.some((entry) => entry.id === id)) {
    throw new Error(`${id} is already bundled. Edit vsworker/bundle.jsonc or pass --id <other>.`)
  }

  const file = configFile(flag(rest, "from"))
  const warnings: string[] = []
  const found = readMcpServer(await Bun.file(file).text(), name)
  const lowered = lowerMcpServer(found.raw, warnings)

  const enabled = lowered.enabled
  delete lowered.enabled
  const defaultEnabled = rest.includes("--off") ? false : enabled !== false

  const config = Schema.decodeUnknownSync(ConfigMCPV1.Info)(lowered, { errors: "all", onExcessProperty: "error" })
  const entry: Record<string, unknown> = { id, config }
  if (!defaultEnabled) entry.defaultEnabled = false

  for (const warning of resolveMcp({ id, config, defaultEnabled } as McpEntry).warnings) warnings.push(warning)
  for (const warning of warnings) console.warn(`warning: ${warning}`)

  await patchManifest(["mcp", -1], entry)
  console.log(`imported ${name} from ${file} as mcp ${id}${defaultEnabled ? "" : " (off by default)"}`)
  await generate()
}

async function importSkill(name: string, rest: string[]) {
  const manifest = await load()
  if (manifest.skills.some((entry) => entry.id === name)) {
    throw new Error(`${name} is already bundled. Edit vsworker/bundle.jsonc instead.`)
  }

  const from = flag(rest, "from")
  const source = (() => {
    if (from) return from
    const dir = configDir()
    for (const parent of ["skills", "skill"]) {
      const candidate = path.join(dir, parent, name)
      if (existsSync(candidate)) return candidate
    }
    throw new Error(`no skill named ${name} under ${dir}/skills or ${dir}/skill. Pass --from <dir>.`)
  })()

  const file = path.join(source, "SKILL.md")
  if (!existsSync(file)) throw new Error(`${file} does not exist`)
  const data = ConfigMarkdown.parse(await Bun.file(file).text()).data as Record<string, unknown>
  if (data.name !== name) {
    throw new Error(`${file} declares name ${JSON.stringify(data.name)}, expected ${name}`)
  }

  const dest = path.join(ROOT, "skills", name)
  if (existsSync(dest)) {
    if (!rest.includes("--force")) throw new Error(`vsworker/skills/${name} already exists. Pass --force to replace.`)
    await fs.rm(dest, { recursive: true, force: true })
  }
  await fs.cp(source, dest, { recursive: true, dereference: false })

  const entry: Record<string, unknown> = { id: name }
  if (typeof data.description === "string") entry.description = data.description
  await patchManifest(["skills", -1], entry)
  console.log(`imported ${name} from ${source} into vsworker/skills/${name}`)
  await generate()
}

// Seams are the only places the fork edits upstream files. Losing one during an upstream merge would silently
// drop part of the bundle, so CI asserts each marker is still present.
const SEAMS: { file: string; marker: string }[] = [
  { file: "packages/opencode/src/plugin/index.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/plugin/tui/runtime.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/config/config.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/skill/index.ts", marker: "vsworker-seam" },
  { file: "packages/core/src/v1/config/config.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/index.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/test/preload.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/tool/shell.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/tool/skill.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/test/tool/shell.test.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/installation/index.ts", marker: "vsworker-seam" },
  { file: "packages/core/src/global.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/test/cli/mcp-add.test.ts", marker: "vsworker-seam" },
  // Management UI: routes, handlers, route coverage, the settings dialog, the app dictionary, and the
  // provider picker order.
  { file: "packages/opencode/src/server/routes/instance/httpapi/api.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/server/routes/instance/httpapi/server.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/test/server/httpapi-exercise/index.ts", marker: "vsworker-seam" },
  { file: "packages/app/src/components/settings-v2/dialog-settings-v2.tsx", marker: "vsworker-seam" },
  { file: "packages/app/src/context/language.tsx", marker: "vsworker-seam" },
  { file: "packages/app/src/components/dialog-connect-provider.tsx", marker: "vsworker-seam" },
]

async function seams() {
  const missing: string[] = []
  for (const seam of SEAMS) {
    const file = path.join(REPO, seam.file)
    if (!existsSync(file)) {
      missing.push(`${seam.file} (file is gone)`)
      continue
    }
    const text = await Bun.file(file).text()
    if (!text.includes(seam.marker)) missing.push(seam.file)
  }
  if (missing.length) {
    console.error("Missing vsworker seams, an upstream merge probably dropped them:")
    for (const item of missing) console.error(`  - ${item}`)
    process.exitCode = 1
    return
  }
  console.log(`all ${SEAMS.length} seams present`)
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case "generate":
    await generate()
    break
  case "check":
    if (rest.includes("--seams")) await seams()
    else await check()
    break
  case "validate":
    await load()
    console.log("vsworker/bundle.jsonc is valid")
    break
  case "schema":
    await Bun.write(SCHEMA_FILE, await format(JSON.stringify(jsonSchema(), null, 2), SCHEMA_FILE))
    console.log(`wrote ${path.relative(REPO, SCHEMA_FILE)}`)
    break
  case "outdated":
    await outdated()
    break
  case "bump":
    if (!rest[0]) throw new Error("usage: bundle bump <id> [version|sha]")
    await bump(rest[0], rest[1])
    break
  case "import":
    if (rest[0] === "mcp") {
      if (!rest[1]) throw new Error("usage: bundle import mcp <name> [--from <file>] [--id <id>] [--off]")
      await importMcp(rest[1], rest.slice(2))
      break
    }
    if (rest[0] === "skill") {
      if (!rest[1]) throw new Error("usage: bundle import skill <name> [--from <dir>] [--force]")
      await importSkill(rest[1], rest.slice(2))
      break
    }
    throw new Error("usage: bundle import <mcp|skill> <name> [options]")
  default:
    console.log(
      "usage: bundle <generate|check [--seams]|validate|schema|outdated|bump <id> [version|sha]|import mcp <name> [--from <file>] [--id <id>] [--off]|import skill <name> [--from <dir>] [--force]>",
    )
    process.exitCode = command ? 1 : 0
}
