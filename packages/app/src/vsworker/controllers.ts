// vsworker-seam: pure helpers behind the management tabs. Kept free of Solid so they can be unit tested with
// an injected translator, the way settings-v2/general-controllers.ts is.
import type { BundledState, McpConfig, Origin, Scope, UserMcp, UserPlugin, UserSkill } from "./api"

export type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

export function stateLabel(t: Translate, state: BundledState, kind: "plugin" | "skill" | "mcp") {
  if (state === "enabled") return t("vsworker.state.enabled")
  if (state === "disabled-by-config") return t("vsworker.state.disabled")
  if (state === "disabled-by-default") return t("vsworker.state.offByDefault")
  if (state === "killed") return t("vsworker.state.killed")
  if (kind === "plugin") return t("vsworker.state.shadowedPlugin")
  if (kind === "mcp") return t("vsworker.state.shadowedMcp")
  return t("vsworker.state.shadowedSkill")
}

export function stateTone(state: BundledState): "on" | "off" | "warn" {
  if (state === "enabled") return "on"
  if (state === "shadowed") return "warn"
  return "off"
}

export function isOn(state: BundledState) {
  return state === "enabled"
}

// A killed or shadowed entry cannot be switched on from here: the kill switch is an environment variable and
// the shadow is the user's own declaration, neither of which this dialog owns.
export function toggleDisabled(state: BundledState) {
  return state === "killed" || state === "shadowed"
}

export function originLabel(t: Translate, origin: Origin) {
  return t(`vsworker.origin.${origin}`)
}

export function statusTone(status: { status: string } | undefined) {
  if (!status) return "idle"
  if (status.status === "connected") return "ok"
  if (status.status === "failed") return "error"
  if (status.status === "needs_auth" || status.status === "needs_client_registration") return "warn"
  return "idle"
}

export function statusLabel(t: Translate, status: { status: string } | undefined) {
  if (!status) return undefined
  if (status.status === "needs_client_registration") return t("mcp.status.failed")
  return t(`mcp.status.${status.status}`)
}

export function matches(query: string, ...fields: (string | undefined)[]) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return fields.some((field) => field?.toLowerCase().includes(needle))
}

export function filterPlugins<T extends { id?: string; name?: string; spec?: string; description?: string }>(
  rows: T[],
  query: string,
) {
  return rows.filter((row) => matches(query, row.id, row.name, row.spec, row.description))
}

export function filterSkills<T extends { id?: string; name?: string; description?: string }>(rows: T[], query: string) {
  return rows.filter((row) => matches(query, row.id, row.name, row.description))
}

export function filterMcp<T extends { id?: string; name?: string; target?: string; description?: string }>(
  rows: T[],
  query: string,
) {
  return rows.filter((row) => matches(query, row.id, row.name, row.target, row.description))
}

// Rows the user can act on in the scope they are editing. Anything declared elsewhere stays visible but is
// labelled with where it came from instead of offering an edit that would silently write to another file.
export function actionable(row: { scope?: Scope }, scope: Scope) {
  return row.scope === scope
}

export function userPluginRows(rows: UserPlugin[], query: string) {
  return filterPlugins(rows, query).sort((a, b) => a.name.localeCompare(b.name))
}

export function userSkillRows(rows: UserSkill[], query: string) {
  return filterSkills(rows, query).filter((row) => row.editable)
}

export function discoveredSkillRows(rows: UserSkill[], query: string) {
  return filterSkills(rows, query).filter((row) => !row.editable)
}

export function userMcpRows(rows: UserMcp[], query: string) {
  return filterMcp(rows, query).sort((a, b) => a.name.localeCompare(b.name))
}

// ------------------------------------------------------------------------------------------ skill form

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export type SkillForm = { name: string; description: string; content: string }
export type SkillErrors = Partial<Record<keyof SkillForm, string>>

export function validateSkill(t: Translate, form: SkillForm): SkillErrors {
  const errors: SkillErrors = {}
  const name = form.name.trim()
  if (!name || name.length > 64 || !SKILL_NAME.test(name)) errors.name = t("vsworker.skills.nameInvalid")
  if (!form.description.trim()) errors.description = t("vsworker.skills.descriptionRequired")
  if (!form.content.trim()) errors.content = t("vsworker.skills.contentRequired")
  return errors
}

// A name typed as a title still produces a usable directory name, which is friendlier than rejecting it.
export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
}

// ------------------------------------------------------------------------------------------ mcp form

export type McpForm = {
  name: string
  type: "local" | "remote"
  command: string
  cwd: string
  url: string
  environment: string
  headers: string
  timeout: string
}

export type McpErrors = Partial<Record<keyof McpForm, string>>

export function emptyMcpForm(): McpForm {
  return { name: "", type: "local", command: "", cwd: "", url: "", environment: "", headers: "", timeout: "" }
}

// Split a command line into argv, honouring quotes so a path with a space survives.
export function splitCommand(value: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let seen = false
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      seen = true
      continue
    }
    if (/\s/.test(char)) {
      if (current || seen) out.push(current)
      current = ""
      seen = false
      continue
    }
    current += char
  }
  if (current || seen) out.push(current)
  return out
}

export function parsePairs(value: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of value.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf(separator)
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const item = trimmed.slice(index + 1).trim()
    if (key) out[key] = item
  }
  return out
}

export function renderPairs(value: Record<string, string> | undefined, separator: "=" | ": ") {
  if (!value) return ""
  return Object.entries(value)
    .map(([key, item]) => `${key}${separator}${item}`)
    .join("\n")
}

