import type { Lock, StateAdapter } from "chat"
import { isRuntimeFunction } from "./runtime-value.ts"

export type AgentStateCacheMutation = { key: string, type: "delete" } | { key: string, type: "set", value: unknown }

/** Cache mutations and the live lease check must commit in one backend transaction. */
export interface AtomicAgentStateLockAdapter extends StateAdapter {
  mutateWithLock(lock: Lock, mutations: readonly AgentStateCacheMutation[]): Promise<boolean>
  /** Colocate cache and locks without changing existing cache keys or storage identity. */
  forCacheLocks?(): AtomicAgentStateLockAdapter
}

export function requireAtomicAgentStateLock(state: StateAdapter): AtomicAgentStateLockAdapter {
  // SAFETY: The State contract may include optional extension methods, checked below before use.
  const candidate = state as Partial<AtomicAgentStateLockAdapter>
  if (!isRuntimeFunction(candidate.mutateWithLock)) {
    throw new Error("[vitehub] Gmail mailbox synchronization requires State with atomic lease-fenced cache mutations (mutateWithLock).")
  }
  // SAFETY: The adapter explicitly implements the atomic mutation contract checked above.
  return candidate as AtomicAgentStateLockAdapter
}
