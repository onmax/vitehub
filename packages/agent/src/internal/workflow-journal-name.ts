const workflowJournalName: unique symbol = Symbol.for("vitehub.agent.workflowJournalName")

type WorkflowJournalContext = { [workflowJournalName]?: { agent: object, name: string } }

export function setWorkflowJournalName(context: object, agent: object, name: string): void {
  Object.defineProperty(context, workflowJournalName, { enumerable: true, value: { agent, name } })
}

export function readWorkflowJournalName(context: object, agent: object): string | undefined {
  // SAFETY: Only setWorkflowJournalName writes this private context key.
  const journal = (context as WorkflowJournalContext)[workflowJournalName]
  return journal?.agent === agent ? journal.name : undefined
}