export function validateMcp(t: Translate, form: McpForm, taken: string[] = []): McpErrors {
  const errors: McpErrors = {}
  const name = form.name.trim()
  if (!name) errors.name = t("vsworker.mcp.nameInvalid")
  else if (taken.includes(name)) errors.name = t("vsworker.mcp.nameTaken")
  if (form.type === "local") {
    if (!splitCommand(form.command).length) errors.command = t("vsworker.mcp.commandRequired")
  } else {
    const url = form.url.trim()
    if (!url) errors.url = t("vsworker.mcp.urlRequired")
    else if (!/^https?:\/\/\S+$/i.test(url)) errors.url = t("vsworker.mcp.urlInvalid")
  }
  const timeout = form.timeout.trim()
  if (timeout && !/^\d+$/.test(timeout)) errors.timeout = t("vsworker.mcp.timeoutInvalid")
  return errors
}

export function toMcpConfig(form: McpForm, enabled?: boolean): McpConfig {
  const timeout = form.timeout.trim() ? Number(form.timeout.trim()) : undefined
  if (form.type === "local") {
    const environment = parsePairs(form.environment, "=")
    return {
      type: "local",
      command: splitCommand(form.command),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      ...(Object.keys(environment).length ? { environment } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }
  }
  const headers = parsePairs(form.headers, ":")
  return {
    type: "remote",
    url: form.url.trim(),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  }
}

export function fromMcpConfig(name: string, config: McpConfig): McpForm {
  const local = config.type === "local" ? config : undefined
  const remote = config.type === "remote" ? config : undefined
  return {
    name,
    type: config.type,
    command: (local?.command ?? []).map((item) => (/\s/.test(item) ? `"${item}"` : item)).join(" "),
    cwd: local?.cwd ?? "",
    url: remote?.url ?? "",
    environment: renderPairs(local?.environment, "="),
    headers: renderPairs(remote?.headers, ": "),
    timeout: config.timeout === undefined ? "" : String(config.timeout),
  }
}

// A value that looks like a literal credential rather than a {env:} or {file:} reference. Warned about, never
// blocked: some servers legitimately take a long opaque non-secret.
export function looksSecret(value: string) {
  if (value.includes("{env:") || value.includes("{file:")) return false
  return /^(sk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA)/.test(value) || /^[A-Za-z0-9_-]{32,}$/.test(value)
}

export function secretWarnings(form: McpForm): string[] {
  const pairs = { ...parsePairs(form.environment, "="), ...parsePairs(form.headers, ":") }
  return Object.entries(pairs)
    .filter(([, value]) => looksSecret(value))
    .map(([key]) => key)
}

// ------------------------------------------------------------------------------------------ quick add

export type QuickAdd = { name?: string; config: McpConfig }

function nameFromPackage(value: string) {
  return value
    .replace(/^@[^/]+\//, "")
    .replace(/^mcp-server-/, "")
    .replace(/^server-/, "")
    .replace(/-mcp$/, "")
    .replace(/^mcp-/, "")
}

function nameFromCommand(argv: string[]) {
  const pkg = argv.find((item, index) => index > 0 && !item.startsWith("-"))
  if (!pkg) return undefined
  return nameFromPackage(pkg) || undefined
}

function configFrom(value: Record<string, unknown>): McpConfig | undefined {
  const command = value.command
  const args = Array.isArray(value.args) ? value.args.map(String) : []
  if (typeof command === "string") {
    return {
      type: "local",
      command: [...splitCommand(command), ...args],
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(value.env && typeof value.env === "object" ? { environment: value.env as Record<string, string> } : {}),
      ...(value.environment && typeof value.environment === "object"
        ? { environment: value.environment as Record<string, string> }
        : {}),
    }
  }
  if (Array.isArray(command)) {
    return {
      type: "local",
      command: [...command.map(String), ...args],
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(value.env && typeof value.env === "object" ? { environment: value.env as Record<string, string> } : {}),
      ...(value.environment && typeof value.environment === "object"
        ? { environment: value.environment as Record<string, string> }
        : {}),
    }
  }
  if (typeof value.url === "string") {
    return {
      type: "remote",
      url: value.url,
      ...(value.headers && typeof value.headers === "object"
        ? { headers: value.headers as Record<string, string> }
        : {}),
    }
  }
  return undefined
}

// Accepts a bare server definition, a Claude-Desktop-style { "mcpServers": { name: {...} } } wrapper, or a
// plain command line. Returns undefined when none of those read cleanly, so the caller can show one error.
export function parseQuickAdd(input: string): QuickAdd | undefined {
  const text = input.trim()
  if (!text) return undefined

  if (text.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    if (!parsed || typeof parsed !== "object") return undefined
    const record = parsed as Record<string, unknown>
    const wrapper = record.mcpServers ?? record.servers ?? record.mcp
    if (wrapper && typeof wrapper === "object") {
      const entries = Object.entries(wrapper as Record<string, unknown>)
      const first = entries[0]
      if (!first) return undefined
      const config =
        typeof first[1] === "object" && first[1] ? configFrom(first[1] as Record<string, unknown>) : undefined
      return config ? { name: first[0], config } : undefined
    }
    const config = configFrom(record)
    return config ? { name: typeof record.name === "string" ? record.name : undefined, config } : undefined
  }

  if (/^https?:\/\//i.test(text)) return { config: { type: "remote", url: text } }

  const argv = splitCommand(text)
  if (argv.length < 1) return undefined
  return { name: nameFromCommand(argv), config: { type: "local", command: argv } }
}

export function quickAddToForm(value: QuickAdd, fallback = emptyMcpForm()): McpForm {
  return { ...fromMcpConfig(value.name ?? fallback.name, value.config) }
}
