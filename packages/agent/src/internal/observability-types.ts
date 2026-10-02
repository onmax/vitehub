import type { PapercutReporterStatus } from "../papercut-reporter.ts"
import type { AgentCapabilityDefinition } from "../types.ts"

// These types must not reference `evlog`. `@vite-hub/agent/server/internal`
// declares them, and its declarations must load without the optional peer.

export interface AgentEvlogStatus {
  /** An exporter is configured. Without one, events reach only local evlog output. */
  configured: boolean
  accepted: number
  failed: number
  dropped: number
  pending: number
  closed: boolean
  /** Papercut delivery, when enabled. */
  papercuts?: PapercutReporterStatus
}

export interface Observability {
  /** Record a best-effort event. It is dropped when the queue is full or closed. */
  event(name: string, properties?: Record<string, unknown>): void
  /** Deliver an event and wait for the exporter to acknowledge it. Rejects without an exporter. */
  capture(event: string, properties: Record<string, unknown>, delivery?: { uuid?: string, timestamp?: Date }): Promise<void>
  /** Record a sanitized exception. Unknown error messages are replaced with generic text. */
  exception(error: unknown, properties?: Record<string, unknown>): void
  /** Agent lifecycle telemetry and papercut reports. ViteHub adds it to every Agent. */
  capability: AgentCapabilityDefinition
  status(): AgentEvlogStatus
  /** Stop accepting events and drain the exporter. Nitro calls it on shutdown. */
  flush(): Promise<void>
}
