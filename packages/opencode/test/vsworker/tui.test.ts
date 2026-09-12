import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { VsWorkerPlugins } from "@vsworker/bundle"
import { tmpdir } from "../fixture/fixture"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { mockTuiRuntime } from "../fixture/tui-runtime"

const { TuiPluginRuntime } = await import("../../src/plugin/tui/runtime")

// preload.ts disables bundled plugins for every other suite; this one is about the bundle itself.
const kill = process.env[VsWorkerPlugins.DISABLE_ENV]
beforeEach(() => {
  delete process.env[VsWorkerPlugins.DISABLE_ENV]
})
afterEach(() => {
  if (kill === undefined) delete process.env[VsWorkerPlugins.DISABLE_ENV]
  else process.env[VsWorkerPlugins.DISABLE_ENV] = kill
})

type StubInput = { id?: string; marker: string; enabled?: boolean }

// A stub bundled TUI plugin whose tui() records that it was activated.
function stub(input: StubInput): VsWorkerPlugins.TuiSelected {
  const id = input.id ?? "bundled-tui"
  return {
    id,
    spec: `opencode-${id}@1.0.0`,
    options: { marker: input.marker },
    enabled: input.enabled ?? true,
    mod: {
      default: {
        id,
        tui: async (_api: unknown, options: Record<string, unknown> | undefined) => {
          if (typeof options?.marker === "string") await Bun.write(options.marker, "called")
        },
      },
    },
  }
}

async function withRuntime(
  dir: string,
  selected: VsWorkerPlugins.TuiSelected[],
  opts: { plugin_enabled?: Record<string, boolean> } = {},
  body: () => Promise<void> | void = () => {},
) {
  const mock = mockTuiRuntime(dir, [], opts)
  const select = spyOn(VsWorkerPlugins, "selectTui").mockReturnValue(selected)
  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config: mock.config })
    await body()
  } finally {
    await TuiPluginRuntime.dispose()
    select.mockRestore()
    mock.restore()
  }
}

test("registers a bundled tui plugin and activates it", async () => {
  await using tmp = await tmpdir()
  const marker = `${tmp.path}/called.txt`

  await withRuntime(tmp.path, [stub({ marker })], {}, async () => {
    const hit = TuiPluginRuntime.list().find((item) => item.id === "bundled-tui")
    expect(hit).toMatchObject({ source: "npm", spec: "opencode-bundled-tui@1.0.0", enabled: true, active: true })
    expect(await Bun.file(marker).text()).toBe("called")
  })
})

test("honours plugin_enabled from tui.json", async () => {
  await using tmp = await tmpdir()
  const marker = `${tmp.path}/called.txt`

  await withRuntime(tmp.path, [stub({ marker })], { plugin_enabled: { "bundled-tui": false } }, async () => {
    const hit = TuiPluginRuntime.list().find((item) => item.id === "bundled-tui")
    expect(hit).toMatchObject({ enabled: false, active: false })
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})

test("registers but does not activate a plugin the bundle marks disabled", async () => {
  await using tmp = await tmpdir()
  const marker = `${tmp.path}/called.txt`

  await withRuntime(tmp.path, [stub({ marker, enabled: false })], {}, async () => {
    const hit = TuiPluginRuntime.list().find((item) => item.id === "bundled-tui")
    expect(hit).toMatchObject({ enabled: false, active: false })
  })
})

test("can be toggled at runtime like any other plugin", async () => {
  await using tmp = await tmpdir()
  const marker = `${tmp.path}/called.txt`

  await withRuntime(tmp.path, [stub({ marker, enabled: false })], {}, async () => {
    await TuiPluginRuntime.activatePlugin("bundled-tui")
    expect(TuiPluginRuntime.list().find((item) => item.id === "bundled-tui")).toMatchObject({ active: true })
    await TuiPluginRuntime.deactivatePlugin("bundled-tui")
    expect(TuiPluginRuntime.list().find((item) => item.id === "bundled-tui")).toMatchObject({ active: false })
  })
})
