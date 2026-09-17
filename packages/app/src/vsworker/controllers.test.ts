import { describe, expect, test } from "bun:test"
import {
  discoveredSkillRows,
  emptyMcpForm,
  fromMcpConfig,
  isOn,
  looksSecret,
  parsePairs,
  parseQuickAdd,
  renderPairs,
  secretWarnings,
  slugify,
  splitCommand,
  stateLabel,
  stateTone,
  statusLabel,
  statusTone,
  toMcpConfig,
  toggleDisabled,
  userMcpRows,
  userPluginRows,
  userSkillRows,
  validateMcp,
  validateSkill,
  envErrors,
  envForm,
  envMask,
  envPayload,
  envSecrets,
  type McpForm,
} from "./controllers"
import type { UserMcp, UserPlugin, UserSkill } from "./api"

const t = (key: string) => key

describe("bundled state", () => {
  test("labels name the reason a row is off", () => {
    expect(stateLabel(t, "enabled", "plugin")).toBe("vsworker.state.enabled")
    expect(stateLabel(t, "disabled-by-config", "plugin")).toBe("vsworker.state.disabled")
    expect(stateLabel(t, "disabled-by-default", "plugin")).toBe("vsworker.state.offByDefault")
    expect(stateLabel(t, "killed", "plugin")).toBe("vsworker.state.killed")
  })

  test("shadowed reads differently per kind", () => {
    expect(stateLabel(t, "shadowed", "plugin")).toBe("vsworker.state.shadowedPlugin")
    expect(stateLabel(t, "shadowed", "mcp")).toBe("vsworker.state.shadowedMcp")
    expect(stateLabel(t, "shadowed", "skill")).toBe("vsworker.state.shadowedSkill")
  })

  test("only enabled reads as on", () => {
    expect(isOn("enabled")).toBe(true)
    expect(isOn("shadowed")).toBe(false)
    expect(isOn("disabled-by-default")).toBe(false)
  })

  test("a killed or shadowed row cannot be toggled from the dialog", () => {
    expect(toggleDisabled("killed")).toBe(true)
    expect(toggleDisabled("shadowed")).toBe(true)
    expect(toggleDisabled("disabled-by-config")).toBe(false)
    expect(toggleDisabled("enabled")).toBe(false)
  })

  test("tone separates on, off, and needs attention", () => {
    expect(stateTone("enabled")).toBe("on")
    expect(stateTone("shadowed")).toBe("warn")
    expect(stateTone("killed")).toBe("off")
  })
})

describe("mcp status", () => {
  test("tone maps the runtime statuses", () => {
    expect(statusTone({ status: "connected" })).toBe("ok")
    expect(statusTone({ status: "failed" })).toBe("error")
    expect(statusTone({ status: "needs_auth" })).toBe("warn")
    expect(statusTone({ status: "disabled" })).toBe("idle")
    expect(statusTone(undefined)).toBe("idle")
  })

  test("client registration failures reuse the failed label, which exists upstream", () => {
    expect(statusLabel(t, { status: "needs_client_registration" })).toBe("mcp.status.failed")
    expect(statusLabel(t, { status: "connected" })).toBe("mcp.status.connected")
    expect(statusLabel(t, undefined)).toBeUndefined()
  })
})

describe("filtering", () => {
  const plugins: UserPlugin[] = [
    { spec: "b-plugin", name: "b-plugin", kind: "npm", origin: "global", file: "/g", removable: true },
    { spec: "a-plugin", name: "a-plugin", kind: "npm", origin: "project", file: "/p", removable: true },
  ]

  test("user plugins sort by name", () => {
    expect(userPluginRows(plugins, "").map((row) => row.name)).toEqual(["a-plugin", "b-plugin"])
  })

  test("search matches the spec and the name, case-insensitively", () => {
    expect(userPluginRows(plugins, "A-PLUG").map((row) => row.name)).toEqual(["a-plugin"])
    expect(userPluginRows(plugins, "   ").map((row) => row.name)).toEqual(["a-plugin", "b-plugin"])
  })

  const skills: UserSkill[] = [
    { name: "mine", location: "/p/mine", origin: "project", editable: true, scope: "project" },
    { name: "theirs", location: "/home/.claude/skills/theirs", origin: "external", editable: false },
  ]

  test("editable and read-only skills go to different sections", () => {
    expect(userSkillRows(skills, "").map((row) => row.name)).toEqual(["mine"])
    expect(discoveredSkillRows(skills, "").map((row) => row.name)).toEqual(["theirs"])
  })

  const servers: UserMcp[] = [
    {
      name: "zeta",
      type: "local",
      target: "echo z",
      enabled: true,
      origin: "global",
      file: "/g",
      editable: true,
      config: { type: "local", command: ["echo", "z"] },
    },
    {
      name: "alpha",
      type: "remote",
      target: "https://a",
      enabled: false,
      origin: "project",
      file: "/p",
      editable: true,
      config: { type: "remote", url: "https://a" },
    },
  ]

  test("servers sort by name and search their target", () => {
    expect(userMcpRows(servers, "").map((row) => row.name)).toEqual(["alpha", "zeta"])
    expect(userMcpRows(servers, "https://a").map((row) => row.name)).toEqual(["alpha"])
  })
})

