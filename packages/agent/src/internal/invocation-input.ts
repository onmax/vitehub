import type { AgentRunInput } from "../types.ts"

// Live signals stay local. Trusted runtimes restore only their caller provenance.
const callerAbortSignals = new WeakMap<object, boolean | undefined>()

export function markAgentInvocationCallerAbortSignal(input: AgentRunInput, supplied: boolean | undefined): void {
  callerAbortSignals.set(input, supplied)
}

export function copyAgentInvocationCallerAbortSignal(source: AgentRunInput, target: AgentRunInput): void {
  if (callerAbortSignals.has(source)) callerAbortSignals.set(target, callerAbortSignals.get(source))
}

export function agentInvocationCallerAbortSignal(input: AgentRunInput): boolean | undefined {
  return callerAbortSignals.has(input) ? callerAbortSignals.get(input) : input.abortSignal !== undefined
}
