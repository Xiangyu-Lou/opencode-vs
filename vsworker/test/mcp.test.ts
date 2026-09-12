import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { VsWorkerMcp } from "../src/mcp"

function entry(input: Partial<VsWorkerMcp.Raw> & { id: string }): VsWorkerMcp.Raw {
  return {
    id: input.id,
    defaultEnabled: input.defaultEnabled ?? true,
    description: input.description,
    config: input.config ?? { type: "remote", url: `http://${input.id}` },
  }
}

const kill = process.env[VsWorkerMcp.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerMcp.DISABLE_ENV]
})
afterEach(() => {
  if (kill === undefined) delete process.env[VsWorkerMcp.DISABLE_ENV]
  else process.env[VsWorkerMcp.DISABLE_ENV] = kill
})

const noop: VsWorkerMcp.Substitute = async (text) => text

describe("apply", () => {
  test("adds a bundled server the user never mentioned", () => {
    const result = VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user: undefined })
    expect(result).toEqual({ docs: { type: "remote", url: "http://docs", enabled: true } })
  })

  test("honours defaultEnabled false", () => {
    const result = VsWorkerMcp.apply({ bundle: [entry({ id: "docs", defaultEnabled: false })], user: undefined })
    expect(result?.docs).toMatchObject({ enabled: false })
  })

  test("lets a bare enabled override toggle the bundled definition", () => {
    const result = VsWorkerMcp.apply({
      bundle: [entry({ id: "docs" })],
      user: { docs: { enabled: false } },
    })
    expect(result).toEqual({ docs: { type: "remote", url: "http://docs", enabled: false } })
  })

  test("turns a bundled server back on from an override", () => {
    const result = VsWorkerMcp.apply({
      bundle: [entry({ id: "docs", defaultEnabled: false })],
      user: { docs: { enabled: true } },
    })
    expect(result?.docs).toMatchObject({ type: "remote", enabled: true })
  })

  test("yields to a user definition that carries a type", () => {
    const user = { docs: { type: "local" as const, command: ["mine"] } }
    const result = VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user })
    expect(result?.docs).toEqual(user.docs)
  })

  test("keeps servers the user configured themselves", () => {
    const user = { other: { type: "remote" as const, url: "http://other" } }
    const result = VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user })
    expect(Object.keys(result ?? {}).toSorted()).toEqual(["docs", "other"])
    expect(result?.other).toEqual(user.other)
  })

  test("never mutates its inputs", () => {
    const bundle = [entry({ id: "docs" })]
    const user = { docs: { enabled: false } }
    VsWorkerMcp.apply({ bundle, user })
    expect(bundle[0]!.config).toEqual({ type: "remote", url: "http://docs" })
    expect(user).toEqual({ docs: { enabled: false } })
  })

  test("returns the user config untouched when disabled", () => {
    const user = { other: { enabled: true } }
    expect(VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user, disabled: true })).toBe(user)
    expect(VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user: undefined, disabled: true })).toBeUndefined()
  })

  test("respects the kill switch env var", () => {
    process.env[VsWorkerMcp.DISABLE_ENV] = "1"
    expect(VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user: undefined })).toBeUndefined()
    process.env[VsWorkerMcp.DISABLE_ENV] = "0"
    expect(VsWorkerMcp.apply({ bundle: [entry({ id: "docs" })], user: undefined })?.docs).toBeDefined()
  })
})

describe("substitute", () => {
  test("passes the definition through the substituter", async () => {
    const bundle = [
      entry({ id: "docs", config: { type: "remote", url: "http://docs", headers: { A: "{env:TOKEN}" } } }),
    ]
    const result = await VsWorkerMcp.substitute(bundle, async (text) => text.replaceAll("{env:TOKEN}", "secret"))
    expect(result.warnings).toEqual([])
    expect(result.bundle[0]!.config).toMatchObject({ headers: { A: "secret" } })
  })

  test("skips entries with no placeholders", async () => {
    const bundle = [entry({ id: "docs" })]
    let calls = 0
    const result = await VsWorkerMcp.substitute(bundle, async (text) => {
      calls++
      return text
    })
    expect(calls).toBe(0)
    expect(result.bundle[0]).toBe(bundle[0]!)
  })

  test("keeps the raw definition and warns when substitution breaks the json", async () => {
    const bundle = [
      entry({ id: "docs", config: { type: "remote", url: "http://docs", headers: { A: "{env:TOKEN}" } } }),
    ]
    const result = await VsWorkerMcp.substitute(bundle, async (text) => text.replaceAll("{env:TOKEN}", 'a"b'))
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain("docs")
    expect(result.bundle[0]!.config).toMatchObject({ headers: { A: "{env:TOKEN}" } })
  })
})

describe("resolve", () => {
  test("never reads anything when the bundle is disabled", async () => {
    let calls = 0
    const result = await VsWorkerMcp.resolve({
      bundle: [entry({ id: "docs", config: { type: "remote", url: "{file:token}" } })],
      user: undefined,
      disabled: true,
      substitute: async (text) => {
        calls++
        return text
      },
    })
    expect(calls).toBe(0)
    expect(result.mcp).toBeUndefined()
  })

  test("substitutes and applies in one pass", async () => {
    const result = await VsWorkerMcp.resolve({
      bundle: [entry({ id: "docs", config: { type: "remote", url: "{env:URL}" } })],
      user: undefined,
      substitute: async (text) => text.replaceAll("{env:URL}", "http://real"),
    })
    expect(result.mcp?.docs).toEqual({ type: "remote", url: "http://real", enabled: true })
  })

  test("falls back to the compiled-in bundle", async () => {
    const result = await VsWorkerMcp.resolve({ user: { a: { enabled: true } }, substitute: noop })
    expect(result.mcp).toEqual({ a: { enabled: true } })
  })
})

describe("describe", () => {
  test("reports every state", () => {
    const bundle = [
      entry({ id: "on" }),
      entry({ id: "off", defaultEnabled: false }),
      entry({ id: "turned-off" }),
      entry({ id: "mine" }),
    ]
    const rows = VsWorkerMcp.describe({
      bundle,
      config: {
        on: { type: "remote", url: "http://on", enabled: true },
        "turned-off": { type: "remote", url: "http://turned-off", enabled: false },
        mine: { type: "local", command: ["mine"] },
      } as never,
    })
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["on", "enabled"],
      ["off", "disabled-by-default"],
      ["turned-off", "disabled-by-config"],
      ["mine", "shadowed"],
    ])
  })

  test("a shadowing entry reports the user's own target", () => {
    const rows = VsWorkerMcp.describe({
      bundle: [entry({ id: "docs" })],
      config: { docs: { type: "local", command: ["uvx", "mine"] } },
    })
    expect(rows[0]).toMatchObject({ state: "shadowed", type: "local", target: "uvx mine" })
  })

  test("an identical user copy is not shadowing, whatever the key order", () => {
    const rows = VsWorkerMcp.describe({
      bundle: [entry({ id: "docs", config: { type: "remote", url: "http://docs", headers: { A: "1" } } })],
      config: { docs: { headers: { A: "1" }, url: "http://docs", type: "remote", enabled: true } },
    })
    expect(rows[0]).toMatchObject({ state: "enabled" })
  })

  test("reports killed for everything when the kill switch is set", () => {
    process.env[VsWorkerMcp.DISABLE_ENV] = "true"
    const rows = VsWorkerMcp.describe({ bundle: [entry({ id: "docs" })], config: undefined })
    expect(rows[0]).toMatchObject({ state: "killed" })
  })
})
