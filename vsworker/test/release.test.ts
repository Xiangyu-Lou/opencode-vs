import { describe, expect, test } from "bun:test"
import { VsWorkerRelease } from "../src/release"

describe("frozen", () => {
  test("freezes every built channel", () => {
    expect(VsWorkerRelease.frozen(VsWorkerRelease.CHANNEL)).toBe(true)
    expect(VsWorkerRelease.frozen("latest")).toBe(true)
    expect(VsWorkerRelease.frozen("beta")).toBe(true)
  })

  test("leaves source runs and tests alone", () => {
    expect(VsWorkerRelease.frozen("local")).toBe(false)
  })

  test("is inactive under the test channel", () => {
    expect(VsWorkerRelease.active).toBe(false)
  })
})
