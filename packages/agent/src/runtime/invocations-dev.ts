import agentRegistry from "#vitehub/agent/registry"
import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { getAgentFromRegistry } from "../index.ts"
import { agentInvocationsDevGuard } from "../invocations-dev.ts"
import { isAgentInvocations } from "../invocations.ts"

import type { AgentInvocationsDevRequestBody } from "../invocations-dev.ts"
import type { AgentInvocationCancelResult, AgentInvocations } from "../invocations.ts"

function failure(message: string, status: number): Response {
  return Response.json({ error: { message: redactInspectionText(message) } }, { status })
}

async function readBody(request: Request): Promise<AgentInvocationsDevRequestBody | undefined> {
  const value: unknown = await request.json().catch(() => undefined)
  if (typeof value !== "object" || value === null) return
  const operation: unknown = Reflect.get(value, "operation")
  const id: unknown = Reflect.get(value, "id")
  if (operation !== "cancel" || typeof id !== "string" || !id.trim()) return
  return { id: id.trim(), operation }
}

/**
 * Collects the Invocation journals of the Agent Definitions in the application registry. The registry is the same
 * module graph that runs the application's Agents, so the journals and the in-process abort handles are the same
 * objects that the running Invocations use.
 */
async function registeredInvocationJournals(): Promise<AgentInvocations[]> {
  const journals = new Set<AgentInvocations>()
  for (const name of Object.keys(agentRegistry)) {
    try {
      const journal: unknown = (await getAgentFromRegistry(name)).invocations
      if (isAgentInvocations(journal)) journals.add(journal)
    }
    catch {
      // An Agent Definition that cannot load has no Invocation to cancel.
    }
  }
  return [...journals]
}

async function cancelInJournals(journals: readonly AgentInvocations[], id: string): Promise<AgentInvocationCancelResult> {
  let result: AgentInvocationCancelResult = { id, outcome: "not-found" }
  for (const journal of journals) {
    result = await journal.cancel(id)
    if (result.outcome !== "not-found") return result
  }
  return result
}

/**
 * Handles `vitehub agent invocations cancel` inside the Nitro dev runtime.
 *
 * The Vite endpoint forwards the request here, so the cancel reaches the application's own journals and abort
 * registry. The handler exists only in `vite dev`.
 */
export async function handleAgentInvocationsDevRequest(request: Request): Promise<Response> {
  const rejection = validateViteHubNitroDevRequest(request, agentInvocationsDevGuard)
  if (rejection) return rejection
  const body = await readBody(request)
  if (!body) return failure("The Agent Invocations Dev request body is invalid.", 400)
  try {
    const journals = await registeredInvocationJournals()
    if (!journals.length) return failure("No Agent invocation journal is configured.", 404)
    return Response.json(await cancelInJournals(journals, body.id))
  }
  catch (error) {
    return failure(`Agent Invocation cancel failed: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}
