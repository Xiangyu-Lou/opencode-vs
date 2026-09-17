// vsworker-seam: covers the fork's Extensions tabs against stubbed management routes.
import { expect, test, type Page, type Route } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { APP_READY_TIMEOUT } from "../utils/waits"

// Cross-origin like every other stubbed route in this suite: the app is served from :3000 and talks to :4096.
const CORS = { "access-control-allow-origin": "*" }

function reply(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS,
    body: JSON.stringify(body),
  })
}

const directory = fixture.directory

const revisions = {
  global: "globalrev",
  globalFile: "C:/config/opencode.json",
  project: "projectrev",
  projectFile: `${directory}/opencode.json`,
}

type Writes = { path: string; method: string; body: unknown }[]

function state() {
  return {
    plugins: {
      revisions,
      bundled: [
        {
          id: "hello",
          source: "local" as const,
          spec: "vsworker/plugins/hello/index.ts",
          version: "0.0.0",
          description: "Template and smoke test for the bundling pipeline.",
          state: "disabled-by-default" as const,
        },
        {
          id: "wakatime",
          source: "npm" as const,
          spec: "opencode-wakatime@2.0.0",
          version: "2.0.0",
          state: "shadowed" as const,
          shadowedBy: "opencode-wakatime",
        },
      ],
      user: [
        {
          spec: "opencode-wakatime@2.0.1",
          name: "opencode-wakatime",
          kind: "npm" as const,
          origin: "project" as const,
          file: `${directory}/opencode.json`,
          removable: true,
          scope: "project" as const,
        },
      ],
    },
    skills: {
      revisions,
      bundled: [
        {
          id: "report-review",
          description: "Review reports",
          location: "/cache/report-review/SKILL.md",
          state: "enabled" as const,
        },
      ],
      user: [
        {
          name: "pg-migrations",
          description: "Write PostgreSQL migrations",
          location: `${directory}/.opencode/skills/pg-migrations/SKILL.md`,
          origin: "project" as const,
          editable: true,
          scope: "project" as const,
        },
        {
          name: "pdf",
          location: "/home/u/.claude/skills/pdf/SKILL.md",
          origin: "external" as const,
          editable: false,
        },
      ],
      sources: { paths: ["~/team-skills"], urls: [] },
    },
    mcp: {
      revisions,
      bundled: [],
      user: [
        {
          name: "postgres",
          type: "local" as const,
          target: "npx -y server-postgres",
          enabled: true,
          origin: "project" as const,
          file: `${directory}/opencode.json`,
          scope: "project" as const,
          editable: true,
          status: { status: "connected" as const },
          config: { type: "local" as const, command: ["npx", "-y", "server-postgres"] },
        },
      ],
    },
  }
}

// Registered after the mock server so these handlers win; everything else falls through to it. The pattern is
// deliberately anchored to the API port: the app's own source lives at /src/vsworker/, which Vite serves from
// the page origin, and a looser pattern would intercept those modules and blank the app.
const API_PORT = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"

// The shared mock answers /api/pty/shells but not the v1 /pty/shells this protocol uses, and the General tab
// throws on a non-array. Answering it here keeps these tests about the Extensions tabs.
async function stubShells(page: Page) {
  await page.route(new RegExp(`:${API_PORT}/pty/shells`), (route: Route) => reply(route, []))
}

async function stubVsWorker(page: Page, writes: Writes, onWrite?: (route: Route) => Promise<void>) {
  await page.route(new RegExp(`:${API_PORT}/vsworker/`), async (route: Route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const path = url.pathname
    if (method !== "GET") {
      writes.push({ path, method, body: route.request().postDataJSON() })
      if (onWrite) return onWrite(route)
      return reply(route, revisions)
    }
    const data = state()
    if (path === "/vsworker/plugin") return reply(route, data.plugins)
    if (path === "/vsworker/skill") return reply(route, data.skills)
    if (path === "/vsworker/mcp") return reply(route, data.mcp)
    if (path.endsWith("/env"))
      return reply(route, {
        name: "report-review",
        location: "/cache/report-review/env.json",
        present: true,
        defaults: { PLATFORM_BASE_URL: "http://packaged", QA_THRESHOLD: "0.69" },
        problems: [],
        overrides: { global: { PLATFORM_BASE_URL: "http://mine" }, project: {} },
      })
    if (path.endsWith("/content"))
      return reply(route, {
        name: "pg-migrations",
        description: "Write PostgreSQL migrations",
        location: `${directory}/.opencode/skills/pg-migrations/SKILL.md`,
        content: "## When to use\n\nMigrations.\n",
        editable: true,
      })
    return reply(route, {}, 404)
  })
}

