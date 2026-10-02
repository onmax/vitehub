import { agentDiagnostics } from "./agent-diagnostics.ts"
import { hostObservability } from "./internal/observability-host.ts"
import type { AgentEvlogExporter } from "./evlog.ts"
import type { AgentEvlogStatus, Observability } from "./internal/observability-types.ts"

export { sanitizeAgentLog } from "./evlog/privacy.ts"

/** Destination for events, exceptions and logs. `vitehub({ observability: { posthog } })` configures PostHog. */
export type ObservabilityExporter = AgentEvlogExporter
export type ObservabilityStatus = AgentEvlogStatus
export type { Observability }

/** Return the host instance configured by `vitehub({ observability })`. */
export function useObservability(): Observability {
  const observability = hostObservability()
  if (!observability) throw agentDiagnostics.AGENT_R0939()
  return observability
}
