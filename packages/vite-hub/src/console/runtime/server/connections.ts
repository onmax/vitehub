import { createConnectionsHandler } from "@vite-hub/connections/http"
import { useConnectionsRuntime } from "@vite-hub/connections/server"

import { installConsoleConnectionsScope, resolveConsoleConnections } from "../../internal.ts"
import { getConsoleSections } from "./sections.ts"

import type { ConnectionsAccess } from "@vite-hub/connections/http"
import type { ConnectionsRuntime } from "@vite-hub/connections/server"
import type { ConsoleConnectionsInspection } from "../../internal.ts"

// Console Auth guards /_vitehub/** before these routes run. Console server code has no per-user identity, so the actor is the Console.
const consoleAccess: ConnectionsAccess = { actor: { id: "console", kind: "user" }, admin: true }

export function consoleConnectionsReturnTo(name: string, outcome: "connected" | "failed"): string {
  return `/_vitehub/connections?connection=${encodeURIComponent(name)}&result=${outcome}`
}

/** Mounts the Connections management, connect, and callback routes for the Console. */
export function installConsoleConnections(projectRoot: string, runtime: () => ConnectionsRuntime = useConnectionsRuntime): ConsoleConnectionsInspection {
  return installConsoleConnectionsScope(projectRoot, {
    handle: (request, event) =>
      createConnectionsHandler({ authenticate: () => consoleAccess, returnTo: consoleConnectionsReturnTo, runtime: runtime() })(request, event),
  })
}

export async function handleConsoleConnections(request: Request, event?: unknown): Promise<Response> {
  const handle = getConsoleSections().includes("connections") ? resolveConsoleConnections()?.handle : undefined
  if (!handle) return Response.json({ message: "Connections management is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } })
  return handle(request, event)
}
