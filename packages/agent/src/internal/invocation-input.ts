const callerAbortSignals = new WeakMap<object, boolean>()

export function markAgentInvocationCallerAbortSignal(input: object, supplied: boolean): void {
  callerAbortSignals.set(input, supplied)
}

export function agentInvocationCallerAbortSignal(input: object): boolean | undefined {
  return callerAbortSignals.get(input)
}
