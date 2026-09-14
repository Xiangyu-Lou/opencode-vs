import { describe, expect, test } from "bun:test"
import { DISABLE_ENV, describe as describeBundle, normalize, prepare, select, type Raw } from "../src/plugins"

function raw(input: Partial<Raw> & Pick<Raw, "id">): Raw {
  return {
    source: "npm",
    spec: `${input.id}@1.0.0`,
    pkg: { name: input.id, version: "1.0.0" },
    options: undefined,
    defaultEnabled: true,
    description: undefined,
    mod: { default: { id: input.id, server: async () => ({}) } },
    ...input,
  }
}

function bundle(...items: Raw[]) {
  return prepare(items)
}

describe("normalize", () => {
  test("unwraps a transpiled ES module reachable at default.default", () => {
    const plugin = { id: "a", server: async () => ({}) }
    const mod = normalize({ default: { __esModule: true, default: plugin } })
    expect(mod["default"]).toBe(plugin)
    expect(mod["__esModule"]).toBeUndefined()
  })

  test("drops a CJS default that only mirrors the named exports", () => {
    const first = async () => ({})
    const second = async () => ({})
    const exports = { first, second }
    const mod = normalize({ ...exports, default: exports })
    expect(mod).toEqual({ first, second })
    expect("default" in mod).toBe(false)
  })

  test("keeps a default that carries the plugin shape", () => {
    const plugin = { id: "a", server: async () => ({}) }
    expect(normalize({ default: plugin })).toEqual({ default: plugin })
  })

  test("keeps legacy named function exports untouched", () => {
    const fn = async () => ({})
    expect(normalize({ MyPlugin: fn })).toEqual({ MyPlugin: fn })
  })

  test("tolerates a non-object namespace", () => {
    expect(normalize(undefined)).toEqual({})
  })
})

describe("select", () => {
  test("returns enabled plugins as loader-compatible entries", () => {
    const [loaded, ...rest] = select({ bundle: bundle(raw({ id: "a" })) })
    expect(rest).toHaveLength(0)
    expect(loaded).toMatchObject({
      spec: "a@1.0.0",
      source: "npm",
      deprecated: false,
      pkg: { json: { name: "a", version: "1.0.0" } },
    })
  })

  test("skips a plugin the user set to false", () => {
    expect(select({ bundle: bundle(raw({ id: "a" })), user: { a: false } })).toHaveLength(0)
    expect(select({ bundle: bundle(raw({ id: "a" })), user: { a: { enabled: false } } })).toHaveLength(0)
  })

  test("runs an opt-in plugin only when the user enables it", () => {
    const off = bundle(raw({ id: "a", defaultEnabled: false }))
    expect(select({ bundle: off })).toHaveLength(0)
    expect(select({ bundle: off, user: { a: true } })).toHaveLength(1)
    expect(select({ bundle: off, user: { a: { enabled: true } } })).toHaveLength(1)
  })

  test("merges user options over the bundled options", () => {
    const items = bundle(raw({ id: "a", options: { url: "http://bundled", keep: 1 } }))
    const [loaded] = select({ bundle: items, user: { a: { options: { url: "http://user" } } } })
    expect(loaded?.options).toEqual({ url: "http://user", keep: 1 })
  })

  test("yields to a user declaration of the same package", () => {
    const items = bundle(raw({ id: "a", pkg: { name: "opencode-a", version: "1.0.0" } }))
    expect(select({ bundle: items, external: new Set(["opencode-a"]) })).toHaveLength(0)
    expect(select({ bundle: items, external: new Set(["opencode-other"]) })).toHaveLength(1)
  })

  test("loads nothing when the caller disables bundling", () => {
    expect(select({ bundle: bundle(raw({ id: "a" })), disabled: true })).toHaveLength(0)
  })

  test("loads nothing when the kill switch env var is set", () => {
    const previous = process.env[DISABLE_ENV]
    try {
      process.env[DISABLE_ENV] = "1"
      expect(select({ bundle: bundle(raw({ id: "a" })) })).toHaveLength(0)
      process.env[DISABLE_ENV] = "0"
      expect(select({ bundle: bundle(raw({ id: "a" })) })).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env[DISABLE_ENV]
      else process.env[DISABLE_ENV] = previous
    }
  })

  test("preserves manifest order", () => {
    const items = bundle(raw({ id: "a" }), raw({ id: "b" }), raw({ id: "c" }))
    expect(select({ bundle: items }).map((item) => item.spec)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"])
  })
})

describe("describe", () => {
  test("reports why each plugin is or is not running", () => {
    const items = bundle(
      raw({ id: "on" }),
      raw({ id: "off", defaultEnabled: false }),
      raw({ id: "user-off" }),
      raw({ id: "shadowed", pkg: { name: "opencode-shadowed", version: "2.0.0" } }),
    )
    const rows = describeBundle({
      bundle: items,
      user: { "user-off": false },
      external: new Set(["opencode-shadowed"]),
    })
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["on", "enabled"],
      ["off", "disabled-by-default"],
      ["user-off", "disabled-by-config"],
      ["shadowed", "shadowed"],
    ])
    expect(rows.at(-1)?.shadowedBy).toBe("opencode-shadowed")
  })

  test("reports every plugin as killed when bundling is disabled", () => {
    const rows = describeBundle({ bundle: bundle(raw({ id: "a" })), disabled: true })
    expect(rows.map((row) => row.state)).toEqual(["killed"])
  })
})