describe("skill form", () => {
  test("accepts a well formed skill", () => {
    expect(validateSkill(t, { name: "report-review", description: "d", content: "c" })).toEqual({})
  })

  test("rejects each bad field with its own message", () => {
    expect(validateSkill(t, { name: "Report Review", description: "", content: " " })).toEqual({
      name: "vsworker.skills.nameInvalid",
      description: "vsworker.skills.descriptionRequired",
      content: "vsworker.skills.contentRequired",
    })
  })

  test("rejects a name longer than a directory name should be", () => {
    expect(validateSkill(t, { name: "a".repeat(65), description: "d", content: "c" }).name).toBeDefined()
    expect(validateSkill(t, { name: "a".repeat(64), description: "d", content: "c" }).name).toBeUndefined()
  })

  test("slugify turns a typed title into a usable name", () => {
    expect(slugify("Report Review")).toBe("report-review")
    expect(slugify("  PG 17 -- migrations!  ")).toBe("pg-17-migrations")
    expect(slugify("!!!")).toBe("")
  })
})

describe("command parsing", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("npx -y @scope/pkg")).toEqual(["npx", "-y", "@scope/pkg"])
  })

  test("keeps quoted arguments whole", () => {
    expect(splitCommand('node "/opt/my server/index.js" --flag')).toEqual(["node", "/opt/my server/index.js", "--flag"])
  })

  test("keeps an intentionally empty argument", () => {
    expect(splitCommand('cmd "" x')).toEqual(["cmd", "", "x"])
  })

  test("an empty string produces no arguments", () => {
    expect(splitCommand("   ")).toEqual([])
  })
})

describe("pair fields", () => {
  test("environment round trips", () => {
    const text = "A=1\nB=two words"
    expect(parsePairs(text, "=")).toEqual({ A: "1", B: "two words" })
    expect(renderPairs({ A: "1", B: "two words" }, "=")).toBe(text)
  })

  test("headers split on the first colon so a URL value survives", () => {
    expect(parsePairs("Authorization: Bearer x\nX-Base: https://a/b", ":")).toEqual({
      Authorization: "Bearer x",
      "X-Base": "https://a/b",
    })
  })

  test("blank and malformed lines are skipped", () => {
    expect(parsePairs("\n  \nnope\n=novalue\nA=1", "=")).toEqual({ A: "1" })
  })
})

describe("mcp form", () => {
  const local: McpForm = { ...emptyMcpForm(), name: "pg", command: "npx -y pg-server", environment: "URL=x" }

  test("accepts a local server", () => {
    expect(validateMcp(t, local)).toEqual({})
  })

  test("requires a command for a local server", () => {
    expect(validateMcp(t, { ...local, command: "  " }).command).toBe("vsworker.mcp.commandRequired")
  })

  test("requires a valid url for a remote server", () => {
    const remote: McpForm = { ...emptyMcpForm(), name: "r", type: "remote" }
    expect(validateMcp(t, remote).url).toBe("vsworker.mcp.urlRequired")
    expect(validateMcp(t, { ...remote, url: "not a url" }).url).toBe("vsworker.mcp.urlInvalid")
    expect(validateMcp(t, { ...remote, url: "https://x/mcp" })).toEqual({})
  })

  test("rejects a duplicate name", () => {
    expect(validateMcp(t, local, ["pg"]).name).toBe("vsworker.mcp.nameTaken")
    expect(validateMcp(t, local, ["other"]).name).toBeUndefined()
  })

  test("rejects a non-numeric timeout", () => {
    expect(validateMcp(t, { ...local, timeout: "soon" }).timeout).toBe("vsworker.mcp.timeoutInvalid")
    expect(validateMcp(t, { ...local, timeout: "5000" }).timeout).toBeUndefined()
  })

  test("builds the config the config schema expects", () => {
    expect(toMcpConfig(local, false)).toEqual({
      type: "local",
      command: ["npx", "-y", "pg-server"],
      environment: { URL: "x" },
      enabled: false,
    })
  })

  test("omits empty optional fields rather than writing empty values", () => {
    const config = toMcpConfig({ ...emptyMcpForm(), name: "x", command: "run" })
    expect(config).toEqual({ type: "local", command: ["run"] })
  })

  test("round trips through the form", () => {
    const config = toMcpConfig(local)
    expect(toMcpConfig(fromMcpConfig("pg", config))).toEqual(config)
  })

  test("a command argument with a space comes back quoted", () => {
    const form = fromMcpConfig("x", { type: "local", command: ["node", "/a b/c.js"] })
    expect(form.command).toBe('node "/a b/c.js"')
    const config = toMcpConfig(form)
    expect(config.type === "local" ? config.command : undefined).toEqual(["node", "/a b/c.js"])
  })
})