async function openExtensions(page: Page, writes: Writes, onWrite?: (route: Route) => Promise<void>) {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((item) => ({ ...item })),
    provider: fixture.provider,
    directory,
    project: fixture.project,
    pageMessages,
  })
  await stubShells(page)
  await stubVsWorker(page, writes, onWrite)
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
    )
  }, directory)
  await page.goto("/")
  // Entering a session is how the other specs prove the app finished booting before driving the UI.
  await page.locator('[data-component="home-session-row"]').filter({ hasText: fixture.expected.targetTitle }).click()
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible({
    timeout: APP_READY_TIMEOUT,
  })
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible({ timeout: APP_READY_TIMEOUT })
  return dialog
}

test("plugins tab lists bundled and user plugins and writes a toggle", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-plugins"]').click()
  const bundled = dialog.locator('[data-action="vsworker-plugin-bundled-hello"]')
  await expect(bundled).toBeVisible()
  await expect(bundled).toContainText("Off by default")

  const shadowed = dialog.locator('[data-action="vsworker-plugin-bundled-wakatime"]')
  await expect(shadowed).toContainText("Overridden by your plugin")
  await expect(shadowed.getByRole("switch")).toBeDisabled()

  await expect(dialog.locator('[data-action="vsworker-plugin-user-opencode-wakatime"]')).toBeVisible()

  await bundled.locator('[data-slot="switch-control"]').click()
  await expect.poll(() => writes.find((write) => write.path === "/vsworker/plugin/hello")).toBeTruthy()
  expect(writes.at(-1)).toMatchObject({
    method: "PATCH",
    body: { scope: "global", enabled: true, expectedRevision: revisions.global },
  })
})

test("scope switch sends the project revision", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-plugins"]').click()
  await dialog.locator('[data-action="vsworker-scope-plugins"]').getByRole("button", { name: "Project" }).click()
  await dialog.locator('[data-action="vsworker-plugin-bundled-hello"]').locator('[data-slot="switch-control"]').click()

  await expect.poll(() => writes.length).toBeGreaterThan(0)
  expect(writes.at(-1)).toMatchObject({
    body: { scope: "project", expectedRevision: revisions.project },
  })
})

test("skills tab separates editable skills from discovered ones", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-skills"]').click()
  await expect(dialog.locator('[data-action="vsworker-skill-bundled-report-review"]')).toContainText("Enabled")
  await expect(dialog.locator('[data-action="vsworker-skill-user-pg-migrations"]')).toBeVisible()
  await expect(dialog.locator('[data-action="vsworker-skill-discovered-pdf"]')).toBeVisible()
  // A discovered skill is read-only, so it never offers a delete.
  await expect(dialog.locator('[data-action="vsworker-skill-remove-pdf"]')).toHaveCount(0)
})

test("creating a skill validates the name before writing", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-skills"]').click()
  await dialog.locator('[data-action="vsworker-skill-new"]').click()

  const skillDialog = page.locator(".vsworker-skill-dialog")
  await expect(skillDialog).toBeVisible()
  await skillDialog.locator('[data-action="vsworker-skill-save"]').click()
  await expect(skillDialog).toContainText("Use lowercase letters, digits, and single hyphens")
  expect(writes).toHaveLength(0)

  await skillDialog.locator('[data-action="vsworker-skill-description"]').fill("Review PG migrations")
  await skillDialog.locator('[data-action="vsworker-skill-content"]').fill("Body")
  await skillDialog.locator('[data-action="vsworker-skill-save"]').click()

  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({
    path: "/vsworker/skill",
    method: "POST",
    body: { scope: "global", name: "review-pg-migrations", description: "Review PG migrations", content: "Body" },
  })
})

