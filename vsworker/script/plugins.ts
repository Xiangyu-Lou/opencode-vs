#!/usr/bin/env bun

import path from "path"
import { existsSync } from "fs"
import prettier from "prettier"
import semver from "semver"
import { applyEdits, modify } from "jsonc-parser"
import {
  MANIFEST_FILE,
  REPO,
  ROOT,
  SCHEMA_FILE,
  entryPath,
  included,
  jsonSchema,
  load,
  type Entry,
  type Kind,
  type Manifest,
} from "./manifest"

const SERVER_GEN = path.join(ROOT, "src", "server.gen.ts")
const TUI_GEN = path.join(ROOT, "src", "tui.gen.ts")
const PACKAGE_FILE = path.join(ROOT, "package.json")

// Dependencies the workspace always needs. Everything else in `dependencies` is owned by this generator.
const FIXED_DEPS = ["@opencode-ai/core", "@opencode-ai/plugin", "effect", "jsonc-parser", "semver"]

type Pkg = Record<string, unknown>

type Resolved = {
  entry: Entry
  kind: Kind
  // Module specifier the generated file imports, e.g. "opencode-foo/server" or "../plugins/hello/index.ts"
  specifier: string
  // Human-facing pin, e.g. "opencode-foo@1.2.3" or "vsworker/plugins/hello"
  spec: string
  name: string
  version: string
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

function dependencySpec(entry: Entry) {
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
  for (const entry of included(manifest)) {
    if (entry.source === "local") continue
    next[entry.package!] = dependencySpec(entry)
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
  const changed = JSON.stringify(current) !== JSON.stringify(sorted)
  pkg.dependencies = sorted
  return { text: JSON.stringify(pkg, null, 2) + "\n", changed }
}

async function resolveEntry(entry: Entry, hostVersion: string): Promise<Resolved> {
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

function literal(value: unknown) {
  return JSON.stringify(value)
}

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
      `mod: m${index}`,
    ]
    return `  { ${fields.join(", ")} },`
  })

  const code = [
    "// GENERATED by `bun run --cwd vsworker plugins generate` — edit vsworker/plugins.jsonc instead.",
    "// Star imports are deliberate: they capture both ESM and CJS namespaces uniformly, which the runtime",
    "// then normalizes in src/bundle.ts.",
    'import type { Raw } from "./bundle"',
    ...imports,
    "",
    `export const ${kind}: readonly Raw[] = [`,
    ...entries,
    "]",
    "",
  ].join("\n")

  return format(code, path.join(ROOT, "src", `${kind}.gen.ts`))
}

// The repo formatter (script/format.ts) runs over everything this generator writes, so format identically
// here or `plugins check` reports drift the moment someone formats the repo.
async function format(text: string, file: string) {
  const options = await prettier.resolveConfig(file)
  return prettier.format(text, { ...options, filepath: file })
}

async function build() {
  const manifest = await load()
  const hostPkg = await readJson(path.join(REPO, "packages", "opencode", "package.json"))
  const hostVersion = typeof hostPkg.version === "string" ? hostPkg.version : "0.0.0"

  const rows: Resolved[] = []
  for (const entry of included(manifest)) rows.push(await resolveEntry(entry, hostVersion))

  const server = rows.filter((row) => row.kind === "server")
  const tui = rows.filter((row) => row.kind === "tui")

  return {
    manifest,
    rows,
    files: {
      [SERVER_GEN]: await renderBundle("server", server),
      [TUI_GEN]: await renderBundle("tui", tui),
      [SCHEMA_FILE]: await format(JSON.stringify(jsonSchema(), null, 2), SCHEMA_FILE),
    } as Record<string, string>,
  }
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
  if (included(manifest).some((entry) => entry.source !== "local")) await install()

  const result = await build()
  for (const [file, text] of Object.entries(result.files)) {
    if (!(await changed(file, text))) continue
    await Bun.write(file, text)
    console.log(`wrote ${path.relative(REPO, file)}`)
  }
  for (const row of result.rows) for (const warning of row.warnings) console.warn(`warning: ${warning}`)
  console.log(`bundled ${result.rows.length} plugin(s)`)
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
    console.error("Generated output is stale. Run: bun run --cwd vsworker plugins generate")
    for (const item of drift) console.error(`  - ${item}`)
    process.exitCode = 1
    return
  }
  for (const row of result.rows) for (const warning of row.warnings) console.warn(`warning: ${warning}`)
  console.log(`bundle is up to date (${result.rows.length} plugin(s))`)
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

async function bump(id: string, target: string | undefined) {
  const manifest = await load()
  const index = manifest.plugins.findIndex((entry) => entry.id === id)
  if (index === -1) throw new Error(`no plugin with id ${id} in vsworker/plugins.jsonc`)
  const entry = manifest.plugins[index]
  if (!entry) throw new Error(`no plugin with id ${id} in vsworker/plugins.jsonc`)
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
  const edits = modify(original, ["plugins", index, key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  await Bun.write(MANIFEST_FILE, applyEdits(original, edits))
  console.log(`${id}: ${key} -> ${value}`)
  await generate()
}

// Seams are the only places the fork edits upstream files. Losing one during an upstream merge would silently
// drop the whole bundle, so CI asserts each marker is still present.
const SEAMS: { file: string; marker: string }[] = [
  { file: "packages/opencode/src/plugin/index.ts", marker: "vsworker-seam" },
  { file: "packages/core/src/v1/config/config.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/index.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/test/preload.ts", marker: "vsworker-seam" },
  { file: "packages/opencode/src/plugin/tui/runtime.ts", marker: "vsworker-seam" },
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
    console.log("vsworker/plugins.jsonc is valid")
    break
  case "schema":
    await Bun.write(SCHEMA_FILE, await format(JSON.stringify(jsonSchema(), null, 2), SCHEMA_FILE))
    console.log(`wrote ${path.relative(REPO, SCHEMA_FILE)}`)
    break
  case "outdated":
    await outdated()
    break
  case "bump":
    if (!rest[0]) throw new Error("usage: plugins bump <id> [version|sha]")
    await bump(rest[0], rest[1])
    break
  default:
    console.log("usage: plugins <generate|check [--seams]|validate|schema|outdated|bump <id> [version|sha]>")
    process.exitCode = command ? 1 : 0
}
