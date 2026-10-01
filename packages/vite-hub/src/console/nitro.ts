import { join } from "node:path"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

export function addConsoleRpcHandler(nitro: { handlers?: Array<{ handler: string; route: string }> }, consoleRuntimeRoot: string, options: { connections?: boolean } = {}): void {
  const route = "/_vitehub/rpc/**"
  const handler = join(consoleRuntimeRoot, "server/rpc.js")
  const kit = createNitroServerKit(nitro)
  // SAFETY: Console registration supplies Nitro handlers with the declared string fields.
  const handlers = kit.config.handlers as Array<{ handler: string; route: string }>
  const conflict = handlers.find(candidate => candidate.route === route && candidate.handler !== handler)
  if (conflict) throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Console handler at "${route}" because that route already uses "${conflict.handler}".` })
  kit.addHandler({ handler, route })
  const managementRoute = "/_vitehub/env/manage"
  const managementHandler = join(consoleRuntimeRoot, "server/env-manage.js")
  const managementConflict = handlers.find(candidate => candidate.route === managementRoute && candidate.handler !== managementHandler)
  if (managementConflict) throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Env handler at "${managementRoute}" because that route is already registered.` })
  kit.addHandler({ handler: managementHandler, method: "post", route: managementRoute })
  if (options.connections) {
    // Register only the Connections routes, so /_vitehub/connections still serves the Console page.
    const connectionsHandler = join(consoleRuntimeRoot, "server/connections-route.js")
    for (const [method, connectionsRoute] of [
      ["post", "/_vitehub/connections/manage"],
      ["get", "/_vitehub/connections/:name/connect"],
      ["get", "/_vitehub/connections/:name/callback"],
    ] as const) {
      const connectionsConflict = handlers.find(candidate => candidate.route === connectionsRoute && candidate.handler !== connectionsHandler)
      if (connectionsConflict) throw viteHubErrorDiagnostics.VITE_HUB_R0040({ message: `Cannot mount the ViteHub Connections handler at "${connectionsRoute}" because that route is already registered.` })
      kit.addHandler({ handler: connectionsHandler, method, route: connectionsRoute })
    }
  }
  // SAFETY: The kit preserves the caller's Nitro handler array while adding the Console route.
  nitro.handlers = kit.config.handlers as Array<{ handler: string; route: string }>
}
