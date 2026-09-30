const parsedInputs = new WeakMap<object, object>()

export function markParsedAgentWorkflowInput(input: object, agent: object): void {
  parsedInputs.set(input, agent)
}

export function consumeParsedAgentWorkflowInput(input: object, agent: object | undefined): boolean {
  const parsedAgent = parsedInputs.get(input)
  parsedInputs.delete(input)
  return agent !== undefined && parsedAgent === agent
}
