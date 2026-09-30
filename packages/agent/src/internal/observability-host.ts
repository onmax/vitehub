import type { AgentEvlogStatus } from "../evlog.ts"
import type { Observability } from "../observability.ts"

const observabilityKey = Symbol.for("vitehub.observability")

type ObservabilityScope = typeof globalThis & { [observabilityKey]?: Observability }

// SAFETY: The slot is a well-known global symbol that only setHostObservability() writes.
const scope = globalThis as ObservabilityScope

/** The instance installed by `vitehub({ observability })`. Every Agent receives its Capability. */
export function hostObservability(): Observability | undefined {
  return scope[observabilityKey]
}

export function setHostObservability(value: Observability | undefined): void {
  if (value) scope[observabilityKey] = value
  else delete scope[observabilityKey]
}

/** Status for the Console. `null` means `vitehub({ observability })` is not set. */
export function observabilityStatus(): AgentEvlogStatus | null {
  return hostObservability()?.status() ?? null
}
