import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"
import { loaders } from "./index"

const placeholders = (value: string) => Array.from(value.matchAll(/\{\{(\w+)\}\}/g), (match) => match[1]).sort()

describe("vsworker i18n parity", () => {
  test("every key is namespaced so an upstream merge cannot collide", () => {
    for (const key of Object.keys(en)) expect(key.startsWith("vsworker.")).toBe(true)
  })

  test("zh has exactly the English keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  test("zh preserves English placeholders", () => {
    const source = en as Record<string, string>
    const target = zh as Record<string, string>
    const mismatched = Object.keys(source).filter(
      (key) => placeholders(source[key]).join() !== placeholders(target[key]).join(),
    )
    expect(mismatched).toEqual([])
  })

  test("every declared loader resolves", async () => {
    for (const [locale, load] of Object.entries(loaders)) {
      const loaded = await load()
      expect(Object.keys(loaded.dict).length, locale).toBe(Object.keys(en).length)
    }
  })
})
