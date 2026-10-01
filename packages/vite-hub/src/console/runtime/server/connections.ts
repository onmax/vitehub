import { createConnectionsHandler } from "@vite-hub/connections/http"
import { useConnectionsRuntime } from "@vite-hub/connections/server"

import { consoleAuthPath } from "../../auth-path.ts"
import { installConsoleConnectionsScope, resolveConsoleConnections } from "../../internal.ts"
import { getConsoleSections } from "./sections.ts"

import type { ConnectionsAccess } from "@vite-hub/connections/http"
import type { ConnectionsRuntime } from "@vite-hub/connections/server"
import type { ConsoleConnectionsInspection } from "../../internal.ts"

export interface ConsoleConnectionsOptions {
  /**
   * Allows connect, callback, refresh, and disconnect. Console access alone only allows reads.
   * `console: true` in development and `console: { manageConnections: true }` set it.
   */
  manage?: boolean
  /** Vite application base used for Console routes. */
  baseURL?: string
  runtime?: () => ConnectionsRuntime
}

export function consoleConnectionsReturnTo(name: string, outcome: "connected" | "failed", baseURL = "/"): string {
  return `${consoleAuthPath(baseURL, "/_vitehub/connections")}?connection=${encodeURIComponent(name)}&result=${outcome}`
}

/** Mounts the Connections management, connect, and callback routes for the Console. */
export function installConsoleConnections(projectRoot: string, options: ConsoleConnectionsOptions = {}): ConsoleConnectionsInspection {
  const basePath = consoleAuthPath(options.baseURL ?? "/", "/_vitehub/connections")
  const runtime = options.runtime ?? useConnectionsRuntime
  // Console Auth guards /_vitehub/** before these routes run. Console server code has no per-user identity, so the actor is the Console.
  const access: ConnectionsAccess = { actor: { id: "console", kind: "user" }, admin: options.manage === true }
  return installConsoleConnectionsScope(projectRoot, {
    handle: (request, event) =>
      createConnectionsHandler({ authenticate: () => access, basePath, returnTo: (name, outcome) => consoleConnectionsReturnTo(name, outcome, options.baseURL), runtime: runtime() })(request, event),
  })
}

export async function handleConsoleConnections(request: Request, event?: unknown): Promise<Response> {
  const handle = getConsoleSections().includes("connections") ? resolveConsoleConnections()?.handle : undefined
  if (!handle) return Response.json({ message: "Connections management is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } })
  return handle(request, event)
}
