import { afterEach, beforeEach, expect, test } from "bun:test"
import { VsWorkerProviders } from "../src/providers"

// preload.ts does not set the kill switch, but the ambient environment might; pin it either way.
const kill = process.env[VsWorkerProviders.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerProviders.DISABLE_ENV]
})
afterEach(() => {
  if (kill === undefined) delete process.env[VsWorkerProviders.DISABLE_ENV]
  else process.env[VsWorkerProviders.DISABLE_ENV] = kill
})

test("hides the hosted providers when a user names none", () => {
  expect(VsWorkerProviders.apply({ user: undefined })).toEqual(["opencode", "opencode-go"])
})

test("keeps the user's own entries and appends the hidden ones", () => {
  expect(VsWorkerProviders.apply({ user: ["openai"] })).toEqual(["openai", "opencode", "opencode-go"])
})

test("does not duplicate an id the user already disabled", () => {
  expect(VsWorkerProviders.apply({ user: ["opencode", "openai"] })).toEqual(["opencode", "openai", "opencode-go"])
})

test("leaves the list untouched when the env kill switch is set", () => {
  process.env[VsWorkerProviders.DISABLE_ENV] = "1"
  expect(VsWorkerProviders.apply({ user: ["openai"] })).toEqual(["openai"])
  expect(VsWorkerProviders.apply({ user: undefined })).toEqual([])
})

test("leaves the list untouched when disabled is passed directly", () => {
  expect(VsWorkerProviders.apply({ user: ["openai"], disabled: true })).toEqual(["openai"])
})

test("does not alias the caller's array", () => {
  const user = ["openai"]
  const result = VsWorkerProviders.apply({ user, disabled: true })
  result.push("anthropic")
  expect(user).toEqual(["openai"])
})
