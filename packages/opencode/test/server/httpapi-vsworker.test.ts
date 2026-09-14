import { describe, expect } from "bun:test"
import fs from "fs/promises"

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )
import path from "path"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { VsWorkerPaths } from "../../src/server/routes/instance/httpapi/groups/vsworker"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

// The bundled sets are disabled process-wide by test/preload.ts; these tests exercise the user-facing half of
// each route, which is what the desktop UI writes through.
const request = Effect.fnUntraced(function* (route: string, directory: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  if (init?.body) headers.set("content-type", "application/json")
  const handler = HttpApiApp.webHandler()
  return yield* Effect.promise(() =>
    Promise.resolve(handler.handler(new Request(`http://localhost${route}`, { ...init, headers }), context)),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)
const send = (route: string, directory: string, method: string, body: unknown) =>
  request(route, directory, { method, body: JSON.stringify(body) })

const configOf = (directory: string) =>
  Effect.promise(async () => JSON.parse(await fs.readFile(path.join(directory, "opencode.json"), "utf8")))

describe("vsworker HttpApi", () => {
  it.instance(
    "lists plugins with their origin and revision",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(VsWorkerPaths.plugin, tmp.directory)
        expect(response.status).toBe(200)
        const body = yield* json<any>(response)
        expect(body.revisions.projectFile).toBe(path.join(tmp.directory, "opencode.json"))
        expect(body.revisions.project).not.toBe("")
        expect(body.user).toEqual([])
        // Bundled plugins are killed by the preload switches, so they report as such rather than being absent.
        for (const row of body.bundled) expect(row.state).toBe("killed")
      }),
    { config: {} },
  )

  it.instance(
    "lists MCP servers with runtime status and editability",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const body = yield* json<any>(yield* request(VsWorkerPaths.mcp, tmp.directory))
        expect(body.user).toHaveLength(1)
        expect(body.user[0]).toMatchObject({
          name: "demo",
          type: "local",
          target: "echo demo",
          enabled: false,
          origin: "project",
          scope: "project",
          editable: true,
          status: { status: "disabled" },
        })
      }),
    { config: { mcp: { demo: { type: "local", command: ["echo", "demo"], enabled: false } } } },
  )

  it.instance(
    "adds, toggles, and removes an MCP server in the project config",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const added = yield* send(`${VsWorkerPaths.mcp}/added`, tmp.directory, "PUT", {
          scope: "project",
          config: { type: "local", command: ["echo", "added"], enabled: false },
        })
        expect(added.status).toBe(200)
        expect((yield* configOf(tmp.directory)).mcp.added).toEqual({
          type: "local",
          command: ["echo", "added"],
          enabled: false,
        })

        const toggled = yield* send(`${VsWorkerPaths.mcp}/added`, tmp.directory, "PATCH", {
          scope: "project",
          enabled: true,
        })
        expect(toggled.status).toBe(200)
        expect((yield* configOf(tmp.directory)).mcp.added.enabled).toBe(true)

        const removed = yield* send(`${VsWorkerPaths.mcp}/added`, tmp.directory, "DELETE", { scope: "project" })
        expect(removed.status).toBe(200)
        expect((yield* configOf(tmp.directory)).mcp.added).toBeUndefined()
      }),
    { config: {} },
  )

  it.instance(
    "refuses a write pinned to a stale revision",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* send(`${VsWorkerPaths.mcp}/added`, tmp.directory, "PUT", {
          scope: "project",
          expectedRevision: "0".repeat(64),
          config: { type: "local", command: ["echo", "added"] },
        })
        expect(response.status).toBe(409)
        expect((yield* configOf(tmp.directory)).mcp).toBeUndefined()
      }),
    { config: {} },
  )

  it.instance(
    "rejects an MCP definition the config schema would not accept",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* send(`${VsWorkerPaths.mcp}/bad`, tmp.directory, "PUT", {
          scope: "project",
          config: { type: "nonsense" },
        })
        expect(response.status).toBe(400)
      }),
    { config: {} },
  )

  it.instance(
    "creates, reads, and deletes a project skill",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const created = yield* send(VsWorkerPaths.skill, tmp.directory, "POST", {
          scope: "project",
          name: "demo-skill",
          description: "A demo",
          content: "Body text\n",
        })
        expect(created.status).toBe(200)
        const location = path.join(tmp.directory, ".opencode", "skills", "demo-skill", "SKILL.md")
        expect(yield* json<any>(created)).toMatchObject({ name: "demo-skill", location, editable: true })
        expect(yield* Effect.promise(() => fs.readFile(location, "utf8"))).toContain('name: "demo-skill"')

        const listed = yield* json<any>(yield* request(VsWorkerPaths.skill, tmp.directory))
        expect(listed.user).toContainEqual(
          expect.objectContaining({ name: "demo-skill", origin: "project", editable: true }),
        )

        const content = yield* json<any>(yield* request(`${VsWorkerPaths.skill}/demo-skill/content`, tmp.directory))
        expect(content.description).toBe("A demo")
        expect(content.content.trim()).toBe("Body text")

        const removed = yield* send(`${VsWorkerPaths.skill}/demo-skill`, tmp.directory, "DELETE", { scope: "project" })
        expect(removed.status).toBe(200)
        expect(yield* Effect.promise(() => exists(location))).toBe(false)
      }),
    { config: {} },
  )

  it.instance(
    "rejects a skill name that is not a safe directory name",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* send(VsWorkerPaths.skill, tmp.directory, "POST", {
          scope: "project",
          name: "../escape",
          content: "x",
        })
        expect(response.status).toBe(400)
      }),
    { config: {} },
  )

  it.instance(
    "reports a skill that does not exist as missing",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(`${VsWorkerPaths.skill}/nope/content`, tmp.directory)
        expect(response.status).toBe(404)
      }),
    { config: {} },
  )

  it.instance(
    "writes skill sources into the project config",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* send(VsWorkerPaths.skillSources, tmp.directory, "PUT", {
          scope: "project",
          paths: ["~/team-skills", "  "],
          urls: [],
        })
        expect(response.status).toBe(200)
        const config = yield* configOf(tmp.directory)
        expect(config.skills.paths).toEqual(["~/team-skills"])
        expect(config.skills.urls).toBeUndefined()
      }),
    { config: {} },
  )

  it.instance(
    "refuses to toggle a plugin that is not bundled",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* send(`${VsWorkerPaths.plugin}/nope`, tmp.directory, "PATCH", {
          scope: "project",
          enabled: true,
        })
        expect(response.status).toBe(404)
      }),
    { config: {} },
  )

  it.instance(
    "refuses to remove a plugin the config does not declare",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* send(`${VsWorkerPaths.plugin}/nope`, tmp.directory, "DELETE", {
          scope: "project",
          spec: "opencode-nope",
        })
        expect(response.status).toBe(404)
      }),
    { config: {} },
  )

  it.instance(
    "lists a declared local plugin as a removable project entry",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const body = yield* json<any>(yield* request(VsWorkerPaths.plugin, tmp.directory))
        const row = body.user.find((item: any) => item.name === "demo.ts")
        expect(row).toMatchObject({ kind: "file", origin: "project", removable: true })
      }),
    {
      config: { plugin: ["./demo.ts"] },
      init: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "demo.ts"), "export const demo = async () => ({})\n")),
    },
    // Declaring a plugin makes config loading resolve it on disk, which is slower than the default budget.
    30_000,
  )
})