describe("secret detection", () => {
  test("flags values that look like credentials", () => {
    expect(looksSecret("sk-abc123")).toBe(true)
    expect(looksSecret("ghp_" + "a".repeat(20))).toBe(true)
    expect(looksSecret("a".repeat(40))).toBe(true)
  })

  test("does not flag a reference or an ordinary value", () => {
    expect(looksSecret("{env:PG_URL}")).toBe(false)
    expect(looksSecret("{file:~/.pgpass}")).toBe(false)
    expect(looksSecret("postgres")).toBe(false)
  })

  test("warns per field name", () => {
    const form: McpForm = { ...emptyMcpForm(), environment: "TOKEN=sk-abc123\nSAFE={env:X}" }
    expect(secretWarnings(form)).toEqual(["TOKEN"])
  })
})

describe("quick add", () => {
  test("reads a command line and derives a name", () => {
    expect(parseQuickAdd("npx -y @modelcontextprotocol/server-postgres")).toEqual({
      name: "postgres",
      config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-postgres"] },
    })
  })

  test("reads a bare url", () => {
    expect(parseQuickAdd("https://example.com/mcp")).toEqual({
      config: { type: "remote", url: "https://example.com/mcp" },
    })
  })

  test("reads a Claude-style mcpServers wrapper", () => {
    const input = JSON.stringify({
      mcpServers: { filesystem: { command: "npx", args: ["-y", "server-filesystem", "/tmp"], env: { A: "1" } } },
    })
    expect(parseQuickAdd(input)).toEqual({
      name: "filesystem",
      config: {
        type: "local",
        command: ["npx", "-y", "server-filesystem", "/tmp"],
        environment: { A: "1" },
      },
    })
  })

  test("reads a bare definition object", () => {
    expect(parseQuickAdd('{"type":"remote","url":"https://a/mcp","headers":{"X":"1"}}')).toEqual({
      name: undefined,
      config: { type: "remote", url: "https://a/mcp", headers: { X: "1" } },
    })
  })

  test("returns nothing for input it cannot read", () => {
    expect(parseQuickAdd("")).toBeUndefined()
    expect(parseQuickAdd("{not json")).toBeUndefined()
    expect(parseQuickAdd('{"mcpServers":{}}')).toBeUndefined()
    expect(parseQuickAdd('{"nothing":"useful"}')).toBeUndefined()
  })
})

describe("skill environment", () => {
  const defaults = { PLATFORM_BASE_URL: "http://packaged", QA_THRESHOLD: "0.69" }

  test("shows one field per packaged variable, holding this scope's override", () => {
    expect(envForm(defaults, { PLATFORM_BASE_URL: "http://mine" })).toEqual({
      fields: { PLATFORM_BASE_URL: "http://mine", QA_THRESHOLD: "" },
      extra: "",
    })
  })

  test("puts an override the build does not ship in the free-form box", () => {
    expect(envForm(defaults, { PLATFORM_TOKEN: "abc" })).toEqual({
      fields: { PLATFORM_BASE_URL: "", QA_THRESHOLD: "" },
      extra: "PLATFORM_TOKEN=abc",
    })
  })

  test("writes only the variables that differ from the packaged ones", () => {
    const form = { fields: { PLATFORM_BASE_URL: "http://mine", QA_THRESHOLD: "0.69" }, extra: "" }
    expect(envPayload(defaults, form)).toEqual({ PLATFORM_BASE_URL: "http://mine" })
  })

  test("an emptied field drops the override rather than writing a blank value", () => {
    expect(envPayload(defaults, { fields: { PLATFORM_BASE_URL: "  ", QA_THRESHOLD: "" }, extra: "" })).toEqual({})
  })

  test("merges the free-form box, and a visible field wins over a line that repeats it", () => {
    const form = {
      fields: { PLATFORM_BASE_URL: "http://mine", QA_THRESHOLD: "" },
      extra: "EXTRA=1\nPLATFORM_BASE_URL=http://typed",
    }
    expect(envPayload(defaults, form)).toEqual({ EXTRA: "1", PLATFORM_BASE_URL: "http://mine" })
  })

  test("names a free-form key no shell could export", () => {
    const t = (key: string, params?: Record<string, string | number | boolean>) => `${key}:${params?.key}`
    expect(envErrors(t, { fields: {}, extra: "GOOD=1" })).toEqual([])
    expect(envErrors(t, { fields: {}, extra: "not a name=1" })).toEqual(["vsworker.skills.env.invalidKey:not a name"])
  })

  test("finds the variables worth keeping covered, from either source", () => {
    expect(envSecrets({ LLM_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz" }, { PLAIN: "0.69" })).toEqual(["LLM_API_KEY"])
    expect(envSecrets({ TOKEN: "{env:REAL_TOKEN}" })).toEqual([])
    expect(envMask("anything")).toBe("••••••••")
    expect(envMask("")).toBe("")
  })
})
