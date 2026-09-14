export * as VsWorkerRelease from "./release"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Context, Layer } from "effect"

// The channel a VsWorker release is built with. `OPENCODE_CHANNEL=vsworker` at build time puts it in the binary
// and in the desktop sidecar, and it also decides the database filename (opencode-vsworker.db).
export const CHANNEL = "vsworker"

// Upstream's updater is hardcoded to opencode: `npm install -g opencode-ai@…`, the opencode.ai install script,
// and the anomalyco/opencode releases. Running any of those from a VsWorker build would overwrite VsWorker with
// stock opencode, and `uninstall` would remove the official package the user also has installed. So every real
// build of this fork keeps its updater frozen; only source runs and tests (channel "local") behave like upstream,
// which is what keeps the upstream installation suite meaningful.
export function frozen(channel: string) {
  return channel !== "local"
}

export const active = frozen(InstallationChannel)

export const UPGRADE_MESSAGE = "VsWorker builds are replaced by installing a new release, not upgraded in place"

export interface Interface {
  readonly active: boolean
}

export class Service extends Context.Service<Service, Interface>()("@vsworker/Release") {}

export function layer(input: { active?: boolean } = {}) {
  return Layer.succeed(Service, Service.of({ active: input.active ?? active }))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer(),
  deps: [],
})
