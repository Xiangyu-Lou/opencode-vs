import { app } from "electron"

type Channel = "dev" | "beta" | "prod" | "vsworker"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" || raw === "vsworker" ? raw : "dev"

// Only the two channels with a publish target can update themselves. VsWorker releases are handed out by hand and
// are not signed by a Developer ID, which electron-updater requires on macOS.
export const UPDATER_ENABLED = app.isPackaged && (CHANNEL === "beta" || CHANNEL === "prod")
