import path from "path"
import os from "os"
import fs from "fs/promises"
import { afterAll } from "bun:test"

// src/skills.ts imports @opencode-ai/core/global, which creates the XDG directories and arms the lock root as a
// side effect of being imported. Point all four somewhere disposable before that happens, so running these tests
// never touches the developer's real opencode state.
const dir = path.join(os.tmpdir(), `vsworker-test-${process.pid}`)
process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")

export const TEST_HOME = dir

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
