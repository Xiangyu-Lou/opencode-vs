// vsworker-seam: route-coverage scenarios for the fork's management routes. Spread into the scenario list in
// index.ts so the coverage, auth, and effect gates see every VsWorker route.
import { Effect } from "effect"
import { array, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import type { Scenario } from "./types"

const listShape = (body: any) => {
  object(body)
  object(body.revisions)
  check(typeof body.revisions.global === "string", "list should carry the global config revision")
  array(body.bundled)
  array(body.user)
}

// Every write is pinned to a revision that cannot be current, so these scenarios exercise the routes without
// leaving anything behind in the exercise config files.
const STALE = "0".repeat(64)

export const vsworkerScenarios: Scenario[] = [
  http.protected.get("/vsworker/plugin", "vsworker.plugin.list").json(200, listShape, "status"),
  http.protected
    .patch("/vsworker/plugin/{id}", "vsworker.plugin.update")
    .at((ctx) => ({
      path: route("/vsworker/plugin/{id}", { id: "vsworker-missing" }),
      headers: ctx.headers(),
      body: { scope: "project", enabled: true },
    }))
    .json(404, object, "status"),
  http.protected
    .patch("/vsworker/plugin/{id}", "vsworker.plugin.update.invalid")
    .at((ctx) => ({
      path: route("/vsworker/plugin/{id}", { id: "hello" }),
      headers: ctx.headers(),
      body: { scope: "nonsense" },
    }))
    .status(400),
  http.protected
    .post("/vsworker/plugin", "vsworker.plugin.add")
    .at((ctx) => ({
      path: "/vsworker/plugin",
      headers: ctx.headers(),
      body: { scope: "project", spec: "", expectedRevision: STALE },
    }))
    .json(400, object, "status"),
  http.protected
    .delete("/vsworker/plugin/{id}", "vsworker.plugin.remove")
    .at((ctx) => ({
      path: route("/vsworker/plugin/{id}", { id: "vsworker-missing" }),
      headers: ctx.headers(),
      body: { scope: "project", spec: "vsworker-missing", expectedRevision: STALE },
    }))
    .json(409, object, "status"),
  http.protected.get("/vsworker/skill", "vsworker.skill.list").json(
    200,
    (body: any) => {
      listShape(body)
      object(body.sources)
      array(body.sources.paths)
      array(body.sources.urls)
    },
    "status",
  ),
  http.protected
    .get("/vsworker/skill/{name}/content", "vsworker.skill.content")
    .at((ctx) => ({
      path: route("/vsworker/skill/{name}/content", { name: "vsworker-missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/vsworker/skill/{name}/env", "vsworker.skill.env")
    .at((ctx) => ({
      path: route("/vsworker/skill/{name}/env", { name: "vsworker-missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .put("/vsworker/skill/{name}/env", "vsworker.skill.envWrite")
    .at((ctx) => ({
      path: route("/vsworker/skill/{name}/env", { name: "vsworker-missing" }),
      headers: ctx.headers(),
      body: { scope: "project", env: {} },
    }))
    .json(404, object, "status"),
  http.protected
    .patch("/vsworker/skill/{name}", "vsworker.skill.toggle")
    .at((ctx) => ({
      path: route("/vsworker/skill/{name}", { name: "vsworker-missing" }),
      headers: ctx.headers(),
      body: { scope: "project", enabled: true },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/vsworker/skill", "vsworker.skill.write")
    .at((ctx) => ({
      path: "/vsworker/skill",
      headers: ctx.headers(),
      body: { scope: "project", name: "Not A Valid Name", content: "x" },
    }))
    .json(400, object, "status"),
  http.protected
    .delete("/vsworker/skill/{name}", "vsworker.skill.remove")
    .at((ctx) => ({
      path: route("/vsworker/skill/{name}", { name: "vsworker-missing" }),
      headers: ctx.headers(),
      body: { scope: "project" },
    }))
    .json(404, object, "status"),
  http.protected
    .put("/vsworker/skill-source", "vsworker.skill.sources")
    .at((ctx) => ({
      path: "/vsworker/skill-source",
      headers: ctx.headers(),
      body: { scope: "project", paths: [], urls: [], expectedRevision: STALE },
    }))
    .jsonEffect(
      409,
      (body) =>
        Effect.sync(() => {
          object(body)
          check(isRecord(body.data) || typeof body.file === "string", "conflict should name the contested file")
        }),
      "status",
    ),
  http.protected.get("/vsworker/mcp", "vsworker.mcp.list").json(200, listShape, "status"),
  http.protected
    .put("/vsworker/mcp/{name}", "vsworker.mcp.upsert")
    .at((ctx) => ({
      path: route("/vsworker/mcp/{name}", { name: "vsworker-exercise" }),
      headers: ctx.headers(),
      body: {
        scope: "project",
        expectedRevision: STALE,
        config: { type: "local", command: ["bun", "--version"], enabled: false },
      },
    }))
    .json(409, object, "status"),
  http.protected
    .put("/vsworker/mcp/{name}", "vsworker.mcp.upsert.invalid")
    .at((ctx) => ({
      path: route("/vsworker/mcp/{name}", { name: "vsworker-exercise" }),
      headers: ctx.headers(),
      body: { scope: "project", config: { type: "nonsense" } },
    }))
    .status(400),
  http.protected
    .patch("/vsworker/mcp/{name}", "vsworker.mcp.toggle")
    .at((ctx) => ({
      path: route("/vsworker/mcp/{name}", { name: "vsworker-exercise" }),
      headers: ctx.headers(),
      body: { scope: "project", enabled: false, expectedRevision: STALE },
    }))
    .json(409, object, "status"),
  http.protected
    .delete("/vsworker/mcp/{name}", "vsworker.mcp.remove")
    .at((ctx) => ({
      path: route("/vsworker/mcp/{name}", { name: "vsworker-exercise" }),
      headers: ctx.headers(),
      body: { scope: "project", expectedRevision: STALE },
    }))
    .json(409, object, "status"),
]
