import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" || arg === "vsworker" ? arg : resolveChannel()

// VsWorker ships the same artwork as a release build; only the name and the bundle id differ.
const src = `./icons/${channel === "vsworker" ? "prod" : channel}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${channel} icons from ${src} to ${dest}`)
