import { Diagnostic } from "nostics"
import { agentDiagnostics } from "../agent-diagnostics.ts"

/**
 * Agent Driver that runs a journaled Invocation, and whether ViteHub can stop it.
 *
 * `enforced` is `true` when the Driver stops its work when the Invocation abort
 * signal aborts. A custom `run` Driver receives the signal, but ViteHub cannot
 * stop the handler.
 */
export interface AgentInvocationCancellationDriver {
  enforced: boolean
  name: string
}

interface AgentInvocationCancellationHandle {
  abort: (reason: unknown) => void
  driver?: () => AgentInvocationCancellationDriver | undefined
}

export interface LocalAgentInvocationCancellation {
  aborted: boolean
  notEnforcedBy?: string
}

const cancellationHandlesKey = Symbol.for("vitehub.agentInvocationCancellations")

export const agentInvocationCancellationCode = "AGENT_R0970"

function handles(owner: object): Map<string, Set<AgentInvocationCancellationHandle>> {
  const root = globalThis as typeof globalThis & Record<symbol, unknown>
  const existing = root[cancellationHandlesKey]
  const owners = existing instanceof WeakMap ? existing as WeakMap<object, Map<string, Set<AgentInvocationCancellationHandle>>> : new WeakMap<object, Map<string, Set<AgentInvocationCancellationHandle>>>()
  root[cancellationHandlesKey] = owners
  let registry = owners.get(owner)
  if (!registry) {
    registry = new Map<string, Set<AgentInvocationCancellationHandle>>()
    owners.set(owner, registry)
  }
  return registry
}

/**
 * Registers the abort handle of a running journaled Invocation in this process.
 * The registry lives on `globalThis`, so separate module instances in one process share it.
 */
export function registerAgentInvocationCancellation(owner: object, id: string, handle: AgentInvocationCancellationHandle): () => void {
  const registry = handles(owner)
  const entries = registry.get(id) ?? new Set<AgentInvocationCancellationHandle>()
  entries.add(handle)
  registry.set(id, entries)
  return () => {
    const current = registry.get(id)
    if (!current) return
    current.delete(handle)
    if (current.size === 0) registry.delete(id)
  }
}

/** Aborts every run in this process that holds the journaled Invocation. */
export function abortLocalAgentInvocation(owner: object, id: string, reason: unknown): LocalAgentInvocationCancellation {
  const entries = [...handles(owner).get(id) ?? []]
  for (const entry of entries) entry.abort(reason)
  const notEnforcedBy = entries.map(entry => entry.driver?.()).find(driver => driver && !driver.enforced)?.name
  return { aborted: entries.length > 0, ...(notEnforcedBy ? { notEnforcedBy } : {}) }
}

export function agentInvocationCancellationDriver(driver: { kind: "model" | "provider" | "run", provider?: string }): AgentInvocationCancellationDriver {
  if (driver.kind === "provider") return { enforced: true, name: driver.provider || "provider" }
  if (driver.kind === "run") return { enforced: false, name: "run" }
  return { enforced: true, name: "model" }
}

export function createAgentInvocationCancellationError(id: string): Error {
  return agentDiagnostics.AGENT_R0970({ message: `[vitehub] Cancellation was requested for Agent Invocation ${JSON.stringify(id)}.` })
}

/** True when the error or one of its causes is the cancellation request reason. */
export function isAgentInvocationCancellationError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Diagnostic && current.code === agentInvocationCancellationCode) return true
    current = current.cause
  }
  return false
}
