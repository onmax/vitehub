import type { ConnectionActivity, ConnectionSummary } from "@vite-hub/connections"
import * as v from "valibot"
import { ConsoleRequestError } from "./request"

const ruleSchema = v.object({ allow: v.optional(v.array(v.string())), approve: v.optional(v.array(v.string())), deny: v.optional(v.array(v.string())) })
const actorSchema = v.object({ id: v.string(), kind: v.picklist(["agent", "route", "schedule", "service", "user"]) })

export const connectionSummarySchema: v.GenericSchema<unknown, ConnectionSummary> = v.object({
  access: v.object({ agents: v.optional(v.record(v.string(), ruleSchema)), routes: v.optional(v.record(v.string(), ruleSchema)), server: v.optional(ruleSchema) }),
  account: v.optional(v.string()),
  connectedAt: v.optional(v.string()),
  description: v.optional(v.string()),
  expiresAt: v.optional(v.string()),
  header: v.optional(v.string()),
  kind: v.picklist(["api-key", "oauth2"]),
  lastError: v.optional(v.string()),
  name: v.string(),
  origins: v.array(v.string()),
  provider: v.string(),
  scopes: v.array(v.string()),
  status: v.picklist(["active", "disconnected", "error", "needs-reconnect"]),
  updatedAt: v.optional(v.string()),
})

export const connectionActivitySchema: v.GenericSchema<unknown, ConnectionActivity> = v.object({
  action: v.picklist(["call", "connect", "disconnect", "refresh"]),
  actor: actorSchema,
  connection: v.string(),
  durationMs: v.optional(v.number()),
  effect: v.optional(v.picklist(["read", "write"])),
  error: v.optional(v.string()),
  id: v.string(),
  invocationId: v.optional(v.string()),
  operation: v.optional(v.string()),
  outcome: v.picklist(["approval-required", "denied", "failed", "skipped", "succeeded"]),
  runId: v.optional(v.string()),
  status: v.optional(v.number()),
  target: v.optional(v.string()),
  timestamp: v.string(),
  tool: v.optional(v.string()),
  traceId: v.optional(v.string()),
})

export const connectionsListSchema: v.GenericSchema<unknown, { admin: boolean, connections: ConnectionSummary[] }> = v.object({ admin: v.boolean(), connections: v.array(connectionSummarySchema) })
export const connectionResultSchema: v.GenericSchema<unknown, { connection: ConnectionSummary }> = v.object({ connection: connectionSummarySchema })
export const connectionActivityListSchema: v.GenericSchema<unknown, { events: ConnectionActivity[] }> = v.object({ events: v.array(connectionActivitySchema) })
export const connectionStartSchema: v.GenericSchema<unknown, { expiresAt: string, url: string }> = v.object({ expiresAt: v.string(), url: v.string() })

const errorBodySchema = v.object({ message: v.string() })

function fallbackMessage(status: number): string {
  if (status === 401) return "Sign in to manage Connections."
  if (status === 403) return "You do not have access to this operation."
  if (status === 404) return "Connections management is not available in this app."
  return "Could not complete the request. Try again."
}

const locationSchema = v.looseObject({ href: v.string() })

/** URL of the Console page, which resolves a relative management endpoint. */
function pageUrl(): string | undefined {
  const location = v.safeParse(locationSchema, Reflect.get(globalThis, "location"))
  return location.success ? location.output.href : undefined
}

/** The Console sends an API key only over HTTPS or to a loopback host, like `vitehub connections set-key`. */
export function assertSecureKeyEndpoint(url: URL): void {
  const host = url.hostname
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return
  throw new ConsoleRequestError(400, "The Console sends API keys only over HTTPS or on localhost. Open the Console over HTTPS to set a key.")
}

export async function requestConnectionsManagement<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  endpoint: string,
  action: "activity" | "disconnect" | "inspect" | "list" | "refresh" | "set-key" | "start",
  schema: T,
  input: Record<string, unknown> = {},
): Promise<v.InferOutput<T>> {
  const target = action === "set-key" ? new URL(endpoint, pageUrl()) : endpoint
  if (target instanceof URL) assertSecureKeyEndpoint(target)
  const response = await fetch(target, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, action }),
    // A redirect would resend the body. For set-key, the body holds the API key.
    redirect: action === "set-key" ? "error" : "follow",
  })
  if (!response.ok) {
    // Connections errors carry safe messages, for example a missing encryption key.
    const body = v.safeParse(errorBodySchema, await response.json().catch(() => undefined))
    throw new ConsoleRequestError(response.status, body.success && response.status !== 404 ? body.output.message : fallbackMessage(response.status))
  }
  return v.parse(schema, await response.json())
}