test("editing a bundled skill's environment writes only what differs from the build", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-skills"]').click()
  await dialog.locator('[data-action="vsworker-skill-env-report-review"]').click()

  const envDialog = page.locator(".vsworker-skill-env-dialog")
  await expect(envDialog).toBeVisible()
  // The override this scope already carries is editable; the untouched one shows what the build ships.
  await expect(envDialog.locator('[data-action="vsworker-skill-env-field-PLATFORM_BASE_URL"]')).toHaveValue(
    "http://mine",
  )
  const threshold = envDialog.locator('[data-action="vsworker-skill-env-field-QA_THRESHOLD"]')
  await expect(threshold).toHaveValue("")
  await expect(threshold).toHaveAttribute("placeholder", "0.69")

  await threshold.fill("0.8")
  await envDialog.locator('[data-action="vsworker-skill-env-extra"]').fill("PLATFORM_TOKEN=abc")
  await envDialog.locator('[data-action="vsworker-skill-env-save"]').click()

  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({
    path: "/vsworker/skill/report-review/env",
    method: "PUT",
    body: {
      scope: "global",
      expectedRevision: revisions.global,
      env: { PLATFORM_BASE_URL: "http://mine", QA_THRESHOLD: "0.8", PLATFORM_TOKEN: "abc" },
    },
  })
})

test("clearing a skill's environment overrides writes an empty set", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-skills"]').click()
  await dialog.locator('[data-action="vsworker-skill-env-report-review"]').click()
  await page.locator('[data-action="vsworker-skill-env-clear"]').click()

  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({
    path: "/vsworker/skill/report-review/env",
    method: "PUT",
    body: { scope: "global", env: {} },
  })
})

test("mcp tab shows runtime status and adds a server from a pasted command", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes)

  await dialog.locator('[data-action="vsworker-tab-mcp"]').click()
  const row = dialog.locator('[data-action="vsworker-mcp-user-postgres"]')
  await expect(row).toBeVisible()
  await expect(row).toContainText("connected")

  await dialog.locator('[data-action="vsworker-mcp-add"]').click()
  const mcpDialog = page.locator(".vsworker-mcp-dialog")
  await expect(mcpDialog).toBeVisible()

  await mcpDialog.locator('[data-action="vsworker-mcp-paste-toggle"]').click()
  await mcpDialog.locator('[data-action="vsworker-mcp-paste"]').fill("npx -y @modelcontextprotocol/server-filesystem")
  await mcpDialog.locator('[data-action="vsworker-mcp-paste-apply"]').click()

  await expect(mcpDialog.locator('[data-action="vsworker-mcp-name"]')).toHaveValue("filesystem")
  await mcpDialog.locator('[data-action="vsworker-mcp-save"]').click()

  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({
    path: "/vsworker/mcp/filesystem",
    method: "PUT",
    body: {
      scope: "global",
      config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"] },
    },
  })
})

test("a stale revision surfaces a conflict instead of writing", async ({ page }) => {
  const writes: Writes = []
  const dialog = await openExtensions(page, writes, (route) =>
    reply(
      route,
      {
        name: "VsWorkerConflictError",
        file: revisions.globalFile,
        expected: revisions.global,
        actual: "moved",
        message: "changed on disk",
      },
      409,
    ),
  )

  await dialog.locator('[data-action="vsworker-tab-plugins"]').click()
  await dialog.locator('[data-action="vsworker-plugin-bundled-hello"]').locator('[data-slot="switch-control"]').click()

  await expect(page.getByText("This file changed on disk")).toBeVisible()
  // The write was attempted once and refused; the UI must not retry it.
  await expect.poll(() => writes.length).toBe(1)
})
