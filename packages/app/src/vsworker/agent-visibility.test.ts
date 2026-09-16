import { describe, expect, test } from "bun:test"
import { initialAgentVisibility } from "@/context/settings"
import { agentVisibilityDefaults } from "./agent-visibility"

describe("agentVisibilityDefaults", () => {
  test("ships the agent picker on", () => {
    expect(agentVisibilityDefaults()).toEqual({ showCustomAgents: true, agentVisibilityInitialized: true })
  })

  // The seeded latch is the whole mechanism: a fresh profile is born classified, so upstream's one-time
  // initializer writes nothing and the default above is the only answer. If upstream ever changes what
  // classifies a profile, this is the assertion that fails.
  test("a fresh profile is born classified, so upstream's initializer never writes", () => {
    const { agentVisibilityInitialized } = agentVisibilityDefaults()
    expect(initialAgentVisibility(agentVisibilityInitialized, false)).toBeUndefined()
    expect(initialAgentVisibility(agentVisibilityInitialized, false, "1.18.30")).toBeUndefined()
  })
})

// `bundle check --seams` only proves the marker survived the merge. This is the line that actually carries the
// behaviour, and a conflict resolved in upstream's favour could keep the marker while dropping it.
test("context/settings.tsx still spreads the defaults", async () => {
  const source = await Bun.file(`${import.meta.dir}/../context/settings.tsx`).text()
  expect(source).toContain("...agentVisibilityDefaults()")
})
