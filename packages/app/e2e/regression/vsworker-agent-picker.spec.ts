import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// VsWorker ships the plan/build agent picker on, where upstream hides it until the user finds the Settings
// toggle. The default lives in packages/app/src/vsworker/agent-visibility.ts and reaches the composer through
// settings -> local -> session-composer-controls -> prompt-input-v2, so a unit test on the default proves very
// little. These two cases are the contract: a fresh profile sees the picker, and a profile that already stored
// a preference is left alone.

const directory = "C:/OpenCode/VsWorkerAgentPicker"
const projectID = "proj_vsworker_agent_picker"
const sessionID = "ses_vsworker_agent_picker"

// Both agents are native, as build and plan are in a real install, so `hasCustomAgent` stays false and the
// setting is the only thing that can make the picker appear.
const agents = [
  { name: "build", mode: "primary" },
  { name: "plan", mode: "primary" },
]

async function openSession(page: Page, settings?: Record<string, unknown>) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "vsworker-agent-picker",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "vsworker-agent-picker",
        projectID,
        directory,
        title: "VsWorker agent picker",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // Registered after the mock so it wins: the mock only ever offers a single build agent.
  await page.route(/\/agent(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agents) }),
  )
  if (settings) {
    await page.addInitScript((value) => {
      localStorage.setItem("settings.v3", value)
    }, JSON.stringify(settings))
  }
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)
  return composer
}

test("a fresh profile gets the agent picker, defaulting to build", async ({ page }) => {
  const composer = await openSession(page)
  const control = composer.getByRole("button", { name: "Choose agent" })
  await expect(control).toBeVisible()
  await expect(control).toContainText("build")

  await control.click()
  await expect(page.getByRole("menuitemradio", { name: "plan" })).toBeVisible()
})

test("a profile that already stored a preference keeps it hidden", async ({ page }) => {
  const composer = await openSession(page, {
    general: { showCustomAgents: false, agentVisibilityInitialized: true },
  })
  await expect(composer.locator('[data-component="prompt-input"]')).toBeVisible()
  await expect(composer.getByRole("button", { name: "Choose agent" })).toHaveCount(0)
})
