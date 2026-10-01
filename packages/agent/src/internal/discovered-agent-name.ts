import { hasRuntimeType } from "./runtime-type.ts"
import { agentDefinitionSourceSymbol } from "./agent-definition-source.ts"

// Discovery names an Agent Definition from its file when the definition has no explicit name.
export const discoveredAgentName: unique symbol = Symbol.for("vitehub.discoveredAgentName")

type DiscoveredAgent = { [discoveredAgentName]?: unknown }

export function markDiscoveredAgentName(agent: unknown, name: string): void {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  Object.defineProperty(agent, discoveredAgentName, { configurable: true, value: name })
  // SAFETY: The object check above permits reading the framework-owned source link.
  const source = (agent as Record<symbol, unknown>)[agentDefinitionSourceSymbol]
  if (source && source !== agent) markDiscoveredAgentName(source, name)
}

export function readDiscoveredAgentName(agent: unknown): string | undefined {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  // SAFETY: The object check above narrows the definition before reading this framework-owned key.
  const name = (agent as DiscoveredAgent)[discoveredAgentName]
  if (hasRuntimeType(name, "string") && name) return name
  // SAFETY: The object check above permits reading the framework-owned source link.
  const source = (agent as Record<symbol, unknown>)[agentDefinitionSourceSymbol]
  return source && source !== agent ? readDiscoveredAgentName(source) : undefined
}
