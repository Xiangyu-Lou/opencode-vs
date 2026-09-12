export * as VsWorkerPluginsService from "./service"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Layer } from "effect"
import { prepare, type Entry } from "./bundle"
import { server } from "./server.gen"
import { tui } from "./tui.gen"

export interface Interface {
  readonly server: readonly Entry[]
  readonly tui: readonly Entry[]
}

export class Service extends Context.Service<Service, Interface>()("@vsworker/Plugins") {}

export function layer(bundle: Partial<Interface> = {}) {
  return Layer.succeed(Service, Service.of({ server: bundle.server ?? [], tui: bundle.tui ?? [] }))
}

// The bundle is a build-time constant, so it is normalized once here rather than on every instance.
// Exported directly as well because the TUI plugin host runs outside the Effect layer graph.
export const bundle: Interface = { server: prepare(server), tui: prepare(tui) }

export const node = LayerNode.make({
  service: Service,
  layer: layer(bundle),
  deps: [],
})
