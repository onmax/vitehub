import { hasRuntimeType } from "./runtime-type.ts"

// Discovery names an Agent Definition from its file when the definition has no explicit name.
export const discoveredAgentName: unique symbol = Symbol.for("vitehub.discoveredAgentName")

type DiscoveredAgent = { [discoveredAgentName]?: unknown }

export function markDiscoveredAgentName(agent: unknown, name: string): void {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  Object.defineProperty(agent, discoveredAgentName, { configurable: true, value: name })
}

export function readDiscoveredAgentName(agent: unknown): string | undefined {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  // SAFETY: The object check above narrows the definition before reading this framework-owned key.
  const name = (agent as DiscoveredAgent)[discoveredAgentName]
  return hasRuntimeType(name, "string") && name ? name : undefined
}
